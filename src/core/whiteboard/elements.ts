/**
 * @module @core/whiteboard (elements)
 *
 * 时间轴元素工厂（手写文本之外的全部）：
 * - strokesEl: 多段折线依弧长顺序描线（图形/箭头/下划线/勾/元素库图标）
 * - fadeRect / fadeGroup: 描完轮廓后的淡入填充与色块装饰件（sticker）
 * - imageEl: 照片拉入（拍立得样式滑入，data URI 由调用方预读——保持
 *   svg(t) 纯函数，同 cards 的 backgroundImageDataUri 分工）
 *
 * 质感升级点（维度 C/D）：
 * - 描线用 easeInOutSine 行笔（起笔收笔减速），不再匀速；
 * - wobble 平滑噪声版（geometry.ts）；
 * - 图片滑入带轻微过冲回弹（easeOutBack 弱化版），更像"放"上去。
 */

import type { Pt } from "./geometry";
import {
  clamp01,
  cumLengths,
  easeInOutSine,
  easeOutCubic,
  fmt,
  hashSeed,
  mulberry32,
  overshootPts,
  pointAtLength,
  polylineAttr,
  resampleStep,
  slicePolyline,
  wobble,
} from "./geometry";
import { escapeXmlText } from "./hanzi";
import type { TimelineEl } from "./types";

export interface StrokesOpts {
  t0: number;
  dur: number;
  color: string;
  width: number;
  /** 抖动种子（同种子逐帧稳定）. */
  seed: string;
  /** 抖动幅度 px（0 = 不抖）. */
  amp?: number;
  /** 端点过冲（手绘的起笔/收笔越界）. 默认开. */
  overshoot?: boolean;
}

/** 多段折线依弧长比例先后描线；笔尖跟随当前描线端点. */
export function strokesEl(paths: readonly Pt[][], o: StrokesOpts): TimelineEl {
  const amp = o.amp ?? 3.0;
  const wobbled = paths.map((p, i) => {
    const seed = hashSeed(`${o.seed}:${i}`);
    // 抖动/重采样/过冲全部随路径弧长缩放：大线条有手感，小部件不变形
    const rawTotal = cumLengths(p)[p.length - 1] ?? 0;
    const ampEff = Math.min(amp, Math.max(0.6, rawTotal * 0.018));
    // 同 marker.ts：步长必须受输入细节约束，否则圆角会被抹平
    const stepEff = resampleStep(p, rawTotal);
    let pts = wobble(p, seed, { amp: ampEff, step: stepEff, wavelength: 130 });
    if (o.overshoot !== false && rawTotal > 40) {
      const rnd = mulberry32(seed ^ 0x5f3759df);
      const startPx = Math.min(6, rawTotal * 0.01) * (0.5 + rnd());
      const endPx = Math.min(10, rawTotal * 0.02) * (0.6 + rnd() * 0.8);
      pts = overshootPts(pts, startPx, endPx);
    }
    return pts;
  });
  const cums = wobbled.map((p) => cumLengths(p));
  const totals = cums.map((c) => c[c.length - 1]!);
  const grand = Math.max(
    1e-6,
    totals.reduce((a, b) => a + b, 0),
  );
  const starts: number[] = [];
  const ends: number[] = [];
  let acc = 0;
  for (const len of totals) {
    starts.push(acc / grand);
    acc += len;
    ends.push(acc / grand);
  }

  const attr = `fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"`;
  const progress = (t: number): number =>
    easeInOutSine(clamp01((t - o.t0) / o.dur));

  const el: TimelineEl = {
    t0: o.t0,
    t1: o.t0 + o.dur,
    svg(t) {
      if (t < o.t0) return "";
      const p = t >= el.t1 ? 1 : progress(t);
      const parts: string[] = [];
      for (let k = 0; k < wobbled.length; k++) {
        if (p >= ends[k]!) {
          parts.push(
            `<polyline points="${polylineAttr(wobbled[k]!)}" ${attr}/>`,
          );
        } else if (p > starts[k]!) {
          const local = (p - starts[k]!) / (ends[k]! - starts[k]!);
          const part = slicePolyline(wobbled[k]!, cums[k]!, local * totals[k]!);
          parts.push(`<polyline points="${polylineAttr(part)}" ${attr}/>`);
          break;
        }
      }
      return parts.join("");
    },
    pen(t) {
      if (t < o.t0 || t > el.t1) return null;
      const p = progress(t);
      let k = wobbled.length - 1;
      for (let i = 0; i < wobbled.length; i++) {
        if (p <= ends[i]!) {
          k = i;
          break;
        }
      }
      const local =
        ends[k]! === starts[k]!
          ? 1
          : clamp01((p - starts[k]!) / (ends[k]! - starts[k]!));
      return pointAtLength(wobbled[k]!, cums[k]!, local * totals[k]!);
    },
  };
  return el;
}

