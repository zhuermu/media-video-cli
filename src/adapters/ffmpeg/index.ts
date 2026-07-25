/**
 * @adapters/ffmpeg — U2 export surface (unit-of-work.md import 契约):
 * buildComposeArgs / buildConcatArgs / buildProbeArgs (pure argv builders),
 * runFfmpeg (thin executor), probe, MediaInfo + adapter task types.
 */
export * from "./types";
export * from "./args";
export * from "./mix";
export * from "./run";
export * from "./probe";
