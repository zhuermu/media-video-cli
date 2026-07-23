/**
 * @module @adapters/ffmpeg (args)
 *
 * Pure argv builder family (FR-3.3): deterministic functions from job
 * values to ffmpeg/ffprobe argv arrays. Construction and execution are
 * strictly separated — these builders never spawn anything.
 *
 * Purity contract (BR-U2-6, snapshot-guarded):
 * - no file-system access
 * - no Date / randomness
 * - no shell-string interpolation — argv arrays only (BR-U2-7)
 * Same input → element-wise identical output (FR-3.3 AC-1).
 *
 * Concat-list design decision: buildComposeArgs returns argv referencing a
 * concat-list file whose path is derived deterministically from the job
 * (`<output.path>.concat.txt`, see {@link composeConcatListPath}) and whose
 * CONTENT is produced by the pure {@link buildComposeConcatList}. The CALLER
 * (U4 FfmpegComposeBackend) writes that file to disk before invoking
 * runFfmpeg — the builders stay side-effect free.
 */

import { ValidationError } from "@core/errors";

import type { ComposeJob, FfmpegEncodeOptions, RenderFrame } from "./types";
import { AUDIO_SPEC, DEFAULT_ENCODE_OPTIONS } from "./types";

/** Executable overrides (config-injected; defaults keep builders pure). */
export interface ArgBuilderOptions {
  /** ffmpeg executable placed at argv[0]. Default: "ffmpeg". */
  ffmpegPath?: string;
}

/** Executable override for ffprobe argv. */
export interface ProbeBuilderOptions {
  /** ffprobe executable placed at argv[0]. Default: "ffprobe". */
  ffprobePath?: string;
}

/**
 * Deterministic concat-list file path for a compose job: derived from the
 * output path so repeat builds of the same job reference the same file.
 */
export function composeConcatListPath(job: ComposeJob): string {
  return `${job.output.path}.concat.txt`;
}

/** Quotes a path for the concat demuxer list (escapes single quotes). */
function concatQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function assertFrames(frames: RenderFrame[]): void {
  if (frames.length === 0) {
    throw new ValidationError("compose 任务 frames 为空（至少需要一帧卡片）");
  }
  for (const [i, frame] of frames.entries()) {
    if (frame.path.length === 0) {
      throw new ValidationError(`frames[${i}].path 为空`);
    }
    if (!Number.isFinite(frame.displaySec) || frame.displaySec <= 0) {
      throw new ValidationError(
        `frames[${i}].displaySec 非法: ${frame.displaySec}（要求正的有限秒数）`,
      );
    }
  }
}

/**
 * Pure function: frame table → concat demuxer list content (still-image
 * slideshow with per-frame display durations, RenderJob v1.1).
 *
 * The final frame is repeated without a duration line — the concat demuxer
 * ignores the `duration` of the last entry unless the file is listed again
 * (documented ffmpeg quirk).
 */
