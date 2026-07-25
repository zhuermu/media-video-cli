/**
 * @module core/whiteboard-video
 *
 * 白板讲解视频流水线：一篇 Markdown → 一条带配音、手写板书、手势动作和
 * 字幕的 mp4。
 *
 * 入口在 {@link renderWhiteboardVideo}（出片）与 {@link renderWhiteboardStills}
 * （只出关键帧，目视复核用）。写文章的约定见 `article.ts` 的模块注释。
 *
 * 分层：
 * - **素材**：`hand` / `gestures`（Sparkol 手势）、`assets-match`（插画检索）、
 *   `images`（位图装载）
 * - **内容**：`article`（Markdown → 分镜）、`voices` / `narrate`（音色与配音）、
 *   `subtitle`（词级时间戳 → 字幕）
 * - **版式**：`layout` / `format`（横竖两套）、`blocks`（标题/清单）、
 *   `board`（画布纸感）、`marker` / `pen-marker` / `flat-import`（笔迹与插画笔法）
 * - **装配**：`compose`（时间轴）、`render`（帧）、`mux`（音轨与合成）、
 *   `pipeline`（编排）
 */

export * from "./article";
export * from "./assets-match";
export * from "./blocks";
export * from "./board";
export * from "./compose";
export * from "./config";
export * from "./flat-import";
export * from "./format";
export * from "./gestures";
export * from "./hand";
export * from "./images";
export * from "./layout";
export * from "./log";
export * from "./marker";
export * from "./mux";
export * from "./narrate";
export * from "./pen-marker";
export * from "./pipeline";
export * from "./render";
export * from "./subtitle";
export * from "./voices";
