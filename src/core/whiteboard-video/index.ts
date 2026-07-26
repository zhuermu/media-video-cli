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
 *   `board`（画布纸感与背景）、`marker` / `pen-marker` / `flat-import`（笔迹与
 *   插画笔法）
 * - **设计系统**（对齐 `assets/design/image2.png`，白板视频设计系统 2.0）：
 *   `palette`（§3 八色语义板 + §4 笔触配色）、`strokes`（§2 线宽档位/虚线/点线/
 *   波浪/闪电/荧光笔触）、`shapes`（§5 图形与标记件）、`charts`（§7 数据可视化）、
 *   `diagrams`（§8 表格列表 + §9 流程结构图）、`emphasis`（§13 状态强调 + §12
 *   装饰件）
 * - **装配**：`compose`（时间轴）、`render`（帧）、`mux`（音轨与合成）、
 *   `pipeline`（编排）
 */

export * from "./article";
export * from "./assets-match";
export * from "./blocks";
export * from "./board";
export * from "./canvas";
export * from "./chart-block";
export * from "./charts";
export * from "./compose";
export * from "./config";
export * from "./diagrams";
export * from "./emphasis";
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
export * from "./palette";
export * from "./pen-marker";
export * from "./pipeline";
export * from "./render";
export * from "./shapes";
export * from "./strokes";
export * from "./subtitle";
export * from "./voices";
