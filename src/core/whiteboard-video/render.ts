/**
 * @module core/whiteboard-video/render
 *
 * 时间轴 → PNG 帧序列。
 *
 * 两条不能忘的约束：
 *
 * 1. 帧渲染器一律 `font: { loadSystemFonts: false }`（装系统字体每帧要多花
 *    几十毫秒，一万多帧就是十几分钟）。代价是 `<text>` 会渲成空白 ——
 *    **所有文字必须走矢量路径**（`vectorText` / `markerTextEl`）。
 * 2. 不传 `resourcesDir`（实测每帧 75ms → 608ms），图片一律内联 data URI，
 *    并且在装载期就缩到显示尺寸（见 images.ts）。
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { IoError, RenderError } from "../errors/index";
import { DEFAULT_FPS, cameraAt, penPoseAt } from "../whiteboard/index";
import {
  BOARD_DESIGN,
  backgroundDefs,
  backgroundSvg,
  boardDefs,
  boardOverlaySvg,
  boardStyleFor,
  boardSurfaceSvg,
  isDarkBackground,
} from "./board";
import type { BoardBackground } from "./board";
import { cameraTransform, cellVisible, viewRect } from "./canvas";
import { WIPE_SEC } from "./compose";
import type { Storyboard } from "./compose";
import type { FormatSpec } from "./format";
import { activeHandCue } from "./gestures";
import type { HandKit } from "./gestures";
import { flatDefs } from "./flat-import";
import { handCueSvg } from "./hand";
import type { Log } from "./log";
import { silent } from "./log";
import { subtitleEl } from "./subtitle";

/** `penPoseAt` 的采样帧率（笔的朝向靠前后帧位移估计）. */
const PEN_POSE_SAMPLE_FPS = 31;

export interface FrameSvgInput {
  storyboard: Storyboard;
  format: FormatSpec;
  kit: HandKit;
  /** 页眉标题（长横版用）. */
  title: string;
  ink: string;
  accent: string;
  /** 字幕烧进帧里. */
  burnSubtitles: boolean;
  /** 板面背景样式（设计稿 §2）. Default `"plain"`. */
  background?: BoardBackground;
}

/**
 * 建一个「时刻 → SVG」的帧函数。
 *
 * 做成工厂而不是每帧重算，是因为字幕元素的版式（分行、字号、基线）只依赖
 * 画布尺寸，一次算完就能给所有帧复用。
 */
