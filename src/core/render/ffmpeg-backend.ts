/**
 * @module @core/render (ffmpeg-backend)
 *
 * FfmpegComposeBackend — the P1 implementation of the {@link RenderBackend}
 * port (Workflow 4): concat list write → buildComposeArgs → runFfmpeg →
 * probe self-check → VideoResult.
 *
 * Boundary rules honored here:
 * - 校验逻辑 (BR-U4-12 表): defensive RenderJob assertions — frames 非空、
 *   每帧 displaySec>0、Σframes.displaySec = ΣsegmentDurations ±0.1s、
 *   segmentDurations 非空、audioTrack 非空 → ValidationError.
 * - BR-U4-9: probe self-check failure DELETES the output（不留半成品）and
 *   throws ValidationError (FR-3 AC-2).
 * - U2 contract: the pure builders never touch disk — THIS caller writes
 *   the concat list produced by buildComposeConcatList to
 *   composeConcatListPath before invoking runFfmpeg.
 *
 * markStep("compose") is the CALLER's job (U6 CLI assembly): this backend
 * never touches state.json — it returns a VideoResult and nothing else.
 */

import { existsSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";

import {
  buildComposeArgs,
  buildComposeConcatList,
  composeConcatListPath,
  DEFAULT_ENCODE_OPTIONS,
  FFMPEG_TIMEOUTS,
  probe,
  runFfmpeg,
} from "@adapters/ffmpeg";
import type { FfmpegEncodeOptions, MediaInfo } from "@adapters/ffmpeg";
import { IoError, ValidationError } from "@core/errors";

import type { RenderBackend, RenderJob, VideoResult } from "./types";

/** Probe self-check tolerance: |video duration − audio duration| (FR-3 AC-2). */
export const DURATION_TOLERANCE_SEC = 2;

/** Pre-compose alignment tolerance: |Σframes − Σsegments| (音画对齐守护). */
export const ALIGNMENT_TOLERANCE_SEC = 0.1;

/** Injectable seams + config for {@link FfmpegComposeBackend}. */
export interface FfmpegComposeBackendOptions {
  /** Encode profile (config-injected, never from the job). */
  encode?: FfmpegEncodeOptions;
  /** ffmpeg executable (config FFMPEG_PATH). */
  ffmpegPath?: string;
  /** Executor seam. Default: the real {@link runFfmpeg}. */
  runFn?: (argv: string[], options: { timeoutSec: number }) => Promise<void>;
  /** Probe seam. Default: the real {@link probe}. */
  probeFn?: (path: string) => Promise<MediaInfo>;
}

/** Pre-compose defensive assertions (校验逻辑, BR-U4-12 表). */
function assertJob(job: RenderJob): void {
  const problems: string[] = [];
  if (job.frames.length === 0) problems.push("frames 为空（至少需要一帧）");
  for (const [i, frame] of job.frames.entries()) {
    if (!Number.isFinite(frame.displaySec) || frame.displaySec <= 0) {
      problems.push(`frames[${i}].displaySec 非法: ${frame.displaySec}`);
    }
    if (frame.path.length === 0) problems.push(`frames[${i}].path 为空`);
  }
  if (job.segmentDurations.length === 0) {
    problems.push("segmentDurations 为空");
  }
  if (job.audioTrack.length === 0) problems.push("audioTrack 为空");

  if (problems.length === 0) {
    const framesSum = job.frames.reduce((a, f) => a + f.displaySec, 0);
    const segmentsSum = job.segmentDurations.reduce((a, d) => a + d, 0);
    if (Math.abs(framesSum - segmentsSum) > ALIGNMENT_TOLERANCE_SEC) {
      problems.push(
        `音画对齐断言失败: Σframes.displaySec ${framesSum.toFixed(3)}s ≠ ` +
          `ΣsegmentDurations ${segmentsSum.toFixed(3)}s（容差 ±${ALIGNMENT_TOLERANCE_SEC}s）`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(
      `RenderJob 校验失败:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
}

/**
 * P1 render backend: card frames + merged audio → 9:16 mp4 via FFmpeg,
 * with a post-compose probe self-check (FR-3 AC-2).
 */
export class FfmpegComposeBackend implements RenderBackend {
  private readonly encode: FfmpegEncodeOptions;
  private readonly ffmpegPath: string | undefined;
  private readonly runFn: NonNullable<FfmpegComposeBackendOptions["runFn"]>;
  private readonly probeFn: NonNullable<FfmpegComposeBackendOptions["probeFn"]>;

  constructor(options: FfmpegComposeBackendOptions = {}) {
    this.encode = options.encode ?? DEFAULT_ENCODE_OPTIONS;
    this.ffmpegPath = options.ffmpegPath;
    this.runFn = options.runFn ?? runFfmpeg;
    this.probeFn = options.probeFn ?? probe;
  }

  /**
   * Workflow 4:
   * 1. Defensive job assertions (音画对齐守护 ±0.1s).
   * 2. Write the concat demuxer list (U2 pure builders; atomic write).
   * 3. buildComposeArgs → runFfmpeg (compose timeout, BR-U2-8).
   * 4. Probe self-check: output.width×output.height, duration = 音轨 ±2s
   *    (both probe-measured), exactly 1 video + 1 audio stream. Mismatch →
   *    output DELETED + ValidationError（不留半成品, BR-U4-9）.
   * 5. Return VideoResult. (markStep("compose") is the caller's job.)
   *
   * @throws ValidationError on job assertion or self-check failure.
   * @throws FfmpegError from the executor/probe subprocess.
   * @throws IoError when the concat list cannot be written.
   */
  async compose(job: RenderJob): Promise<VideoResult> {
    assertJob(job);

    // 2. Concat list: pure content, this caller persists it (U2 contract).
    const listPath = composeConcatListPath(job);
    const listContent = buildComposeConcatList(job.frames);
    try {
      const tmp = `${listPath}.tmp`;
      await writeFile(tmp, listContent, "utf8");
      await rename(tmp, listPath);
    } catch (cause) {
      throw new IoError(`concat 列表写入失败: ${listPath}`, { cause });
    }

    // 3. Compose (argv from the pure builder; encode params from config).
    const argv = buildComposeArgs(job, this.encode, {
      ...(this.ffmpegPath === undefined ? {} : { ffmpegPath: this.ffmpegPath }),
    });
    await this.runFn(argv, { timeoutSec: FFMPEG_TIMEOUTS.composeSec });

    // 4. Probe self-check (FR-3 AC-2).
    const info = await this.probeFn(job.output.path);
    const audio = await this.probeFn(job.audioTrack);
    const problems: string[] = [];
    if (info.width !== job.output.width || info.height !== job.output.height) {
      problems.push(
        `分辨率 ${info.width}×${info.height} ≠ ${job.output.width}×${job.output.height}`,
      );
    }
    if (
      Math.abs(info.durationSec - audio.durationSec) > DURATION_TOLERANCE_SEC
    ) {
      problems.push(
        `时长 ${info.durationSec.toFixed(2)}s 偏离音轨 ${audio.durationSec.toFixed(2)}s 超 ±${DURATION_TOLERANCE_SEC}s`,
      );
    }
    if (info.videoStreams !== 1 || info.audioStreams !== 1) {
      problems.push(
        `流结构 ${info.videoStreams} 视频/${info.audioStreams} 音频 ≠ 1 视频+1 音频`,
      );
    }
    if (problems.length > 0) {
      if (existsSync(job.output.path)) {
        await unlink(job.output.path); // 不留半成品（BR-U4-9）
      }
      throw new ValidationError(
        `产物 probe 自检失败（已删除 ${job.output.path}）:\n${problems
          .map((p) => `- ${p}`)
          .join("\n")}`,
      );
    }

    return {
      path: job.output.path,
      durationSec: info.durationSec,
      probe: info,
    };
  }
}
