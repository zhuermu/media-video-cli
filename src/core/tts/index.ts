/**
 * @core/tts — U2 export surface (unit-of-work.md import 契约):
 * TtsBackend port, synthesizeScript/mergeAudio, AudioFile/SegmentAudio/
 * AudioTrack, backend registry and both free backends.
 */
export * from "./types";
export * from "./registry";
export * from "./synthesize";
export * from "./backends/edge";
export * from "./backends/say";