export function buildComposeConcatList(frames: RenderFrame[]): string {
  assertFrames(frames);
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file ${concatQuote(frame.path)}`);
    lines.push(`duration ${frame.displaySec.toFixed(3)}`);
  }
  const last = frames[frames.length - 1]!;
  lines.push(`file ${concatQuote(last.path)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Pure function: ComposeJob → ffmpeg argv (PNG card sequence + audio track
 * → 9:16 mp4). Writes NOTHING — the caller must write the concat list
 * returned by {@link buildComposeConcatList} to {@link composeConcatListPath}
 * before executing.
 *
 * Still-image concat demuxer handling: `-vsync cfr -r <fps>` resamples the
 * variable-duration stills to a constant-frame-rate stream; `-pix_fmt
 * yuv420p` keeps players happy; `-shortest` guards against an audio track
 * marginally longer than the frame timeline.
 *
 * Encode parameters come from config via `encode` (never from the job —
 * P2 剪映 sibling adapter must not see FFmpeg specifics).
 *
 * @throws ValidationError on empty/invalid frames, audio track, fps or paths.
 */
export function buildComposeArgs(
  job: ComposeJob,
  encode: FfmpegEncodeOptions = DEFAULT_ENCODE_OPTIONS,
  options: ArgBuilderOptions = {},
): string[] {
  assertFrames(job.frames);
  if (job.audioTrack.length === 0) {
    throw new ValidationError("compose 任务 audioTrack 为空");
  }
  if (!Number.isInteger(job.output.fps) || job.output.fps <= 0) {
    throw new ValidationError(
      `output.fps 非法: ${job.output.fps}（要求正整数）`,
    );
  }
  if (job.output.path.length === 0) {
    throw new ValidationError("output.path 为空");
  }

  return [
    options.ffmpegPath ?? "ffmpeg",
    "-y",
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    composeConcatListPath(job),
    "-i",
    job.audioTrack,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    `scale=${job.output.width}:${job.output.height}`,
    "-r",
    String(job.output.fps),
    "-vsync",
    "cfr",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    encode.videoCodec,
    "-preset",
    encode.preset,
    "-crf",
    String(encode.crf),
    "-c:a",
    encode.audioCodec,
    "-b:a",
    encode.audioBitrate,
    "-shortest",
    "-movflags",
    "+faststart",
    job.output.path,
  ];
}

/**
 * Pure function: ordered audio files → ffmpeg concat argv (merged track).
 *
 * Uses the concat FILTER (not the demuxer): all inputs are declared as `-i`
 * arguments so no caller-written list file is needed — fully deterministic
 * from the argument values alone. Output is re-encoded to the locked
 * AudioSpec (aac 48kHz stereo, BR-U2-4/Q2=A) so the merged track is
 * spec-uniform even if an input slipped past normalization.
 *
 * @throws ValidationError on empty file list or output path.
 */
export function buildConcatArgs(
  files: string[],
  out: string,
  options: ArgBuilderOptions = {},
): string[] {
  if (files.length === 0) {
    throw new ValidationError("concat 输入文件列表为空");
  }
  for (const [i, file] of files.entries()) {
    if (file.length === 0) throw new ValidationError(`concat files[${i}] 为空`);
  }
  if (out.length === 0) throw new ValidationError("concat 输出路径为空");

  const filter =
    files.map((_, i) => `[${i}:a:0]`).join("") +
    `concat=n=${files.length}:v=0:a=1[a]`;

  return [
    options.ffmpegPath ?? "ffmpeg",
    "-y",
    "-v",
    "error",
    ...files.flatMap((file) => ["-i", file]),
    "-filter_complex",
    filter,
    "-map",
    "[a]",
    "-c:a",
    AUDIO_SPEC.codec,
    "-b:a",
    AUDIO_SPEC.bitrate,
    "-ar",
    String(AUDIO_SPEC.sampleRateHz),
    "-ac",
    String(AUDIO_SPEC.channels),
    out,
  ];
}

/**
 * Pure function: single audio file → per-segment normalization argv
 * (transcode to the locked AudioSpec BEFORE concat, BR-U2-4 防破音).
 *
 * @throws ValidationError on empty paths.
 */
export function buildNormalizeArgs(
  input: string,
  output: string,
  options: ArgBuilderOptions = {},
): string[] {
  if (input.length === 0) throw new ValidationError("normalize 输入路径为空");
  if (output.length === 0) throw new ValidationError("normalize 输出路径为空");

  return [
    options.ffmpegPath ?? "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    input,
    "-ac",
    String(AUDIO_SPEC.channels),
    "-ar",
    String(AUDIO_SPEC.sampleRateHz),
    "-c:a",
    AUDIO_SPEC.codec,
    "-b:a",
    AUDIO_SPEC.bitrate,
    output,
  ];
}

/**
 * Pure function: media path → ffprobe argv (JSON structural probe).
 *
 * @throws ValidationError on empty path.
 */
export function buildProbeArgs(
  path: string,
  options: ProbeBuilderOptions = {},
): string[] {
  if (path.length === 0) throw new ValidationError("probe 路径为空");

  return [
    options.ffprobePath ?? "ffprobe",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    path,
  ];
}
