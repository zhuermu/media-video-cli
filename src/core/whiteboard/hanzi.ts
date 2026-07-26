/**
 * @module @core/whiteboard (hanzi)
 *
 * 真笔顺手写文本元素：hanzi-writer-data（Make Me a Hanzi 派生，逐字
 * 笔画轮廓 + 中线）驱动，轮廓 clipPath + 粗中线 dasharray 逐笔揭示。
 *
 * 质感升级点（维度 B：手写节奏）：
 * - 笔画时长 ∝ 弧长^0.72（短笔画不再快得像闪烁，长笔画不拖）；
 * - 笔画间 55ms、字间 120ms 的换笔停顿（真人书写的呼吸）；
 * - 笔画内 easeInOutSine（起笔慢-行笔快-收笔慢）；
 * - 非 CJK 字符（数字/英文/标点）无笔顺数据，回退为「clip 扫掠揭示」，
 *   与手写字混排不违和。字库缺字同样走回退，不抛错。
 *
 * 纯度：字形 JSON 经 require 静态数据导入（确定性、无用户路径），
 * 加载在元素构造期一次完成；svg(t)/pen(t) 为纯函数。
 */

import { createRequire } from "node:module";

import {
  glyphVector,
  handwritingGlyphContours,
  handwritingGlyphVector,
  snapToInk,
} from "./glyphs";
import type { Pt } from "./geometry";
import {
  clamp01,
  cumLengths,
  easeInOutSine,
  fmt,
  hashSeed,
  mulberry32,
  pointAtLength,
  polylineAttr,
} from "./geometry";
import type { TimelineEl } from "./types";

const require = createRequire(import.meta.url);

/** hanzi-writer-data 单字数据 shape. */
interface HanziGlyph {
  strokes: string[];
  medians: [number, number][][];
}

const glyphCache = new Map<string, HanziGlyph | null>();

/** 读取单字笔顺数据；缺字返回 null（调用方回退扫掠）. */
export function loadGlyph(char: string): HanziGlyph | null {
  const hit = glyphCache.get(char);
  if (hit !== undefined) return hit;
  let g: HanziGlyph | null;
  try {
    g = require(`hanzi-writer-data/${char}.json`) as HanziGlyph;
  } catch {
    g = null;
  }
  glyphCache.set(char, g);
  return g;
}

/** 揭示中线的粗细（字形 1024 坐标系单位；被轮廓 clip 兜底）. */
const REVEAL_STROKE_WIDTH = 260;

/** 笔画间停顿（秒）. */
const STROKE_GAP_SEC = 0.055;

/** 字间停顿（秒）. */
const CHAR_GAP_SEC = 0.12;

/** 笔画时长的弧长指数（<1：压缩长短差距）. */
const LEN_EXPONENT = 0.72;