export function frameSvgFactory(input: FrameSvgInput): (t: number) => string {
  const { storyboard, format, kit, title, ink, accent, burnSubtitles } = input;
  const L = format.layout;
  const bg = input.background ?? "plain";
  // 板面样式随背景派生（米白纸换底色），光学层沿用设计稿板面
  const boardStyle = boardStyleFor(bg, BOARD_DESIGN);
  // 字幕跟着板面深浅翻个：深板上深字看不见，白色字幕板也会在深底上炸开一块白
  const dark = isDarkBackground(bg);
  const subs = subtitleEl(storyboard.subtitles, {
    width: L.width,
    height: L.height,
    ...(dark ? { color: "#F1F5F9", plate: "#12161bcc" } : {}),
  });
  const defs = storyboard.illustrations.map((il) => flatDefs(il)).join("");

  return function frameSvg(t: number): string {
    // ── 镜头：一格填满一屏，段间平移，收尾拉远 ──
    const pose = cameraAt(t, storyboard.camMoves);
    const aspect = L.width / L.height;
    const view = viewRect(pose, aspect);

    const parts: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`,
      `<defs>${boardDefs(boardStyle)}${backgroundDefs(bg)}</defs>`,
      defs,
      // 画布层：内容与画板底色都在这一层，随镜头移动
      `<g transform="${cameraTransform(pose, L.width, L.height)}">`,
      boardSurfaceSvg(view.x, view.y, view.w, view.h),
      backgroundSvg(bg, view.x, view.y, view.w, view.h),
    ];

    for (const p of storyboard.placed) {
      if (t < p.start) continue;
      // 画面外的段落整段跳过：无限画布上讲过的都留着，全画一遍会让帧尺寸
      // 随进度线性上涨，而看不见的部分一个像素都不贡献
      if (!cellVisible(p.cell, pose, aspect)) continue;
      const body = p.els.map((el) => el.svg(t)).join("");
      if (body !== "") parts.push(body);
    }

    // 段间连接箭头：横跨两格，不按格剔除（见 Storyboard.links 的注释）
    for (const link of storyboard.links) {
      const body = link.svg(t);
      if (body !== "") parts.push(body);
    }

    // 帧装配规则：**手势优先**，否则回退到书写光标跟着笔尖
    const cue = activeHandCue(storyboard.elements, t);
    if (cue !== null) {
      parts.push(handCueSvg(cue));
    } else {
      const pose2 = penPoseAt(t, storyboard.penElements, PEN_POSE_SAMPLE_FPS);
      if (pose2 !== null && kit.write !== null) {
        parts.push(
          handCueSvg({
            rt: kit.write,
            x: pose2.x,
            y: pose2.y,
            lift: pose2.lift,
          }),
        );
      }
    }
    parts.push(`</g>`);

    // 屏幕固定层：画面边框与字幕不随镜头动
    parts.push(boardOverlaySvg(0, 0, L.width, L.height, boardStyle));
    if (burnSubtitles) parts.push(subs.svg(t));
    parts.push(`</svg>`);
    return parts.join("\n");
  };
}

/** SVG → PNG，先写 `.tmp` 再 rename（半张图不会被当成有效帧）. */
export async function rasterize(svg: string, outPath: string): Promise<void> {
  let png: Uint8Array;
  try {
    png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  } catch (cause) {
    throw new RenderError(`帧栅格化失败: ${basename(outPath)}`, { cause });
  }
  const tmp = `${outPath}.tmp`;
  try {
    await writeFile(tmp, png);
    await rename(tmp, outPath);
  } catch (cause) {
    throw new IoError(`帧写入失败: ${outPath}`, { cause });
  }
}

export interface RenderFramesOpts {
  framesDir: string;
  totalSec: number;
  frameSvg: (t: number) => string;
  /** 从零重渲；默认续跑（已存在的帧跳过）. */
  fresh?: boolean;
  fps?: number;
  log?: Log;
}

export interface RenderFramesResult {
  framesDir: string;
  totalFrames: number;
  rendered: number;
  skipped: number;
  fps: number;
  /** `ffmpeg -i` 用的帧序列模式. */
  pattern: string;
}

/** 帧文件名（零填充 5 位，与 `p-%05d.png` 对应）. */
export function framePath(framesDir: string, frame: number): string {
  return join(framesDir, `p-${String(frame).padStart(5, "0")}.png`);
}

/**
 * 逐帧渲染。
 *
 * 默认**续跑**：已经存在的帧跳过。整片一万六千帧要渲近一小时，中途因为
 * ffmpeg 参数、音轨、或者别的进程干扰失败一次就全部重来，代价太高。
 * `fresh` 强制从零重渲（改了版式或配音后必须用它，否则会混进旧帧）。
 */
export async function renderFrames(
  opts: RenderFramesOpts,
): Promise<RenderFramesResult> {
  const log = opts.log ?? silent;
  const fps = opts.fps ?? DEFAULT_FPS;
  const fresh = opts.fresh ?? false;
  if (fresh) await rm(opts.framesDir, { recursive: true, force: true });
  await mkdir(opts.framesDir, { recursive: true });

  const totalFrames = Math.round(opts.totalSec * fps);
  const started = Date.now();
  let rendered = 0;
  let skipped = 0;
  for (let f = 0; f < totalFrames; f++) {
    const path = framePath(opts.framesDir, f);
    if (!fresh && existsSync(path)) {
      skipped++;
      continue;
    }
    await rasterize(opts.frameSvg(f / fps), path);
    rendered++;
    if (rendered % 150 === 1) log(`  帧 ${f}/${totalFrames}`);
  }
  log(
    `  ${totalFrames} 帧（新渲 ${rendered}，复用 ${skipped}）` +
      (rendered > 0
        ? `，${((Date.now() - started) / rendered).toFixed(0)}ms/帧`
        : ""),
  );

  return {
    framesDir: opts.framesDir,
    totalFrames,
    rendered,
    skipped,
    fps,
    pattern: join(opts.framesDir, "p-%05d.png"),
  };
}

/**
 * 合成前的帧序列完整性自检。
 *
 * ffmpeg 对 `-i p-%05d.png` 缺帧的报错是 `No such file or directory`：既看
 * 不出缺的是哪一帧，也看不出缺了多少，而上游日志会显示"16137 帧"成功。
 * 实测被另一个进程 `rm -rf` 掉前 3804 帧后，这个组合几乎无法定位。
 *
 * @throws RenderError 缺帧时报出缺几帧、前几个缺号，以及"重跑即可补齐"。
 */
export function assertFramesComplete(
  framesDir: string,
  totalFrames: number,
): void {
  const missing: number[] = [];
  for (let f = 0; f < totalFrames; f++) {
    if (!existsSync(framePath(framesDir, f))) missing.push(f);
  }
  if (missing.length === 0) return;
  const head = missing.slice(0, 5).join(",");
  throw new RenderError(
    `帧序列不完整：缺 ${missing.length} 帧（${head}${missing.length > 5 ? "…" : ""}）。` +
      `帧目录 ${framesDir} 可能被其他进程清理过；重跑本命令即可补齐`,
  );
}

export interface StillsOpts {
  stillsDir: string;
  tag: string;
  storyboard: Storyboard;
  /** 每段配音时长（用来取"讲到一半"的时刻）. */
  sectionAudioSec: readonly number[];
  frameSvg: (t: number) => string;
  log?: Log;
}

/**
 * 关键帧：每段一张"讲到一半"、每次转场一张"擦到一半"、加一张收尾。
 *
 * 这是唯一一个能在几秒内看清全片版式的手段 —— 渲整片要一小时，目视复核
 * 一次的代价必须压到分钟以内，否则版式调整会退化成盲改。
 */
export async function renderStills(opts: StillsOpts): Promise<string[]> {
  const log = opts.log ?? silent;
  await mkdir(opts.stillsDir, { recursive: true });
  const shots: Array<[string, number]> = [];
  for (const p of opts.storyboard.placed) {
    const audio = opts.sectionAudioSec[p.index] ?? 0;
    shots.push([`s${p.index}-talk`, p.start + audio * 0.55]);
    if (p.wipe !== null) {
      shots.push([`s${p.index}-wipe`, p.wipe.t0 + WIPE_SEC * 0.55]);
    }
  }
  shots.push(["final", opts.storyboard.totalSec - 0.2]);

  const written: string[] = [];
  for (const [name, t] of shots) {
    const path = join(opts.stillsDir, `${opts.tag}-${name}.png`);
    await rasterize(opts.frameSvg(t), path);
    written.push(path);
  }
  log(`→ ${opts.stillsDir}/${opts.tag}-*.png（${written.length} 张）`);
  return written;
}
