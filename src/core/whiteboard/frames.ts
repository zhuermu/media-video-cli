/**
 * @module @core/whiteboard (frames)
 *
 * 帧渲染：WhiteboardPlan + t → 单帧 SVG（纯函数），以及 PNG 帧序列
 * 生成（I/O 收敛在 renderWhiteboardFrames——与 cards.frames 同分工）。
 *
 * 音画对齐：帧数 = round(totalSec × fps)，每帧 displaySec = 1/fps，
 * 末帧吸收舍入余数，使 Σframes.displaySec === totalSec（满足
 * FfmpegComposeBackend 的 ±0.1s 对齐断言，实际误差 0）。
 */

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import type { PngFile } from "@core/cards";
import { IoError, RenderError, ValidationError } from "@core/errors";
import type { RenderFrame } from "@core/render";

import { cameraAt } from "./camera";
import { fmt } from "./geometry";
import { penDefs, penPoseAt, penSvg } from "./pen";
import type { TimelineEl, WhiteboardPlan, WhiteboardTheme } from "./types";
import { DEFAULT_FPS, OUT } from "./types";

/** 主题网格的 pattern defs. */
function gridDefs(theme: WhiteboardTheme): string {
  switch (theme.grid) {
    case "dots":
      return `<pattern id="wbGrid" width="108" height="108" patternUnits="userSpaceOnUse"><circle cx="54" cy="54" r="3" fill="${theme.gridColor}"/></pattern>`;
    case "ruled":
      return `<pattern id="wbGrid" width="108" height="108" patternUnits="userSpaceOnUse"><line x1="0" y1="107" x2="108" y2="107" stroke="${theme.gridColor}" stroke-width="2"/></pattern>`;
    case "none":
      return "";
  }
}

/**
 * 时刻 t 的整帧 SVG（纯函数；快照测试锚点）。
 */
export function frameSvg(plan: WhiteboardPlan, t: number): string {
  const [cx, cy, w] = cameraAt(t, plan.camMoves);
  const h = (w * OUT.height) / OUT.width;
  const vb = `${fmt(cx - w / 2)} ${fmt(cy - h / 2)} ${fmt(w)} ${fmt(h)}`;
  const theme = plan.theme;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT.width}" height="${OUT.height}" viewBox="${vb}">`,
    `<defs>${gridDefs(theme)}${penDefs()}</defs>`,
    `<rect x="${fmt(cx - w)}" y="${fmt(cy - h)}" width="${fmt(w * 2)}" height="${fmt(h * 2)}" fill="${theme.paper}"/>`,
  ];
  if (theme.grid !== "none") {
    parts.push(
      `<rect x="0" y="0" width="${plan.canvasW}" height="${plan.canvasH}" fill="url(#wbGrid)"/>`,
    );
  }
  // 视口剔除：镜头外的元素不进 SVG（体积 + resvg 画外图层崩溃防御）
  const vx0 = cx - w / 2;
  const vy0 = cy - h / 2;
  const vx1 = cx + w / 2;
  const vy1 = cy + h / 2;
  for (const el of plan.els) {
    const b = el.bbox;
    if (
      b !== undefined &&
      (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)
    ) {
      continue;
    }
    parts.push(el.svg(t));
  }

  if (t < plan.penExitAt) {
    const penEls = plan.els.filter(
      (e): e is TimelineEl & { pen: NonNullable<TimelineEl["pen"]> } =>
        e.pen !== undefined,
    );
    const pose = penPoseAt(t, penEls, theme.penTiltDeg);
    if (pose !== null) parts.push(penSvg(pose));
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * 无字体快路径栅格化：白板帧的文字全部已是矢量路径（真笔顺轮廓 +
 * opentype 转换的回退字形），无需加载任何字体文件——避免 resvg 逐帧
 * 解析系统字体（曾致 0.66s/帧 的性能退化，vs 无字体 ~0.03s/帧）。
 *
 * @throws RenderError resvg 失败；IoError 写盘失败（原子写同 ADR-004）.
 */
export async function rasterizeVectorFrame(
  svg: string,
  outPath: string,
): Promise<PngFile> {
  let png: Uint8Array;
  let width: number;
  let height: number;
  try {
    const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
    const rendered = resvg.render();
    width = rendered.width;
    height = rendered.height;
    png = rendered.asPng();
  } catch (cause) {
    throw new RenderError(
      `白板帧栅格化失败: ${basename(outPath)}（svg 长度 ${svg.length} 字符）`,
      { cause },
    );
  }
  const tmp = `${outPath}.tmp`;
  try {
    await writeFile(tmp, png);
    await rename(tmp, outPath);
  } catch (cause) {
    throw new IoError(`帧 PNG 写入失败: ${outPath}`, { cause });
  }
  return { path: outPath, width, height };
}

/** renderWhiteboardFrames 的注入缝（离线单测）. */
export interface RenderWhiteboardOptions {
  fps?: number;
  /** 栅格化注入缝. Default: {@link rasterizeVectorFrame}（无字体快路径）. */
  rasterizeFn?: (svg: string, outPath: string) => Promise<PngFile>;
  /** 进度回调（stderr 转述用）. */
  onProgress?: (done: number, total: number) => void;
}

/** 稳定帧文件名：wb-<帧号 5 位>.png. */
export function whiteboardFrameName(index: number): string {
  return `wb-${String(index).padStart(5, "0")}.png`;
}

/**
 * 渲染整支视频的 PNG 帧序列（幂等：已存在的帧文件跳过——同 cards
 * BR-U4-10 约定），返回 RenderFrame[]（Σ displaySec === plan.totalSec）。
 *
 * @throws ValidationError fps 非法
 * @throws IoError 输出目录创建失败
 * @throws RenderError 栅格化失败（rasterize 内抛）
 */
export async function renderWhiteboardFrames(
  plan: WhiteboardPlan,
  outDir: string,
  options: RenderWhiteboardOptions = {},
): Promise<RenderFrame[]> {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps < 5 || fps > 60) {
    throw new ValidationError(`fps 非法: ${fps}（要求 5-60）`);
  }
  const rasterizeFn = options.rasterizeFn ?? rasterizeVectorFrame;

  try {
    await mkdir(outDir, { recursive: true });
  } catch (cause) {
    throw new IoError(`帧目录创建失败: ${outDir}`, { cause });
  }

  const total = Math.max(1, Math.round(plan.totalSec * fps));
  const frameSec = 1 / fps;
  const frames: RenderFrame[] = [];
  for (let f = 0; f < total; f++) {
    const path = join(outDir, whiteboardFrameName(f));
    if (!existsSync(path)) {
      await rasterizeFn(frameSvg(plan, f / fps), path);
    }
    // 末帧吸收舍入余数：Σ displaySec 精确等于 totalSec
    const displaySec =
      f === total - 1 ? plan.totalSec - frameSec * (total - 1) : frameSec;
    frames.push({ path, displaySec });
    options.onProgress?.(f + 1, total);
  }
  return frames;
}
