/**
 * @module @adapters/ffmpeg (probe)
 *
 * ffprobe structural probe → {@link MediaInfo}. The subprocess call is thin
 * orchestration (buildProbeArgs + runCaptureStdout); all parsing logic lives
 * in the pure {@link parseProbeJson}, which is unit-tested offline.
 */

import { FfmpegError } from "@core/errors";

import { buildProbeArgs, type ProbeBuilderOptions } from "./args";
import { runCaptureStdout } from "./run";
import { FFMPEG_TIMEOUTS, type MediaInfo } from "./types";

/** Options for {@link probe}. */
export interface ProbeOptions extends ProbeBuilderOptions {
  /** Subprocess timeout. Default: locked probe timeout 10s (BR-U2-8). */
  timeoutSec?: number;
}

/**
 * Probes a media file's structure: resolution, duration, stream counts.
 *
 * @throws FfmpegError when ffprobe fails, times out, or emits unusable JSON.
 */
export async function probe(
  path: string,
  options: ProbeOptions = {},
): Promise<MediaInfo> {
  const argv = buildProbeArgs(path, options);
  const stdout = await runCaptureStdout(argv, {
    timeoutSec: options.timeoutSec ?? FFMPEG_TIMEOUTS.probeSec,
  });
  return parseProbeJson(stdout, argv);
}

/** Minimal structural view over ffprobe's JSON output. */
interface ProbeJson {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

/**
 * Pure function: ffprobe JSON text → {@link MediaInfo}.
 *
 * Duration source: `format.duration` first, falling back to the maximum
 * stream duration. Files that genuinely carry no duration (e.g. still
 * images) yield `durationSec: 0` — duration-asserting consumers (mergeAudio,
 * U4 compose self-check) treat 0 as a violation, so nothing fails silently.
 *
 * @param argv the ffprobe argv, carried into FfmpegError for reproducibility
 *             (invariant 3: every failure reproduces its command).
 * @throws FfmpegError when the text is not valid JSON.
 */
export function parseProbeJson(jsonText: string, argv: string[]): MediaInfo {
  let raw: ProbeJson;
  try {
    raw = JSON.parse(jsonText) as ProbeJson;
  } catch (cause) {
    throw new FfmpegError(
      `ffprobe 输出不是合法 JSON: ${jsonText.slice(0, 200)}`,
      { argv, stderr: "", cause },
    );
  }

  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const videoStreams = streams.filter((s) => s["codec_type"] === "video");
  const audioStreams = streams.filter((s) => s["codec_type"] === "audio");

  const firstVideo = videoStreams[0];
  const width =
    typeof firstVideo?.["width"] === "number" ? firstVideo["width"] : 0;
  const height =
    typeof firstVideo?.["height"] === "number" ? firstVideo["height"] : 0;

  let durationSec = Number(raw.format?.["duration"]);
  if (!Number.isFinite(durationSec)) {
    const streamDurations = streams
      .map((s) => Number(s["duration"]))
      .filter((d) => Number.isFinite(d));
    durationSec = streamDurations.length > 0 ? Math.max(...streamDurations) : 0;
  }

  return {
    width,
    height,
    durationSec,
    videoStreams: videoStreams.length,
    audioStreams: audioStreams.length,
  };
}