/** 淡入填充矩形（柱状图填色等）. */
export function fadeRect(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { t0: number; dur: number; fill: string; maxOpacity: number },
): TimelineEl {
  return {
    t0: o.t0,
    t1: o.t0 + o.dur,
    svg(t) {
      if (t < o.t0) return "";
      const p = easeOutCubic(clamp01((t - o.t0) / o.dur));
      return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${o.fill}" opacity="${fmt(p * o.maxOpacity)}"/>`;
    },
  };
}

/** 静态 SVG 片段的淡入 + 上浮入场（sticker 色块装饰件）. */
export function fadeGroup(
  inner: string,
  o: { t0: number; dur: number; riseFrom?: number },
): TimelineEl {
  const rise = o.riseFrom ?? 26;
  return {
    t0: o.t0,
    t1: o.t0 + o.dur,
    svg(t) {
      if (t < o.t0) return "";
      const p = easeOutCubic(clamp01((t - o.t0) / o.dur));
      const dy = rise * (1 - p);
      return `<g opacity="${fmt(p)}" transform="translate(0,${fmt(dy)})">${inner}</g>`;
    },
  };
}

/** 轻过冲滑入插值：末端 8% 过冲后回弹（"放"上去的手感）. */
function slideEase(p: number): number {
  const c = 1.08;
  const e = easeOutCubic(p);
  return e < 1 ? Math.min(c, e * c) * (1 / c) + (1 - 1 / c) * e : 1;
}

export interface ImageOpts {
  cx: number;
  cy: number;
  /** 照片内容显示宽高（外框在此基础上加边）. */
  w: number;
  h: number;
  rotDeg: number;
  t0: number;
  dur: number;
  fromDx: number;
  fromDy: number;
  /** 预读好的照片 data URI（保持纯函数——本模块不读文件）. */
  dataUri: string;
  /** 拍立得白框颜色/描边. */
  frameFill: string;
  frameStroke: string;
  idp: string;
}

/** 照片拉入元素：拍立得白框 + cover-fit 照片，滑入带轻过冲. */
export function imageEl(o: ImageOpts): TimelineEl {
  const pad = 30;
  const bottomPad = 96;
  const frameW = o.w + pad * 2;
  const frameH = o.h + pad + bottomPad;
  const id = `${o.idp}img`;
  return {
    t0: o.t0,
    t1: o.t0 + o.dur,
    svg(t) {
      if (t < o.t0) return "";
      const p = slideEase(clamp01((t - o.t0) / o.dur));
      const dx = o.fromDx * (1 - p);
      const dy = o.fromDy * (1 - p);
      return [
        `<g transform="translate(${fmt(o.cx + dx)},${fmt(o.cy + dy)}) rotate(${fmt(o.rotDeg)})">`,
        `<rect x="${fmt(-frameW / 2)}" y="${fmt(-frameH / 2)}" width="${fmt(frameW)}" height="${fmt(frameH)}" rx="10" fill="${o.frameFill}" stroke="${o.frameStroke}" stroke-width="3"/>`,
        `<clipPath id="${id}"><rect x="${fmt(-o.w / 2)}" y="${fmt(-frameH / 2 + pad)}" width="${fmt(o.w)}" height="${fmt(o.h)}"/></clipPath>`,
        `<image clip-path="url(#${id})" href="${escapeXmlText(o.dataUri)}" x="${fmt(-o.w / 2)}" y="${fmt(-frameH / 2 + pad)}" width="${fmt(o.w)}" height="${fmt(o.h)}" preserveAspectRatio="xMidYMid slice"/>`,
        `</g>`,
      ].join("");
    },
  };
}
