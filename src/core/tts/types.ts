/**
 * @module @core/tts (types)
 *
 * TTS port and locked audio types (component-methods.md 核心类型定义).
 *
 * Port signature is locked to `synthesize(text, voice) → Promise<AudioFile>`
 * (component-methods tts table). VoiceOpts itself is NOT field-locked
 * upstream, so it carries the voice name plus the synthesis context the
 * TtsError contract requires (segmentIndex) — the orchestrator supplies it,
 * backends echo it into typed errors.
 */

/** Single synthesized segment result (locked fields). */
export interface AudioFile {
  path: string;
  /**
   * ffprobe-measured seconds (BR-U2-3). Backends return 0 here — they must
   * NOT claim durations; synthesizeScript replaces the value with the
   * ffprobe measurement after synthesis.
   */
  durationSec: number;
}

/** Segment-index binding for an {@link AudioFile} (locked fields). */
export interface SegmentAudio {
  index: number;
  audio: AudioFile;
}

/** Merged audio track (locked fields). segmentOffsets = prefix sums. */
export interface AudioTrack {
  path: string;
  durationSec: number;
  /**
   * Start offset (seconds) of each segment inside the merged track —
   * prefix sums of the measured per-segment durations. U4's sole source
   * of card-switch timing.
   */
  segmentOffsets: number[];
}

/** Voice options passed to {@link TtsBackend.synthesize}. */
export interface VoiceOpts {
  /** Backend-specific voice name (edge ShortName / macOS say voice). */
  name: string;
  /**
   * Zero-based segment index being synthesized; flows into TtsError
   * context (FR-2.1). Backends default to -1 when absent.
   */
  segmentIndex?: number;
}

/**
 * TTS port (策略实体): one implementation per backend, selected via
 * AppConfig.ttsBackend through the registry. Paid backends (P2) plug into
 * the same table.
 */
export interface TtsBackend {
  /** Backend identifier used in TtsError.backend context. */
  readonly id: string;
  /** Voice used when the caller does not specify one (config default). */
  readonly defaultVoice: string;
  /**
   * Synthesizes one segment of text to an audio file (backend-managed temp
   * location; the orchestrator moves it into `audio/seg-NN.mp3`).
   *
   * @throws TTSNetworkError (retryable) / TTSRateLimitError /
   *         TTSMalformedOutputError / TTSBackendError (FR-2.1 taxonomy).
   */
  synthesize(text: string, voice: VoiceOpts): Promise<AudioFile>;
}

/**
 * Structural subset of U3's Script consumed by synthesizeScript. U3 owns the
 * full Script type (@core/script, not yet built); its values are assignable
 * here by structural typing — U2 keeps its dependency surface at U1 only
 * (unit-of-work.md).
 */
export interface TtsScript {
  segments: ReadonlyArray<{ text: string }>;
}

/** durations.json shape (audio/durations.json — U4's timing input contract). */
export interface DurationsJson {
  /** ffprobe-measured per-segment seconds (BR-U2-3), index-aligned. */
  perSegment: number[];
  /** Sum of perSegment. */
  total: number;
  /** Prefix-sum start offsets; written by mergeAudio (monotonic). */
  segmentOffsets?: number[];
}

/** durations.json file name inside `audio/`. */
export const DURATIONS_FILE = "durations.json";

/** Merged track file name inside `audio/` (U1 workdir tts checklist). */
export const MERGED_FILE = "merged.m4a";

/**
 * Locked segment file naming: `seg-<index two-digit>.mp3` (domain-entities;
 * idempotent re-run detection depends on this being stable).
 */
export function segmentFileName(index: number): string {
  return `seg-${String(index).padStart(2, "0")}.mp3`;
}
