/**
 * @module @core/tts/backends/edge
 *
 * EdgeTtsBackend — wraps the `msedge-tts` npm package (exact-pinned 2.0.7,
 * BR-U2-9 supply-chain discipline; wrapper fully isolates the dependency so
 * it stays replaceable).
 *
 * THIN external-call adapter — excluded from the coverage denominator
 * (bunfig coveragePathIgnorePatterns: `src/core/tts/backends/**`).
 *
 * Error classification (FR-2.1):
 * - network / socket / timeout signals → TTSNetworkError (retryable)
 * - rate-limit signals (429/throttle)  → TTSRateLimitError
 * - empty or undecodable audio         → TTSMalformedOutputError
 * - everything else                    → TTSBackendError
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

import { DEFAULT_TTS_VOICES } from "@core/config";
import {
  TTSBackendError,
  TTSMalformedOutputError,
  TTSNetworkError,
  TTSRateLimitError,
  TtsError,
} from "@core/errors";

import type { AudioFile, TtsBackend, VoiceOpts } from "../types";

/** WebSocket connect + metadata handshake budget. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Full single-segment synthesis budget. */
const SYNTH_TIMEOUT_MS = 60_000;

export class EdgeTtsBackend implements TtsBackend {
  readonly id = "edge";
  readonly defaultVoice = DEFAULT_TTS_VOICES.edge;

  async synthesize(text: string, voice: VoiceOpts): Promise<AudioFile> {
    const ctx = { backend: this.id, segmentIndex: voice.segmentIndex ?? -1 };
    if (text.trim().length === 0) {
      throw new TTSBackendError("TTS 输入文本为空", ctx);
    }
    if (voice.name.trim().length === 0) {
      // Deep voice-table validation is delegated to the service response;
      // an unknown voice surfaces as a classified backend failure.
      throw new TTSBackendError("voice 名不能为空", ctx);
    }

    const tts = new MsEdgeTTS();
    try {
      await withTimeout(
        tts.setMetadata(
          voice.name,
          OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
        ),
        CONNECT_TIMEOUT_MS,
        "edge-tts 连接/元数据握手超时",
      );
      const { audioStream } = tts.toStream(text);
      const audio = await withTimeout(
        collect(audioStream),
        SYNTH_TIMEOUT_MS,
        "edge-tts 合成超时",
      );
      if (audio.byteLength === 0) {
        throw new TTSMalformedOutputError("edge-tts 返回空音频", ctx);
      }
      // mp3 natively (no transcode); orchestrator moves it into place.
      const dir = mkdtempSync(join(tmpdir(), "mva-edge-"));
      const outPath = join(dir, "tts.mp3");
      writeFileSync(outPath, audio);
      return { path: outPath, durationSec: 0 }; // measured later (BR-U2-3)
    } catch (err) {
      throw classifyEdgeError(err, ctx);
    } finally {
      try {
        tts.close();
      } catch {
        // the socket may never have opened; closing is best-effort
      }
    }
  }
}

/** Maps arbitrary failures onto the FR-2.1 four-error taxonomy. */
function classifyEdgeError(
  err: unknown,
  ctx: { backend: string; segmentIndex: number },
): TtsError {
  if (err instanceof TtsError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/(429|rate ?limit|throttl|too many requests)/i.test(message)) {
    return new TTSRateLimitError(`edge-tts 限流: ${message}`, {
      ...ctx,
      cause: err,
    });
  }
  if (
    /(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket|websocket|network|timed? ?out|timeout|超时|hang ?up|closed)/i.test(
      message,
    )
  ) {
    return new TTSNetworkError(`edge-tts 网络失败: ${message}`, {
      ...ctx,
      cause: err,
    });
  }
  return new TTSBackendError(`edge-tts 后端失败: ${message}`, {
    ...ctx,
    cause: err,
  });
}

/** Collects a Node Readable audio stream into one Buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Rejects with a timeout-flavored Error (classified as network → retryable). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  note: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${note}（${ms}ms 上限, timeout）`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
