/**
 * @core/tts — U2 export surface (unit-of-work.md import 契约):
 * TtsBackend port, synthesizeScript/mergeAudio/clearAudio, AudioFile/
 * SegmentAudio/AudioTrack, backend registry and the three backends
 * (free edge/say + paid minimax).
 */
export * from "./types";
export * from "./registry";
export * from "./synthesize";
export * from "./backends/edge";
export * from "./backends/say";
export * from "./backends/minimax";
