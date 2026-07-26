/**
 * @module @core/whiteboard (glyphs)
 *
 * 非 CJK 字形矢量化：opentype.js 在规划期把数字/英文/标点转成 SVG
 * 轮廓路径（d + 实际步进宽度），帧栅格化因此走**无字体快路径**——
 * resvg 不再逐帧解析系统字体文件（80MB 的 PingFang.ttc 逐帧解析曾
 * 导致 0.66s/帧的性能退化）。
 *
 * 字体解析一次、进程内缓存；候选表里没有可用字体时返回 null，调用方
 * 回退近似宽度表 + <text> 节点（此时帧渲染需注入带字体的 rasterize）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import opentype from "opentype.js";

import type { Pt } from "./geometry";

/** 候选回退字体（可被 glyphFontPath 覆盖；TTC 不受 opentype.js 支持）. */
const CANDIDATE_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Tahoma.ttf",
  "/System/Library/Fonts/Supplemental/Verdana.ttf",
];

/** 手写字体目录（随仓库分发清单，二进制按 manifest 下载）. */
export const HANDWRITING_FONT_DIR = fileURLToPath(
  new URL("../../../assets/fonts/", import.meta.url),
);

let fontCache: opentype.Font | null | undefined;
let fontPathOverride: string | undefined;
let hwFontCache: opentype.Font | null | undefined;
let hwPathOverride: string | null | undefined;

/** 三个字形缓存都随字体覆盖一起失效（见 setHandwritingFontPath）. */
const contourCache = new Map<string, Pt[][] | null>();

/** 覆盖候选字体（测试/非 macOS 环境注入用）；重置缓存. */
export function setGlyphFontPath(path: string | undefined): void {
  fontPathOverride = path;
  fontCache = undefined;
  vectorCache.clear();
}

/**
 * 覆盖手写字体：string = 指定文件；null = 禁用（测试楷体回退分支用）；
 * undefined = 恢复默认目录扫描。重置缓存。
 */
export function setHandwritingFontPath(path: string | null | undefined): void {
  hwPathOverride = path;
  hwFontCache = undefined;
  vectorCache.clear();
  hwVectorCache.clear();
  contourCache.clear();
}

function parseFontFile(path: string): opentype.Font | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    return opentype.parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
  } catch {
    return null;
  }
}

/**
 * 惰性加载手写字体（assets/fonts/ 字典序第一个可解析的 .ttf/.otf）。
 * 缺字体 → null（渲染回退楷体笔画轮廓，不报错）。
 */
export function handwritingFont(): opentype.Font | null {
  if (hwFontCache !== undefined) return hwFontCache;
  if (hwPathOverride === null) {
    hwFontCache = null;
    return null;
  }
  if (typeof hwPathOverride === "string") {
    hwFontCache = parseFontFile(hwPathOverride);
    return hwFontCache;
  }
  for (const f of handwritingFontCandidates()) {
    const font = parseFontFile(join(HANDWRITING_FONT_DIR, f));
    if (font !== null) {
      hwFontCache = font;
      return font;
    }
  }
  hwFontCache = null;
  return null;
}

/**
 * 手写字体的尝试顺序：**先按 manifest.json 的 `entries` 顺序**，再补上目录里
 * 其余可解析的文件（字典序）。
 *
 * 早先只做"目录字典序第一个"。那等于让**文件名的字母顺序**决定全片字体：
 * 往 `assets/fonts/` 放一支新字体时，它是否生效取决于名字排在原字体前面还是
 * 后面——`LXGWWenKai` 与 `ZCOOLKuaiLe` 这一对，新字体永远不会被选中，而且
 * 没有任何报错。字体是全片最显眼的视觉决策，不能由文件名排序隐式决定。
 *
 * manifest 缺失或读不动时退回纯字典序（与旧行为一致），不抛错：字体是可降级
 * 的（缺字体会回退楷体笔画轮廓）。
 */