/** 非 CJK 字符宽度因子（相对字号；字体缺失时的近似回退）. */
function charWidthFactor(ch: string): number {
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.54;
  if (/[.,;:!'’‘]/.test(ch)) return 0.3;
  if (/\s/.test(ch)) return 0.4;
  return 1; // CJK 及其他全宽
}

/**
 * 字符实际宽度。
 *
 * 排版口径必须跟**画面上真正画出来的那个字形**一致。CJK 的字形来自手写字体
 * （见 `hanziTextEl`：字形取自手写字体，中线取自楷体笔顺数据），所以宽度也要
 * 用手写字体的步进宽度，而不是"CJK 一律全宽 = 字号"。
 *
 * 之前硬编码全宽，在霞鹜文楷下正好对（它的 CJK 步进就是 1.0 em），换成站酷
 * 快乐体（0.92 em）后每个字凭空多出 8% 字号的空隙：整行字距偏松，而且因为
 * 各字左右侧边距不同，松出来的量看起来忽大忽小，读作"字距不匀"。
 *
 * 手写字体缺字时才退回全宽——此时字形由楷体笔画轮廓兜底，全宽才是对的口径。
 */
function charWidth(ch: string, size: number): number {
  if (/\s/.test(ch)) return size * 0.4;
  const hw = handwritingGlyphVector(ch, size);
  if (hw !== null) return hw.advance;
  if (loadGlyph(ch) !== null) return size;
  const gv = glyphVector(ch, size);
  return gv !== null ? gv.advance : size * charWidthFactor(ch);
}

export interface HanziTextOpts {
  /** 首字符字框左上角画布坐标. */
  x: number;
  y: number;
  /** 单字字框边长 px. */
  size: number;
  /** 字间距 px. */
  gap: number;
  t0: number;
  /** 每个 CJK 字的基准书写秒数（非 CJK 按宽度折算 45%）. */
  perChar: number;
  color: string;
  /** 非 CJK 回退渲染的字体族. */
  fontFamily: string;
  /** clipPath id 前缀（全文档唯一）. */
  idp: string;
}

/** 文本行的度量结果（自动版式用；宽度与元素构造完全一致）. */
export function measureHanziText(
  text: string,
  size: number,
  gap: number,
): number {
  const chars = [...text];
  let w = 0;
  for (const [i, ch] of chars.entries()) {
    w += charWidth(ch, size);
    if (i < chars.length - 1) w += gap;
  }
  return w;
}

interface StrokePlan {
  outline: string;
  medianRaw: Pt[];
  rawCum: number[];
  rawTotal: number;
  medianCanvas: Pt[];
  canvasCum: number[];
  /** 字内时间窗（秒，相对字起点，已含换笔停顿）. */
  tStart: number;
  tEnd: number;
  /** 笔画微错位（字形坐标单位；真人笔画间的组装误差）. */
  sdx: number;
  sdy: number;
}

/**
 * 单字手写抖动（去"打印感"的关键）：微旋转 + 微缩放 + 基线浮动 +
 * 水平漂移，绕字框中心施加；同字不同位置种子不同 → 每次出现都不一样。
 */
interface CharJitter {
  rotDeg: number;
  scale: number;
  dx: number;
  dy: number;
  /** 字框中心（旋转/缩放锚点，画布坐标）. */
  cx: number;
  cy: number;
}

/** 字抖动幅表：旋转 ±2.2°、缩放 ±3%、基线 ±3.5% 字号、水平 ±2.5px. */
function charJitter(
  seed: number,
  cx: number,
  cy: number,
  size: number,
): CharJitter {
  const rnd = mulberry32(seed);
  return {
    rotDeg: (rnd() * 2 - 1) * 2.2,
    scale: 1 + (rnd() * 2 - 1) * 0.03,
    dx: (rnd() * 2 - 1) * 2.5,
    dy: (rnd() * 2 - 1) * size * 0.035,
    cx,
    cy,
  };
}

/** 抖动的 SVG transform 串（canvas = C+J + R·S·(base − C)）. */
function jitterTransform(j: CharJitter): string {
  return (
    `translate(${fmt(j.cx + j.dx)},${fmt(j.cy + j.dy)}) ` +
    `rotate(${fmt(j.rotDeg)}) scale(${fmt(j.scale)}) ` +
    `translate(${fmt(-j.cx)},${fmt(-j.cy)})`
  );
}

/** 对画布坐标点施加字抖动（与 jitterTransform 数学一致——笔尖对位）. */
function applyJitter(j: CharJitter, [x, y]: Pt): Pt {
  const rad = (j.rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = x - j.cx;
  const ry = y - j.cy;
  return [
    j.cx + j.dx + (rx * cos - ry * sin) * j.scale,
    j.cy + j.dy + (rx * sin + ry * cos) * j.scale,
  ];
}

interface CharPlan {
  kind: "hanzi" | "sweep";
  x0: number;
  width: number;
  char: string;
  /** 元素时间轴上的字起止（秒，相对元素 t0）. */
  cStart: number;
  cEnd: number;
  strokes: StrokePlan[]; // sweep 时为空
  /** sweep 字符的矢量轮廓（null = 无字体，末路回退 <text>）. */
  vec?: { d: string; advance: number } | null;
  /**
   * 手写字体字形（CJK；null = 无手写字体 → 回退楷体笔画轮廓渲染）。
   * 有值时：字形来自手写字体，笔顺数据只做揭示遮罩 + 笔尖轨迹——
   * "写什么样"与"怎么写"分离。
   */
  hw?: { d: string; advance: number } | null;
  /** 单字手写抖动（去打印感）. */
  jit: CharJitter;
  /** 手写字形墨区轮廓（笔尖吸附用；无手写字体时 null）. */
  ink?: Pt[][] | null;
}

/** 遮罩揭示中线的粗细（要盖住手写体偏离楷体中线的笔画，且不过宽误揭邻笔）. */
const MASK_REVEAL_WIDTH = 280;

/** 已完成笔画在遮罩里的轮廓膨胀（字形坐标单位）. */
const MASK_DILATE = 48;

/**
 * 手写文本元素（单行）：CJK 真笔顺、其余扫掠揭示，混排统一节奏。
 * XML 注入防御：非 CJK 回退经 escapeXmlText 处理（BR-U4-7 同款）。
 */
export function hanziTextEl(text: string, o: HanziTextOpts): TimelineEl {
  const chars = [...text];
  const scale = o.size / 1024;
  const plans: CharPlan[] = [];

  let cursorX = o.x;
  let cursorT = 0;
  for (const ch of chars) {
    const width = charWidth(ch, o.size);
    const glyph = /\s/.test(ch) ? null : loadGlyph(ch);
    // 抖动种子含字符与位置：同字不同位置写出来不一样
    const jit = charJitter(
      hashSeed(`${o.idp}:${ch}:${Math.round(cursorX)}`),
      cursorX + width / 2,
      o.y + o.size / 2,
      o.size,
    );
    if (glyph !== null) {
      // —— 真笔顺：按弧长^0.72 分配字内时长，笔画间插入停顿 ——
      const yBase = o.y + 900 * scale;
      const jrnd = mulberry32(hashSeed(`${o.idp}:${ch}:${cursorX}:strokes`));
      const raws = glyph.medians.map((m) => m.map(([a, b]) => [a, b] as Pt));
      const weights = raws.map((m) => {
        const cum = cumLengths(
          m.map(([gx, gy]) => [gx * scale, gy * scale] as Pt),
        );
        return Math.pow(Math.max(1, cum[cum.length - 1]!), LEN_EXPONENT);
      });
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const gaps = STROKE_GAP_SEC * (raws.length - 1);
      const writeBudget = Math.max(0.12, o.perChar - gaps);

      // 画面上显现的字形来自手写字体，而中线来自楷体笔顺数据——笔尖轨迹
      // 要吸附到手写字形的墨区上，否则笔尖会悬在自己写的那一笔旁边
      const hw = handwritingGlyphVector(ch, o.size);
      const inkPolys =
        hw === null ? null : handwritingGlyphContours(ch, o.size);
      // 吸附半径 = 遮罩揭示半宽：超出这个距离的墨本来就没被揭示，
      // 拉过去只会把笔尖挪到一笔无关的墨上
      const snapR = (MASK_REVEAL_WIDTH / 2) * scale;

      const strokes: StrokePlan[] = [];
      let t = 0;
      for (let k = 0; k < raws.length; k++) {
        const dur = (writeBudget * weights[k]!) / weightSum;
        // 笔画微错位（字形坐标 ±9 单位 ≈ 字号的 ±0.9%）
        const sdx = (jrnd() * 2 - 1) * 9;
        const sdy = (jrnd() * 2 - 1) * 9;
        const medianRaw = raws[k]!;
        /**
         * 中线采样 → 画布坐标。
         *
         * 有手写字形时**不**叠加 sdx/sdy：这对偏移只作用在遮罩上（让
         * 揭示区域略微错位以显手写感），字形本体没动，笔尖跟着它跑反而
         * 会离开墨迹。
         */
        const toCanvas = ([gx, gy]: Pt): Pt => {
          if (inkPolys !== null) {
            const local = snapToInk(
              inkPolys,
              [gx * scale, (900 - gy) * scale],
              snapR,
            );
            return applyJitter(jit, [cursorX + local[0], o.y + local[1]]);
          }
          return applyJitter(jit, [
            cursorX + (gx + sdx) * scale,
            yBase - (gy + sdy) * scale,
          ]);
        };
        const medianCanvas = medianRaw.map(toCanvas);
        const rawCum = cumLengths(medianRaw);
        strokes.push({
          outline: glyph.strokes[k]!,
          medianRaw,
          rawCum,
          rawTotal: rawCum[rawCum.length - 1]!,
          medianCanvas,
          canvasCum: cumLengths(medianCanvas),
          tStart: t,
          tEnd: t + dur,
          sdx,
          sdy,
        });
        t += dur + (k < raws.length - 1 ? STROKE_GAP_SEC : 0);
      }
      plans.push({
        kind: "hanzi",
        x0: cursorX,
        width,
        char: ch,
        cStart: cursorT,
        cEnd: cursorT + o.perChar,
        strokes,
        hw,
        jit,
      });
      cursorT += o.perChar + CHAR_GAP_SEC;
    } else {
      // —— 回退扫掠：窄字符按宽度折算时长（约为 CJK 的 45%） ——
      const dur = /\s/.test(ch)
        ? 0.04
        : Math.max(0.08, (o.perChar * 0.45 * width) / o.size);
      plans.push({
        kind: "sweep",
        x0: cursorX,
        width,
        char: ch,
        cStart: cursorT,
        cEnd: cursorT + dur,
        strokes: [],
        vec: /\s/.test(ch) ? null : glyphVector(ch, o.size),
        jit,
        ink: /\s/.test(ch) ? null : handwritingGlyphContours(ch, o.size),
      });
      cursorT += dur + CHAR_GAP_SEC * 0.4;
    }
    cursorX += width + o.gap;
  }

  const totalDur = Math.max(0.1, cursorT - CHAR_GAP_SEC);
  const t1 = o.t0 + totalDur;
  const fontAttr = `font-family="${escapeXmlText(o.fontFamily)}, sans-serif"`;

  function charSvg(cp: CharPlan, rel: number, done: boolean): string {
    if (cp.kind === "sweep") {
      if (/\s/.test(cp.char)) return "";
      const p = done
        ? 1
        : clamp01((rel - cp.cStart) / Math.max(1e-6, cp.cEnd - cp.cStart));
      if (p <= 0) return "";
      const id = `${o.idp}sw${Math.round(cp.x0)}`;
      const clipW = cp.width * easeInOutSine(p) + o.size * 0.06;
      const clip = `<clipPath id="${id}"><rect x="${fmt(cp.x0 - o.size * 0.03)}" y="${fmt(o.y - o.size * 0.1)}" width="${fmt(clipW)}" height="${fmt(o.size * 1.25)}"/></clipPath>`;
      const openJit = `<g transform="${jitterTransform(cp.jit)}">`;
      if (cp.vec != null) {
        // 矢量轮廓（规划期 opentype 转换）——帧栅格化零字体依赖。
        // 注意：clip-path 必须挂在**不带 transform 的外层组**上——resvg
        // 会把 clip 坐标解析进同元素 transform 之后的局部空间，二者同挂
        // 一个元素时画布坐标的裁剪框整体错位，字形被裁空（曾致拉丁
        // 字母/数字全部隐形）。
        return (
          clip +
          openJit +
          `<g clip-path="url(#${id})"><g transform="translate(${fmt(cp.x0)},${fmt(o.y)})"><path d="${cp.vec.d}" fill="${o.color}"/></g></g></g>`
        );
      }
      // 末路回退：<text> 节点（需帧栅格化注入带字体的 rasterize）
      return (
        clip +
        openJit +
        `<text clip-path="url(#${id})" x="${fmt(cp.x0)}" y="${fmt(o.y + o.size * 0.82)}" ${fontAttr} font-size="${fmt(o.size)}" fill="${o.color}">${escapeXmlText(cp.char)}</text></g>`
      );
    }
    // hanzi：外层字抖动 transform；字形来源二选一——
    // hw ≠ null：手写字体字形 + 笔顺遮罩揭示（"写什么样"来自手写体）
    // hw = null：楷体笔画轮廓逐笔渲染（无手写字体的回退）
    const yBase = o.y + 900 * scale;
    const sRelC = rel - cp.cStart;

    if (cp.hw != null) {
      const glyphEl = `<g transform="translate(${fmt(cp.x0)},${fmt(o.y)})"><path d="${cp.hw.d}" fill="${o.color}"/></g>`;
      const lastEnd = cp.strokes[cp.strokes.length - 1]!.tEnd;
      if (done || sRelC >= lastEnd) {
        // 完成态：直接画手写字形（无遮罩，快路径）
        return `<g transform="${jitterTransform(cp.jit)}">${glyphEl}</g>`;
      }
      // 书写中：遮罩 = 已完成笔画轮廓（膨胀）+ 当前笔画中线 dasharray
      const id = `${o.idp}m${Math.round(cp.x0)}`;
      const maskParts: string[] = [
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="${fmt(cp.x0 - o.size * 0.15)}" y="${fmt(o.y - o.size * 0.15)}" width="${fmt(o.size * 1.3)}" height="${fmt(o.size * 1.3)}">`,
        `<g transform="translate(${fmt(cp.x0)},${fmt(yBase)}) scale(${fmt(scale)},${fmt(-scale)})">`,
      ];
      for (const st of cp.strokes) {
        const openStroke = `<g transform="translate(${fmt(st.sdx)},${fmt(st.sdy)})">`;
        if (sRelC >= st.tEnd) {
          // 单调性不变式（防闪烁）：完成笔画的遮罩 = 轮廓（膨胀）∪ 完整
          // 中线（与书写中同宽）——揭示区域只增不减，书写中扫出的每个
          // 像素在完成后仍被覆盖
          maskParts.push(
            `${openStroke}<path d="${st.outline}" fill="#fff" stroke="#fff" stroke-width="${MASK_DILATE}"/>` +
              `<polyline points="${polylineAttr(st.medianRaw)}" fill="none" stroke="#fff" stroke-width="${MASK_REVEAL_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/></g>`,
          );
        } else if (sRelC > st.tStart) {
          const local = easeInOutSine(
            clamp01((sRelC - st.tStart) / (st.tEnd - st.tStart)),
          );
          const drawn = local * st.rawTotal;
          maskParts.push(
            `${openStroke}<polyline points="${polylineAttr(st.medianRaw)}" fill="none" stroke="#fff" stroke-width="${MASK_REVEAL_WIDTH}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${fmt(drawn)} ${fmt(st.rawTotal + MASK_REVEAL_WIDTH)}"/></g>`,
          );
          break;
        } else {
          break;
        }
      }
      maskParts.push(`</g></mask>`);
      return `<g transform="${jitterTransform(cp.jit)}">${maskParts.join("")}<g mask="url(#${id})">${glyphEl}</g></g>`;
    }

    // 回退：楷体笔画轮廓逐笔（clip + 中线揭示）
    const parts: string[] = [
      `<g transform="${jitterTransform(cp.jit)}">`,
      `<g transform="translate(${fmt(cp.x0)},${fmt(yBase)}) scale(${fmt(scale)},${fmt(-scale)})">`,
    ];
    for (let k = 0; k < cp.strokes.length; k++) {
      const st = cp.strokes[k]!;
      const sRel = rel - cp.cStart;
      const openStroke = `<g transform="translate(${fmt(st.sdx)},${fmt(st.sdy)})">`;
      if (done || sRel >= st.tEnd) {
        parts.push(
          `${openStroke}<path d="${st.outline}" fill="${o.color}"/></g>`,
        );
      } else if (sRel > st.tStart) {
        const local = easeInOutSine(
          clamp01((sRel - st.tStart) / (st.tEnd - st.tStart)),
        );
        const drawn = local * st.rawTotal;
        const id = `${o.idp}c${Math.round(cp.x0)}s${k}`;
        parts.push(
          `${openStroke}<clipPath id="${id}"><path d="${st.outline}"/></clipPath>`,
          `<polyline clip-path="url(#${id})" points="${polylineAttr(st.medianRaw)}" fill="none" stroke="${o.color}" stroke-width="${REVEAL_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${fmt(drawn)} ${fmt(st.rawTotal + REVEAL_STROKE_WIDTH)}"/></g>`,
        );
        break;
      } else {
        break;
      }
    }
    parts.push("</g></g>");
    return parts.join("");
  }

  const el: TimelineEl = {
    t0: o.t0,
    t1,
    svg(t) {
      if (t < o.t0) return "";
      const rel = t - o.t0;
      const done = t >= t1;
      const parts: string[] = [];
      for (const cp of plans) {
        if (!done && rel < cp.cStart) break;
        parts.push(charSvg(cp, rel, done || rel >= cp.cEnd));
      }
      return parts.join("");
    },
    pen(t) {
      if (t < o.t0 || t > t1) return null;
      const rel = t - o.t0;
      // 定位当前字
      let cp = plans[plans.length - 1]!;
      for (const cand of plans) {
        if (rel <= cand.cEnd || cand === plans[plans.length - 1]) {
          if (rel <= cand.cEnd) {
            cp = cand;
            break;
          }
        }
        if (rel < cand.cStart) {
          cp = cand;
          break;
        }
      }
      if (cp.kind === "sweep") {
        const p = clamp01(
          (rel - cp.cStart) / Math.max(1e-6, cp.cEnd - cp.cStart),
        );
        // 扫掠揭示的墨迹前沿在 clip 右边缘；纵向落点没有笔顺可依，
        // 就吸附到该处的字形墨上（拉丁字母高低差很大，固定 0.78 会让
        // 笔尖在 "o" 上偏低、在 "l" 上偏高）
        const localX = cp.width * easeInOutSine(p);
        const local: Pt =
          cp.ink != null && cp.ink.length > 0
            ? snapToInk(cp.ink, [localX, o.size * 0.78], o.size * 0.5)
            : [localX, o.size * 0.78];
        return applyJitter(cp.jit, [cp.x0 + local[0], o.y + local[1]]);
      }
      const sRel = clamp01Range(rel - cp.cStart, 0, cp.cEnd - cp.cStart);
      let st = cp.strokes[cp.strokes.length - 1]!;
      for (const cand of cp.strokes) {
        if (sRel <= cand.tEnd) {
          st = cand;
          break;
        }
      }
      const local = easeInOutSine(
        clamp01((sRel - st.tStart) / Math.max(1e-6, st.tEnd - st.tStart)),
      );
      const total = st.canvasCum[st.canvasCum.length - 1]!;
      return pointAtLength(st.medianCanvas, st.canvasCum, local * total);
    },
  };
  return el;
}

function clamp01Range(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** XML 文本节点转义（BR-U4-7 同款五字符防御）. */
export function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
