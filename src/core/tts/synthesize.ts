/**
 * @module @core/tts (synthesize)
 *
 * Synthesis orchestration: synthesizeScript (per-segment, idempotent,
 * network-only retry), mergeAudio (normalize → concat → duration
 * assertion → prefix-sum offsets) and clearAudio (the explicit escape hatch
 * from the idempotence rule, used when the voice itself changes).
 *
 * Boundary rules honored here:
 * - BR-U2-1: ONLY TTSNetworkError is retryable, ≤3 retries with exponential
 *   backoff 500ms/1s/2s + jitter; every other TTS error throws immediately.
 * - BR-U2-2: an existing seg-NN.mp3 is never re-synthesized (FR-2 AC-2).
 * - BR-U2-3: durations.json values come from ffprobe measurement only.
 * - BR-U2-4: every segment is normalized to the locked AudioSpec
 *   (aac 48kHz stereo) BEFORE concat.
 * - BR-U2-5: merged duration must equal Σ segments ±1s, else ValidationError.
 *
 * probe/run/sleep/jitter are injectable so unit tests stay fully offline
 * (the defaults are the real implementations).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildConcatArgs,
  buildNormalizeArgs,
  FFMPEG_TIMEOUTS,
  probe as probeMedia,
  runFfmpeg,
  type MediaInfo,
  type RunOptions,
} from "@adapters/ffmpeg";
import { IoError, TTSNetworkError, ValidationError } from "@core/errors";
import type { VideoDir } from "@core/workdir";

import {
  DURATIONS_FILE,
  MERGED_FILE,
  segmentFileName,
  type AudioFile,
  type AudioTrack,
  type DurationsJson,
  type SegmentAudio,
  type TtsBackend,
  type TtsScript,
  type VoiceOpts,
} from "./types";

/** Locked retry backoff schedule (BR-U2-1): 3 retries, then throw. */
export const RETRY_BACKOFF_MS = [500, 1000, 2000] as const;

/** Max additive jitter per backoff step. */
export const JITTER_MAX_MS = 250;

/** Merged-duration assertion tolerance in seconds (BR-U2-5, FR-2 AC-1). */
export const MERGE_TOLERANCE_SEC = 1;

/** Injectable seams for {@link synthesizeScript} (offline unit tests). */
export interface SynthesizeScriptOptions {
  /** Voice name. Default: backend.defaultVoice. */
  voice?: string;
  /** Duration prober. Default: real ffprobe-backed {@link probeMedia}. */
  probeFn?: (path: string) => Promise<MediaInfo>;
  /** Backoff sleeper. Default: Bun.sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1). Default: Math.random. */
  jitterFn?: () => number;
}

/**
 * Workflow 1 — per-segment synthesis, idempotent:
 * 1. `audio/seg-NN.mp3` exists → skip (BR-U2-2).
 * 2. backend.synthesize with the network-only retry policy (BR-U2-1).
 * 3. Move the backend's temp file into place (copy → `.tmp` → atomic rename).
 * 4. ffprobe-measure every segment → `audio/durations.json` (BR-U2-3).
 * 5. Return SegmentAudio[] with measured durations.
 *
 * @throws ValidationError on empty segments (defensive; U3 validates first).
 * @throws TtsError subclasses passed through from the backend.
 * @throws IoError on file placement or durations.json write failure.
 */
