/**
 * @module @core/render (types)
 *
 * The backend-agnostic render PORT (component-methods.md v1.1 修正案):
 * RenderFrame / RenderJob / VideoResult / RenderBackend. This is the P2
 * seam — JianyingDraftBackend implements the same port consuming only
 * RenderJob, never touching cards internals (unit-of-work P2 接缝).
 *
 * Purity contract: every field is a path/number/string — no Date, no
 * randomness, no mutable references (FR-3.3 AC-1 snapshot-testable).
 *
 * U2's ComposeJob mirrors RenderJob structurally (ComposeJob lives INSIDE
 * the ffmpeg adapter per component-methods); values flow across by
 * structural typing — no import edge from U2 to U4.
 */

import type { MediaInfo } from "@adapters/ffmpeg";

/** One frame = one card PNG + its display duration (v1.1 修正案, Option B). */
export interface RenderFrame {
  path: string;
  displaySec: number;
}

/** Backend-agnostic render task (locked fields, component-methods v1.1). */
export interface RenderJob {
  /** 有序帧序列（cards 产出；字幕分页的每帧时长随帧内聚，后端零重算）. */
  frames: RenderFrame[];
  /** 合并音轨路径（mergeAudio 产出）. */
  audioTrack: string;
  /** 实际逐段秒数（必须来自 durations.json 实测——BR-U4-6；对齐断言用）. */
  segmentDurations: number[];
  /** 逐段字幕文字（可选；P1 卡片已烧录字幕，此字段是 P2 接缝）. */
  subtitleText?: string[];
  output: { path: string; width: 1080; height: 1920; fps: number };
}

/** Composition result (locked fields): output path + probe-measured facts. */
export interface VideoResult {
  path: string;
  durationSec: number;
  probe: MediaInfo;
}

/**
 * Render backend port: backend-agnostic render task → finished video.
 * P1 唯一实现 {@link import("./ffmpeg-backend").FfmpegComposeBackend}；
 * P2 JianyingDraftBackend 作为 sibling 实现接入（只消费 RenderJob）.
 */
export interface RenderBackend {
  compose(job: RenderJob): Promise<VideoResult>;
}
