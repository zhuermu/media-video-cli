/**
 * PoC: 马克笔笔迹（可变宽度笔画带）
 *
 * 现状问题：`elements.ts` 的 strokesEl 用 `<polyline stroke-width=N>` 描线，
 * 线宽恒定 → 观感是"数位板铅笔"，不是白板马克笔。
 *
 * 本模块把笔画从「恒宽描边」换成「可变宽度闭合带」（outline fill）：
 * - 宽度沿弧长有低频起伏（马克笔头与板面的接触面积在变）；
 * - 起笔略窄→迅速铺开（落笔），收笔渐收（提笔离板）；
 * - 端点半圆帽（马克笔是圆头/斜头，不是尖头）；
 * - 落笔处一点积墨（真马克笔起笔会洇出一小团）；
 * - fill-opacity < 1 → 笔画交叠处自然叠深，像同一支笔画了两遍。
 *
 * 逐笔绘制：按进度截断折线后重新生成带（每帧重算），因此无法再用
 * stroke-dasharray —— 这是换 outline fill 的必付代价。
 */

import type { Pt } from "../whiteboard/index";
import {
  clamp01,
  cumLengths,
  easeInOutSine,
  fmt,
  hashSeed,
  mulberry32,
  overshootPts,
  pointAtLength,
  valueNoise1D,
  wobble,
} from "../whiteboard/index";
import type { TimelineEl } from "../whiteboard/index";

/** 端帽的半圆采样段数（8 段在 1080 宽下已看不出多边形）. */
const CAP_STEPS = 8;

/** 笔迹带的等距重采样步长（px）——越小越贴合曲率，代价是路径变长. */
const BAND_STEP = 7;

export interface MarkerBandOpts {
  /** 笔迹基础全宽（px）. */
  width: number;
  /** 宽度噪声种子. */
  seed: number;
  /** 宽度起伏幅度（相对基础宽度）. Default 0.17. */
  jitter?: number;
  /** 落笔渐宽的弧长占比. Default 0.035. */
  taperIn?: number;
  /** 提笔渐收的弧长占比（仅笔画完成时生效）. Default 0.09. */
  taperOut?: number;
  /** 落笔起点半宽系数（<1 = 起笔比行笔窄）. Default 0.72. */
  startScale?: number;
  /** 提笔终点半宽系数. Default 0.46. */
  endScale?: number;
  /** 已绘制比例 0..1（<1 时末端为满宽圆帽——笔还在板上）. Default 1. */
  drawn?: number;
}

/** 半宽剖面：低频噪声起伏 + 两端 taper（u = 该点在**完整**笔画上的弧长比例）. */
function halfWidthAt(
  u: number,
  sAbs: number,
  o: Required<
    Pick<
      MarkerBandOpts,
      | "width"
      | "jitter"
      | "taperIn"
      | "taperOut"
      | "startScale"
      | "endScale"
      | "drawn"
    >
  >,
  noise: (x: number) => number,
): number {
  const base = o.width / 2;
  // 低频起伏：波长 ~190px，比 wobble 的法向抖动更长，两者不同频不打架
  let k = 1 + noise(sAbs / 190) * o.jitter;
  if (u < o.taperIn) {
    const p = easeInOutSine(clamp01(u / o.taperIn));
    k *= o.startScale + (1 - o.startScale) * p;
  }
  // 收笔 taper 只在笔画画完后出现；绘制中末端是"笔还压在板上"的满宽圆帽
  if (o.drawn >= 0.999 && u > 1 - o.taperOut) {
    const p = easeInOutSine(clamp01((1 - u) / o.taperOut));
    k *= o.endScale + (1 - o.endScale) * p;
  }
  return base * k;
}

/**
 * 可变宽度笔迹带的闭合 path d。
 *
 * 输入折线视为笔画中心线（调用方已做 wobble/overshoot）。
 * 返回 "" 表示这一帧还没有可见笔迹。
 */