export async function synthesizeScript(
  script: TtsScript,
  backend: TtsBackend,
  dir: VideoDir,
  options: SynthesizeScriptOptions = {},
): Promise<SegmentAudio[]> {
  const {
    voice = backend.defaultVoice,
    probeFn = probeMedia,
    sleepFn = (ms: number) => Bun.sleep(ms),
    jitterFn = Math.random,
  } = options;

  if (script.segments.length === 0) {
    throw new ValidationError(
      "script.segments 为空（调用方应先经 U3 validateScript；U2 防御性断言）",
    );
  }

  mkdirSync(dir.paths.audio, { recursive: true });

  const finalPaths: string[] = [];
  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i]!;
    const finalPath = join(dir.paths.audio, segmentFileName(i));
    finalPaths.push(finalPath);

    if (existsSync(finalPath)) continue; // BR-U2-2: never re-synthesize

    const produced = await synthesizeWithRetry(
      backend,
      segment.text,
      { name: voice, segmentIndex: i },
      sleepFn,
      jitterFn,
    );

    // copy (backend temp may live on another volume) then atomic rename
    const tmpPath = `${finalPath}.tmp`;
    try {
      copyFileSync(produced.path, tmpPath);
      renameSync(tmpPath, finalPath);
      rmSync(produced.path, { force: true });
    } catch (cause) {
      throw new IoError(`分段音频写入失败: ${finalPath}`, { cause });
    }
  }

  // ffprobe-measured durations only (BR-U2-3, Q3=A)
  const perSegment: number[] = [];
  for (const path of finalPaths) {
    perSegment.push((await probeFn(path)).durationSec);
  }
  const total = perSegment.reduce((sum, d) => sum + d, 0);
  await writeDurations(dir, { perSegment, total });

  return finalPaths.map((path, index) => ({
    index,
    audio: { path, durationSec: perSegment[index]! },
  }));
}

/** BR-U2-1 retry loop: network errors only, ≤3 backoffs, then rethrow. */
async function synthesizeWithRetry(
  backend: TtsBackend,
  text: string,
  voiceOpts: VoiceOpts,
  sleepFn: (ms: number) => Promise<void>,
  jitterFn: () => number,
): Promise<AudioFile> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await backend.synthesize(text, voiceOpts);
    } catch (err) {
      const retryable =
        err instanceof TTSNetworkError && attempt < RETRY_BACKOFF_MS.length;
      if (!retryable) throw err;
      await sleepFn(
        RETRY_BACKOFF_MS[attempt]! + Math.floor(jitterFn() * JITTER_MAX_MS),
      );
    }
  }
}

/** Injectable seams for {@link mergeAudio} (offline unit tests). */
export interface MergeAudioOptions {
  /** Duration prober. Default: real ffprobe-backed {@link probeMedia}. */
  probeFn?: (path: string) => Promise<MediaInfo>;
  /** ffmpeg executor. Default: real {@link runFfmpeg}. */
  runFn?: (argv: string[], options: RunOptions) => Promise<void>;
}

/**
 * Workflow 2 — normalize → concat → assert → offsets:
 * 1. Transcode every segment to the locked AudioSpec (`.norm.m4a` temps).
 * 2. Concat the normalized files into `audio/merged.m4a` (pure argv).
 * 3. Assert merged duration = Σ segment durations ±1s (BR-U2-5).
 * 4. Compute prefix-sum segmentOffsets, update durations.json.
 * 5. Clean up `.norm.m4a` temps (also on failure).
 *
 * @throws ValidationError on empty/non-contiguous segments or the duration
 *         assertion (FR-2 AC-1).
 * @throws FfmpegError from the executor.
 */
