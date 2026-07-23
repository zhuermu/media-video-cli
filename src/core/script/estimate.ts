/**
 * @module @core/script (estimate)
 *
 * Pure duration estimation (Workflow 3):
 * `perSegment[i] = ceil(len(text) / charsPerSec) + interSegmentPauseSec`,
 * total = Σ perSegment, withinTarget = 60 ≤ total ≤ 180. 0.1s precision.
 *
 * Boundary rules honored here:
 * - BR-U3-8: charsPerSec is configurable (default 4.5, Q2=A); the estimate
 *   is for preview and target-window judgement ONLY — U4 card timing must
 *   use U2's ffprobe-measured durations.json (估算非真值).
 * - BR-U3-7: withinTarget=false is a warning, never a block (the caller
 *   annotates script.md; 时长是创作裁量).
 */

import {
  DEFAULT_SPEECH_RATE,
  DURATION_TARGET,
  type DurationEstimate,
  type Script,
  type SpeechRateConfig,
} from "./types";

/** Rounds to 0.1s precision (FP-noise-free display and comparison). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Estimates narration duration per segment and in total (pure function,
 * deterministic — snapshot-testable).
 */
export function estimateDuration(
  script: Script,
  config: SpeechRateConfig = DEFAULT_SPEECH_RATE,
): DurationEstimate {
  const perSegment = script.segments.map((segment) =>
    round1(
      Math.ceil(segment.text.length / config.charsPerSec) +
        config.interSegmentPauseSec,
    ),
  );
  const total = round1(perSegment.reduce((sum, sec) => sum + sec, 0));
  return {
    total,
    perSegment,
    withinTarget:
      total >= DURATION_TARGET.minSec && total <= DURATION_TARGET.maxSec,
  };
}