export function markerBandPath(
  pts: readonly Pt[],
  opts: MarkerBandOpts,
): string {
  // 注意：不能用 `{...defaults, ...opts}` —— opts 里显式传入的 undefined
  // 会覆盖默认值（导致半宽算成 NaN，整条 path 被 resvg 静默丢弃）。
  const o = {
    width: opts.width,
    seed: opts.seed,
    jitter: opts.jitter ?? 0.17,
    taperIn: opts.taperIn ?? 0.035,
    taperOut: opts.taperOut ?? 0.09,
    startScale: opts.startScale ?? 0.72,
    endScale: opts.endScale ?? 0.46,
    drawn: opts.drawn ?? 1,
  };
  if (pts.length < 2 || o.width <= 0) return "";
  const drawn = clamp01(o.drawn);
  if (drawn <= 0) return "";

  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;
  if (total < 1e-3) return "";
  const drawLen = total * drawn;
  const noise = valueNoise1D(o.seed);

  const n = Math.max(2, Math.round(drawLen / BAND_STEP));
  const left: Pt[] = [];
  const right: Pt[] = [];
  // 端帽需要端点处的切向与半宽，边循环里记下来
  let startTan: Pt = [1, 0];
  let endTan: Pt = [1, 0];
  let startCenter: Pt = pts[0]!;
  let endCenter: Pt = pts[0]!;
  let startHalf = o.width / 2;
  let endHalf = o.width / 2;

  for (let i = 0; i <= n; i++) {
    const s = (drawLen * i) / n;
    const c = pointAtLength(pts, cum, s);
    // 切向：中心差分（端点退化为单侧差分）
    const a = pointAtLength(pts, cum, Math.max(0, s - 1.2));
    const b = pointAtLength(pts, cum, Math.min(total, s + 1.2));
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    // 法向（SVG y 向下，此处只需左右一致，不关心视觉左右）
    const nx = -uy;
    const ny = ux;
    const h = halfWidthAt(s / total, s, o, noise);
    left.push([c[0] + nx * h, c[1] + ny * h]);
    right.push([c[0] - nx * h, c[1] - ny * h]);
    if (i === 0) {
      startTan = [ux, uy];
      startCenter = c;
      startHalf = h;
    }
    if (i === n) {
      endTan = [ux, uy];
      endCenter = c;
      endHalf = h;
    }
  }

  /** 半圆帽采样：从 +normal 经 ±tangent 转到 -normal. */
  const cap = (center: Pt, tan: Pt, h: number, forward: boolean): Pt[] => {
    const [ux, uy] = tan;
    const nx = -uy;
    const ny = ux;
    const dir = forward ? 1 : -1;
    const out: Pt[] = [];
    for (let k = 1; k < CAP_STEPS; k++) {
      const th = (Math.PI * k) / CAP_STEPS;
      const cs = Math.cos(th);
      const sn = Math.sin(th) * dir;
      out.push([
        center[0] + (nx * cs + ux * sn) * h,
        center[1] + (ny * cs + uy * sn) * h,
      ]);
    }
    return out;
  };

  const ring: Pt[] = [
    ...left,
    ...cap(endCenter, endTan, endHalf, true),
    ...right.slice().reverse(),
    ...cap(startCenter, startTan, startHalf, false).reverse(),
  ];

  return (
    `M ${fmt(ring[0]![0])} ${fmt(ring[0]![1])} ` +
    ring
      .slice(1)
      .map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`)
      .join(" ") +
    " Z"
  );
}

export interface MarkerStrokesOpts {
  t0: number;
  dur: number;
  color: string;
  /** 笔迹全宽 px. */
  width: number;
  seed: string;
  /** 法向抖动幅度（手抖，沿用 geometry.wobble）. */
  amp?: number;
  overshoot?: boolean;
  /** 笔迹不透明度（<1 → 交叠处叠深，像同一支笔过了两遍）. Default 0.93. */
  opacity?: number;
  /** 落笔积墨点（起笔洇出的一小团）. Default true. */
  inkPool?: boolean;
  /** 宽度起伏幅度. */
  jitter?: number;
}

/**
 * 马克笔版 strokesEl：多段折线依弧长顺序描画，笔尖跟随当前端点。
 * 接口与 `elements.ts` 的 strokesEl 对齐（可直接替换），差别在笔迹形态。
 */
export function markerStrokesEl(
  paths: readonly Pt[][],
  o: MarkerStrokesOpts,
): TimelineEl {
  const amp = o.amp ?? 3.0;
  const opacity = o.opacity ?? 0.93;

  const prepared = paths.map((p, i) => {
    const seed = hashSeed(`${o.seed}:${i}`);
    const rawTotal = cumLengths(p)[p.length - 1] ?? 0;
    const ampEff = Math.min(amp, Math.max(0.6, rawTotal * 0.018));
    const stepEff = Math.min(26, Math.max(6, rawTotal / 14));
    let pts = wobble(p, seed, { amp: ampEff, step: stepEff, wavelength: 130 });
    if (o.overshoot !== false && rawTotal > 40) {
      const rnd = mulberry32(seed ^ 0x5f3759df);
      const startPx = Math.min(6, rawTotal * 0.01) * (0.5 + rnd());
      const endPx = Math.min(10, rawTotal * 0.02) * (0.6 + rnd() * 0.8);
      pts = overshootPts(pts, startPx, endPx);
    }
    return { pts, seed };
  });

  const cums = prepared.map((p) => cumLengths(p.pts));
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

  const progress = (t: number): number =>
    easeInOutSine(clamp01((t - o.t0) / o.dur));

  /** 单段的带 + 积墨点. */
  const bandSvg = (k: number, drawn: number): string => {
    const d = markerBandPath(prepared[k]!.pts, {
      width: o.width,
      seed: prepared[k]!.seed,
      drawn,
      jitter: o.jitter,
    });
    if (d === "") return "";
    let out = `<path d="${d}" fill="${o.color}" fill-opacity="${fmt(opacity)}"/>`;
    if (o.inkPool !== false && totals[k]! > 24) {
      const p0 = prepared[k]!.pts[0]!;
      out += `<circle cx="${fmt(p0[0])}" cy="${fmt(p0[1])}" r="${fmt(o.width * 0.42)}" fill="${o.color}" fill-opacity="${fmt(opacity)}"/>`;
    }
    return out;
  };

  const el: TimelineEl = {
    t0: o.t0,
    t1: o.t0 + o.dur,
    svg(t) {
      if (t < o.t0) return "";
      const p = t >= el.t1 ? 1 : progress(t);
      const parts: string[] = [];
      for (let k = 0; k < prepared.length; k++) {
        if (p >= ends[k]!) {
          parts.push(bandSvg(k, 1));
        } else if (p > starts[k]!) {
          const local = (p - starts[k]!) / (ends[k]! - starts[k]!);
          parts.push(bandSvg(k, local));
          break;
        }
      }
      return parts.join("");
    },
    pen(t) {
      if (t < o.t0 || t > el.t1) return null;
      const p = progress(t);
      let k = prepared.length - 1;
      for (let i = 0; i < prepared.length; i++) {
        if (p <= ends[i]!) {
          k = i;
          break;
        }
      }
      const local =
        ends[k]! === starts[k]!
          ? 1
          : clamp01((p - starts[k]!) / (ends[k]! - starts[k]!));
      return pointAtLength(prepared[k]!.pts, cums[k]!, local * totals[k]!);
    },
  };
  return el;
}
