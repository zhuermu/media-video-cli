/**
 * @module @core/tts (registry)
 *
 * Backend registry (domain-entities TtsBackend 策略实体): keyed by the
 * config enum TtsBackendName so AppConfig.ttsBackend selects directly.
 * Factories keep construction lazy — importing the registry never opens a
 * connection. Paid backends (P2) are added to this same table.
 *
 * Lives in its own file (not types.ts) to avoid a value-level import cycle
 * between the port type and its implementations.
 */

import type { TtsBackendName } from "@core/config";

import { EdgeTtsBackend } from "./backends/edge";
import { SayTtsBackend } from "./backends/say";
import type { TtsBackend } from "./types";

/** Registry of available backends: { edge, say } (Q1=A). */
export const TTS_BACKENDS: Record<TtsBackendName, () => TtsBackend> = {
  edge: () => new EdgeTtsBackend(),
  say: () => new SayTtsBackend(),
};

/** Instantiates the backend selected by AppConfig.ttsBackend. */
export function createTtsBackend(name: TtsBackendName): TtsBackend {
  return TTS_BACKENDS[name]();
}
