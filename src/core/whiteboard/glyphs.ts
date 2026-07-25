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
  let files: string[] = [];
  try {
    files = readdirSync(HANDWRITING_FONT_DIR)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .sort();
  } catch {
    // 目录不存在 = 无手写字体
  }
  for (const f of files) {
    const font = parseFontFile(join(HANDWRITING_FONT_DIR, f));
    if (font !== null) {
      hwFontCache = font;
      return font;
    }
  }
  hwFontCache = null;
  return null;
}

/** 手写字体基线位置（字框顶起算的字号比例；对齐楷体 900/1024 布局）. */
const HW_BASELINE_RATIO = 0.88;

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

  const font = handwritingFont();
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

  const font = handwritingFont();
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