export function handwritingFontCandidates(): string[] {
  let present: string[] = [];
  try {
    present = readdirSync(HANDWRITING_FONT_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
  const ordered: string[] = [];
  for (const file of manifestFontOrder()) {
    if (present.includes(file) && !ordered.includes(file)) ordered.push(file);
  }
  for (const file of present) {
    if (!ordered.includes(file)) ordered.push(file);
  }
  return ordered;
}

/** manifest.json 里 `entries[].file` 的声明顺序（读不动则空表）. */
function manifestFontOrder(): string[] {
  try {
    const raw = readFileSync(
      join(HANDWRITING_FONT_DIR, "manifest.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((e) =>
        e !== null && typeof e === "object"
          ? (e as { file?: unknown }).file
          : undefined,
      )
      .filter((f): f is string => typeof f === "string");
  } catch {
    return [];
  }
}

/** 手写字体基线位置（字框顶起算的字号比例；对齐楷体 900/1024 布局）. */
const HW_BASELINE_RATIO = 0.88;

// ---- 设计稿 2.0 §11：中英文字体配对 ----

/**
 * 拉丁字形专用的手写字体（可选）。
 *
 * 设计稿 §11 把字体推荐分成**中文**（站酷快乐体等）和**英文**（Patrick Hand /
 * Kalam / Caveat / Indie Flower）两栏——它期望的是一套配对，不是一支字体包打
 * 天下。理由很实际：中文手写体自带的拉丁字形通常是顺手做的，字宽和风格都和
 * 专门的英文手写体差一截，而技术类讲解里满屏都是 `ID token`、`OIDC` 这种拉丁
 * 词，它们的观感直接决定画面档次。
 *
 * 实现是"按字符所属书写系统挑字体"：CJK 走主字体，其余走拉丁字体（若配了）。
 * 基线共用 {@link HW_BASELINE_RATIO}，所以混排不跳行。
 *
 * 没配拉丁字体时**整套退回主字体**（现状行为不变），不报错——字体是可降级的。
 */
let latinFontCache: opentype.Font | null | undefined;
let latinPathOverride: string | null | undefined;

/**
 * 覆盖拉丁手写字体：string = 指定文件；null = 禁用（拉丁也用主字体）；
 * undefined = 恢复默认（读 manifest 的 `scripts` 声明）。重置缓存。
 */
export function setLatinFontPath(path: string | null | undefined): void {
  latinPathOverride = path;
  latinFontCache = undefined;
  vectorCache.clear();
  hwVectorCache.clear();
  contourCache.clear();
}

/**
 * 惰性加载拉丁手写字体。
 *
 * 默认从 manifest 里找第一个声明了 `"scripts": ["latin"]` 的条目——用声明而不是
 * 猜文件名，因为"这支字体只有拉丁字形"是字体的事实，应该写在清单里由人确认，
 * 而不是靠代码去嗅探（嗅探会把"CJK 覆盖不全的中文字体"误判成拉丁字体）。
 */
export function latinHandwritingFont(): opentype.Font | null {
  if (latinFontCache !== undefined) return latinFontCache;
  if (latinPathOverride === null) {
    latinFontCache = null;
    return null;
  }
  if (typeof latinPathOverride === "string") {
    latinFontCache = parseFontFile(latinPathOverride);
    return latinFontCache;
  }
  for (const file of manifestLatinFonts()) {
    const font = parseFontFile(join(HANDWRITING_FONT_DIR, file));
    if (font !== null) {
      latinFontCache = font;
      return font;
    }
  }
  latinFontCache = null;
  return null;
}

/** manifest 里声明 `scripts` 含 `"latin"` 的条目文件名（按声明顺序）. */
function manifestLatinFonts(): string[] {
  try {
    const raw = readFileSync(
      join(HANDWRITING_FONT_DIR, "manifest.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    const out: string[] = [];
    for (const e of entries) {
      if (e === null || typeof e !== "object") continue;
      const { file, scripts } = e as { file?: unknown; scripts?: unknown };
      if (typeof file !== "string" || !Array.isArray(scripts)) continue;
      if (scripts.includes("latin")) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

/** CJK 判定（含扩展 A 与兼容区；标点走拉丁那一支更好看）. */
export function isCjk(char: string): boolean {
  const c = char.codePointAt(0) ?? 0;
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

/**
 * 该字符应当用哪支手写字体。
 *
 * 非 CJK 且配了拉丁字体、且该字体真有这个字形时才用拉丁字体——最后那个条件
 * 很重要：Patrick Hand 只有 728 个字形，遇到它没有的符号（如 `→`、`·`）必须
 * 回落主字体，否则会渲成空白。
 */
function fontForChar(char: string): opentype.Font | null {
  const main = handwritingFont();
  // 主字体被显式关掉（或根本没有）时，拉丁配对也一并失效：拉丁字体是**叠加在
  // 主字体之上的配对**，不是独立的字体源。若这里仍然返回拉丁字体，"关掉手写体"
  // 就只关掉了中文，拉丁字还是手写的——同一个开关表达两种含义，调用方无法推理。
  // 此时整套走 glyphVector 的系统字体回退 / 楷体笔画轮廓。
  if (main === null) return null;
  if (!isCjk(char)) {
    const latin = latinHandwritingFont();
    if (latin !== null && latin.charToGlyph(char).index !== 0) return latin;
  }
  return main;
}

const hwVectorCache = new Map<string, GlyphVector | null>();

/**
 * 手写字体字形矢量（字框左上角为原点、基线内置在 0.88×size）。
 * 缺字体或缺字返回 null。CJK 与拉丁共用同一基线，混排不跳行。
 */
export function handwritingGlyphVector(
  char: string,
  size: number,
): GlyphVector | null {
  const key = `${char}:${size}`;
  const hit = hwVectorCache.get(key);
  if (hit !== undefined) return hit;

  // 按书写系统挑字体（CJK → 主字体，拉丁 → 配对的英文手写体）
  const font = fontForChar(char);
  let out: GlyphVector | null = null;
  if (font !== null) {
    const glyph = font.charToGlyph(char);
    if (glyph.index !== 0) {
      const upem = font.unitsPerEm;
      const d = glyph.getPath(0, HW_BASELINE_RATIO * size, size).toPathData(2);
      out = { d, advance: ((glyph.advanceWidth ?? upem * 0.5) / upem) * size };
    }
  }
  hwVectorCache.set(key, out);
  return out;
}

/** 惰性加载回退字体（解析一次）；找不到返回 null. */
export function glyphFont(): opentype.Font | null {
  if (fontCache !== undefined) return fontCache;
  const candidates =
    fontPathOverride !== undefined ? [fontPathOverride] : CANDIDATE_FONTS;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const buf = readFileSync(p);
      fontCache = opentype.parse(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      return fontCache;
    } catch {
      // 解析失败换下一个候选
    }
  }
  fontCache = null;
  return fontCache;
}

/** 一个矢量化字形：轮廓路径 + 实际步进宽度（均为目标字号坐标）. */
export interface GlyphVector {
  /** SVG path d（原点 = 字框左上角，基线已内置）. */
  d: string;
  advance: number;
}

const vectorCache = new Map<string, GlyphVector | null>();

/**
 * 字符 → 矢量轮廓（目标字号 size 的坐标系，字框左上角为原点）。
 * 解析链：手写字体（若在）→ 系统回退字体；均缺字返回 null。
 */
export function glyphVector(char: string, size: number): GlyphVector | null {
  const hw = handwritingGlyphVector(char, size);
  if (hw !== null) return hw;
  return sansGlyphVector(char, size);
}

/**
 * 字符 → 矢量轮廓，**跳过手写字体**，直接走无衬线回退字体（Arial Unicode 等）。
 *
 * 为字幕单开一条路：字幕不是白板上的内容，是叠在画面上的一层说明。两者用同一支
 * 手写体时，观众会把字幕当成"下面还写了一句话"去读——尤其字幕就压在板面内容
 * 下方几十像素处。换成无衬线，一眼就能分出"板上写的"和"字幕"。
 */
export function sansGlyphVector(
  char: string,
  size: number,
): GlyphVector | null {
  const key = `${char}:${size}`;
  const hit = vectorCache.get(key);
  if (hit !== undefined) return hit;

  const font = glyphFont();
  let out: GlyphVector | null = null;
  if (font !== null) {
    const glyph = font.charToGlyph(char);
    if (glyph.index !== 0) {
      const upem = font.unitsPerEm;
      const baseline = (font.ascender / upem) * size * 0.92;
      const d = glyph.getPath(0, baseline, size).toPathData(2);
      out = { d, advance: ((glyph.advanceWidth ?? upem * 0.5) / upem) * size };
    }
  }
  vectorCache.set(key, out);
  return out;
}

// ---- 字形墨区几何（笔尖对位用） ----

/**
 * 贝塞尔展平的采样段数。字形轮廓在 1080 宽画幅上最大也就百来像素，
 * 6 段已经到不了 0.5px 的弦误差。
 */
const FLATTEN_STEPS = 6;

/**
 * 手写字形的轮廓折线（字框左上角为原点、y 向下、已缩放到 size）。
 *
 * 与 {@link handwritingGlyphVector} 的 `d` 同一套坐标，只是换成可做
 * 几何计算的折线表示——用来判断"某个点是否落在字的墨里"。
 */
export function handwritingGlyphContours(
  char: string,
  size: number,
): Pt[][] | null {
  const key = `${char}:${size}`;
  const hit = contourCache.get(key);
  if (hit !== undefined) return hit;

  // 必须与 handwritingGlyphVector 用同一支字体：轮廓（clip）和矢量（ink）
  // 来自不同字体时，笔画揭示会被裁到另一个字形的形状里
  const font = fontForChar(char);
  let out: Pt[][] | null = null;
  if (font !== null) {
    const glyph = font.charToGlyph(char);
    if (glyph.index !== 0) {
      out = flattenPath(glyph.getPath(0, HW_BASELINE_RATIO * size, size));
    }
  }
  contourCache.set(key, out);
  return out;
}

/** opentype Path → 闭合折线组（M/L/C/Q/Z）. */
function flattenPath(path: opentype.Path): Pt[][] {
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let cx = 0;
  let cy = 0;
  const push = (x: number, y: number): void => {
    cur.push([x, y]);
    cx = x;
    cy = y;
  };
  for (const c of path.commands) {
    switch (c.type) {
      case "M":
        if (cur.length > 2) polys.push(cur);
        cur = [];
        push(c.x, c.y);
        break;
      case "L":
        push(c.x, c.y);
        break;
      case "Q":
        for (let i = 1; i <= FLATTEN_STEPS; i++) {
          const t = i / FLATTEN_STEPS;
          const u = 1 - t;
          cur.push([
            u * u * cx + 2 * u * t * c.x1 + t * t * c.x,
            u * u * cy + 2 * u * t * c.y1 + t * t * c.y,
          ]);
        }
        cx = c.x;
        cy = c.y;
        break;
      case "C":
        for (let i = 1; i <= FLATTEN_STEPS; i++) {
          const t = i / FLATTEN_STEPS;
          const u = 1 - t;
          cur.push([
            u * u * u * cx +
              3 * u * u * t * c.x1 +
              3 * u * t * t * c.x2 +
              t * t * t * c.x,
            u * u * u * cy +
              3 * u * u * t * c.y1 +
              3 * u * t * t * c.y2 +
              t * t * t * c.y,
          ]);
        }
        cx = c.x;
        cy = c.y;
        break;
      case "Z":
        if (cur.length > 2) polys.push(cur);
        cur = [];
        break;
    }
  }
  if (cur.length > 2) polys.push(cur);
  return polys;
}

/** 点是否在轮廓组内部（非零环绕数；字形轮廓自带正确绕向）. */
export function insideContours(polys: readonly Pt[][], [px, py]: Pt): boolean {
  let wind = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i]!;
      const [bx, by] = poly[(i + 1) % poly.length]!;
      if (ay <= py) {
        if (by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) {
          wind++;
        }
      } else if (
        by <= py &&
        (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0
      ) {
        wind--;
      }
    }
  }
  return wind !== 0;
}

/** 点到线段的最近点. */
function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return a;
  const t = Math.min(
    1,
    Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2),
  );
  return [a[0] + dx * t, a[1] + dy * t];
}

/**
 * 把一个点吸附到字形墨区上（已在墨内则原样返回）。
 *
 * 用途：笔尖轨迹来自 hanzi-writer 的**楷体**中线，而画面上显现的字形来自
 * **手写字体**——两套字形的笔画位置不同，笔尖因此会悬在墨迹旁边（实测
 * 竖向差 10–20px，观感是"墨落在笔尖上方"）。吸附把中线采样点拉到最近的
 * 墨边上，再沿法向往里推一点，笔尖就压在自己正在写的那一笔上。
 *
 * @param maxDist 超过这个距离就不吸附（认为该采样点与字形无对应关系，
 *   保留原位比拉到一笔无关的墨上更好）
 * @returns 吸附后的点；`polys` 为空时返回原点
 */
export function snapToInk(polys: readonly Pt[][], p: Pt, maxDist: number): Pt {
  if (polys.length === 0) return p;
  if (insideContours(polys, p)) return p;
  let best: Pt | null = null;
  let bestD2 = maxDist * maxDist;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const q = closestOnSegment(p, poly[i]!, poly[(i + 1) % poly.length]!);
      const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = q;
      }
    }
  }
  if (best === null) return p;
  // 从墨边再往里推一点：笔尖压在墨里比停在轮廓线上更像"正在写"
  const d = Math.sqrt(bestD2);
  if (d < 1e-6) return best;
  const nudge = Math.min(d, maxDist * 0.12);
  return [
    best[0] + ((best[0] - p[0]) / d) * nudge,
    best[1] + ((best[1] - p[1]) / d) * nudge,
  ];
}
