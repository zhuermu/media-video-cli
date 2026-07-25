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
import { DEFAULT_FPS, penPoseAt } from "../whiteboard/index";
import {
  BOARD_PAPER,
  boardDefs,
  boardOverlaySvg,
  boardSurfaceSvg,
} from "./board";
import { WIPE_SEC } from "./compose";
import type { Storyboard } from "./compose";
import { chromeSvg } from "./format";
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
  const subs = subtitleEl(storyboard.subtitles, {
    width: L.width,
    height: L.height,
  });
  const defs = storyboard.illustrations.map((il) => flatDefs(il)).join("");

  return function frameSvg(t: number): string {
    const parts: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`,
      `<defs>${boardDefs(BOARD_PAPER)}</defs>`,
      defs,
      boardSurfaceSvg(0, 0, L.width, L.height),
    ];

    for (const p of storyboard.placed) {
      if (t < p.start) continue;
      const body = p.els.map((el) => el.svg(t)).join("");
      if (body === "") continue;
      const mask = p.wipe?.wipeMask(t) ?? null;
      // 擦除中/擦完：整段内容套遮罩（遮罩必须在生成时挂上，见 boardWipeEl）
      parts.push(
        mask === null
          ? body
          : `${mask.defs}<g mask="url(#${mask.id})">${body}</g>`,
      );
      if (format.chrome && (mask === null || t < (p.wipe?.t1 ?? Infinity))) {
        parts.push(
          chromeSvg(L, {
            title,
            index: p.index + 1,
            total: storyboard.placed.length,
            color: ink,
            accent,
          }),
        );
      }
    }

    // 帧装配规则：**手势优先**，否则回退到书写手跟着笔尖
    const cue = activeHandCue(storyboard.elements, t);
    if (cue !== null) {
      parts.push(handCueSvg(cue));
    } else {
      const pose = penPoseAt(t, storyboard.penElements, PEN_POSE_SAMPLE_FPS);
      if (pose !== null && kit.write !== null) {
        parts.push(
          handCueSvg({ rt: kit.write, x: pose.x, y: pose.y, lift: pose.lift }),
        );
      }
    }
    parts.push(boardOverlaySvg(0, 0, L.width, L.height, BOARD_PAPER));
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
