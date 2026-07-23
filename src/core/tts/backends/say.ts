/**
 * @module @core/tts/backends/say
 *
 * SayTtsBackend — macOS `say` subprocess (zero-network fallback, C6 free
 * toolchain). Design choice: `say -o` emits AIFF; the locked segment naming
 * is `seg-NN.mp3`, so the backend converts AIFF → mp3 via ffmpeg (already a
 * hard project prerequisite — no new dependency). Simplest reliable path.
 *
 * THIN external-call adapter — excluded from the coverage denominator
 * (bunfig coveragePathIgnorePatterns: `src/core/tts/backends/**`).
 *
 * Any failure surfaces as TTSBackendError carrying argv + stderr context in
 * the message (BR-U2-7-adjacent subprocess discipline; `say` is local, so
 * network/rate-limit classes never apply here).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "@adapters/ffmpeg";
import { DEFAULT_TTS_VOICES } from "@core/config";
import { FfmpegError, TTSBackendError } from "@core/errors";

import type { AudioFile, TtsBackend, VoiceOpts } from "../types";

/** `say` synthesis budget (long segments still finish well within this). */
const SAY_TIMEOUT_SEC = 120;
/** AIFF → mp3 transcode budget. */
const CONVERT_TIMEOUT_SEC = 60;

/** Constructor options (config-injected executable override). */
export interface SayTtsBackendOptions {
  /** ffmpeg executable for the AIFF→mp3 conversion. Default: "ffmpeg". */
  ffmpegPath?: string;
}

export class SayTtsBackend implements TtsBackend {
  readonly id = "say";
  readonly defaultVoice = DEFAULT_TTS_VOICES.say;
  private readonly ffmpegPath: string;

  constructor(options: SayTtsBackendOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  }

  async synthesize(text: string, voice: VoiceOpts): Promise<AudioFile> {
    const ctx = { backend: this.id, segmentIndex: voice.segmentIndex ?? -1 };
    if (text.trim().length === 0) {
      throw new TTSBackendError("TTS 输入文本为空", ctx);
    }
    if (voice.name.trim().length === 0) {
      throw new TTSBackendError("voice 名不能为空", ctx);
    }
    if (Bun.which("say") === null) {
      throw new TTSBackendError(
        "say 命令不可用（SayTtsBackend 仅支持 macOS）",
        ctx,
      );
    }

    const dir = mkdtempSync(join(tmpdir(), "mva-say-"));
    const aiffPath = join(dir, "tts.aiff");
    const mp3Path = join(dir, "tts.mp3");

    // 1. say → AIFF (argv array, no shell; `--` guards dash-leading text)
    const sayArgv = ["say", "-v", voice.name, "-o", aiffPath, "--", text];
    const result = await runSubprocess(sayArgv, SAY_TIMEOUT_SEC);
    if (result.timedOut || result.exitCode !== 0) {
      throw new TTSBackendError(
        `say 失败（exit=${result.exitCode}${result.timedOut ? ", timeout 已 kill" : ""}）: ` +
          `argv=${sayArgv.join(" ")}; stderr尾=${result.stderr}`,
        ctx,
      );
    }

    // 2. AIFF → mp3 (locked seg-NN.mp3 naming; ffmpeg is a prerequisite)
    const convertArgv = [
      this.ffmpegPath,
      "-y",
      "-v",
      "error",
      "-i",
      aiffPath,
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      mp3Path,
    ];
    try {
      await runFfmpeg(convertArgv, { timeoutSec: CONVERT_TIMEOUT_SEC });
    } catch (err) {
      if (err instanceof FfmpegError) {
        throw new TTSBackendError(
          `say 后端转码失败: ${err.message}; argv=${err.argv.join(" ")}; ` +
            `stderr尾=${err.stderr}`,
          { ...ctx, cause: err },
        );
      }
      throw err;
    } finally {
      rmSync(aiffPath, { force: true });
    }

    return { path: mp3Path, durationSec: 0 }; // measured later (BR-U2-3)
  }
}

/** Minimal argv-array runner for `say` (stderr captured, timeout killed). */
async function runSubprocess(
  argv: string[],
  timeoutSec: number,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn({
    cmd: argv,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutSec * 1000);
  try {
    const stderr = await new Response(
      proc.stderr as ReadableStream<Uint8Array>,
    ).text();
    const exitCode = await proc.exited;
    return { exitCode, stderr: stderr.slice(-4096), timedOut };
  } finally {
    clearTimeout(killTimer);
  }
}