export async function mergeAudio(
  segments: SegmentAudio[],
  dir: VideoDir,
  options: MergeAudioOptions = {},
): Promise<AudioTrack> {
  const { probeFn = probeMedia, runFn = runFfmpeg } = options;

  if (segments.length === 0) {
    throw new ValidationError("mergeAudio: segments 为空");
  }
  // Invariant 1: seg-NN.mp3 must map 1:1 onto segments, contiguous from 0.
  const sorted = [...segments].sort((a, b) => a.index - b.index);
  for (const [i, seg] of sorted.entries()) {
    if (seg.index !== i) {
      throw new ValidationError(
        `分段索引不连续: 期望 ${i}，得到 ${seg.index}（seg-NN.mp3 必须一一对应无洞）`,
      );
    }
  }

  const normFiles: string[] = [];
  try {
    // 1. per-segment normalization to aac 48kHz stereo (BR-U2-4, Q2=A)
    for (const seg of sorted) {
      const normPath = join(
        dir.paths.audio,
        `seg-${String(seg.index).padStart(2, "0")}.norm.m4a`,
      );
      await runFn(buildNormalizeArgs(seg.audio.path, normPath), {
        timeoutSec: FFMPEG_TIMEOUTS.concatSec,
      });
      normFiles.push(normPath);
    }

    // 2. concat (pure argv → executor)
    const mergedPath = join(dir.paths.audio, MERGED_FILE);
    await runFn(buildConcatArgs(normFiles, mergedPath), {
      timeoutSec: FFMPEG_TIMEOUTS.concatSec,
    });

    // 3. duration assertion (BR-U2-5, FR-2 AC-1)
    const info = await probeFn(mergedPath);
    const perSegment = sorted.map((seg) => seg.audio.durationSec);
    const expected = perSegment.reduce((sum, d) => sum + d, 0);
    if (Math.abs(info.durationSec - expected) > MERGE_TOLERANCE_SEC) {
      throw new ValidationError(
        `合并音轨时长断言失败: merged=${info.durationSec}s, Σ分段=${expected}s，` +
          `偏差超过 ±${MERGE_TOLERANCE_SEC}s（FR-2 AC-1）`,
      );
    }

    // 4. prefix-sum offsets (U4 card-switch timing source)
    const segmentOffsets: number[] = [];
    let acc = 0;
    for (const d of perSegment) {
      segmentOffsets.push(acc);
      acc += d;
    }
    await writeDurations(dir, {
      perSegment,
      total: acc,
      segmentOffsets,
    });

    return {
      path: mergedPath,
      durationSec: info.durationSec,
      segmentOffsets,
    };
  } finally {
    // 5. cleanup normalization temps, also on the failure path
    for (const file of normFiles) rmSync(file, { force: true });
  }
}

/** Absolute path of `audio/durations.json` for a video dir. */
export function durationsPath(dir: VideoDir): string {
  return join(dir.paths.audio, DURATIONS_FILE);
}

/**
 * Discards every audio artifact of a video (`audio/` 下的分段、合并音轨、
 * durations.json、归一化残留），returning the removed file names.
 *
 * 存在的理由是 BR-U2-2：已存在的 `seg-NN.mp3` 永不重合成。换后端或换音色时，
 * 这条不变式会让"重跑"变成一次静默的空转——用户以为换了音色，实际拿到的还是
 * 旧音频。所以"换声音"必须是一次显式的清空（`tts run --fresh`），而不是靠
 * 猜测去判断某个已存在的文件是不是该被覆盖。
 */
export function clearAudio(dir: VideoDir): string[] {
  if (!existsSync(dir.paths.audio)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir.paths.audio)) {
    if (
      !/^seg-.+\.(mp3|m4a)$/.test(name) &&
      name !== MERGED_FILE &&
      name !== DURATIONS_FILE &&
      !name.endsWith(".tmp")
    ) {
      continue;
    }
    rmSync(join(dir.paths.audio, name), { force: true });
    removed.push(name);
  }
  return removed.sort();
}

/** Reads durations.json if present and parseable (undefined otherwise). */
export async function readDurations(
  dir: VideoDir,
): Promise<DurationsJson | undefined> {
  try {
    return JSON.parse(
      await readFile(durationsPath(dir), "utf8"),
    ) as DurationsJson;
  } catch {
    return undefined;
  }
}

/** Atomic durations.json write (`.tmp` → rename, ADR-004 discipline). */
async function writeDurations(
  dir: VideoDir,
  data: DurationsJson,
): Promise<void> {
  const target = durationsPath(dir);
  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  } catch (cause) {
    throw new IoError(`durations.json 写入失败: ${target}`, { cause });
  }
}
