/**
 * @module @adapters/ffmpeg (types)
 *
 * FFmpeg adapter task descriptions and locked result types.
 *
 * ComposeJob mirrors RenderJob v1.1 structurally (component-methods.md 核心
 * 类型定义): component-methods places ComposeJob INSIDE the ffmpeg adapter
 * ("仅 FfmpegComposeBackend 使用，不出现在端口上"), so U2 owns the
 * definition. When U4 (visual-pipeline) lands, its RenderJob values are
 * assignable here by structural typing — no import edge from U2 to U4 is
 * needed (unit-of-work: U2 depends on U1 only).
 */

/** One still-image frame with its display duration (RenderJob v1.1 修正案). */
export interface RenderFrame {
  path: string;
  displaySec: number;
}

/**
 * FFmpeg compose task: ordered card frames + merged audio track → 9:16 mp4.
 * Pure value object — paths/numbers/strings only (FR-3.3 snapshot-testable).
 * FFmpeg-specific encode parameters are injected via
 * {@link FfmpegEncodeOptions} (from config), never carried on the job.
 */
export interface ComposeJob {
  /** Ordered frame sequence (cards output). */
  frames: RenderFrame[];
  /** Merged audio track path (mergeAudio output). */
  audioTrack: string;
  /** Actual per-segment seconds (durations.json; total-duration assertion). */
  segmentDurations: number[];
  /**
   * Optional per-segment subtitle text (RenderJob v1.1). Not consumed by the
   * P1 argv builder: cards already carry the on-screen text; subtitle burn-in
   * is a deliberate P2 seam, not a stub.
   */
  subtitleText?: string[];
  output: { path: string; width: 1080; height: 1920; fps: number };
}

/** ffprobe structural result (locked fields, component-methods.md). */
export interface MediaInfo {
  width: number;
  height: number;
  durationSec: number;
  videoStreams: number;
  audioStreams: number;
}

/**
 * Encode parameters injected from config (never from the job — ADR/P2 剪映
 * sibling adapter must not see FFmpeg specifics). U6 wires these from
 * AppConfig; until then the defaults below are the single source.
 */
export interface FfmpegEncodeOptions {
  videoCodec: string;
  preset: string;
  crf: number;
  audioCodec: string;
  audioBitrate: string;
}

/** Default encode profile: libx264/aac, the free-toolchain baseline (C6). */
export const DEFAULT_ENCODE_OPTIONS: FfmpegEncodeOptions = {
  videoCodec: "libx264",
  preset: "medium",
  crf: 23,
  audioCodec: "aac",
  audioBitrate: "128k",
};

/**
 * Locked audio transcode spec (domain-entities AudioSpec 常量实体, Q2=A):
 * m4a/aac, 48kHz, stereo — every segment normalized to this BEFORE concat.
 */
export const AUDIO_SPEC = {
  container: "m4a",
  codec: "aac",
  sampleRateHz: 48000,
  channels: 2,
  bitrate: "128k",
} as const;

/**
 * Locked subprocess timeout table (BR-U2-8, NFR-1 防悬挂):
 * compose 300s / concat 60s / probe 10s.
 */
export const FFMPEG_TIMEOUTS = {
  composeSec: 300,
  concatSec: 60,
  probeSec: 10,
} as const;
