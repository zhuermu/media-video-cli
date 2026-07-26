/**
 * @module core/whiteboard-video/strokes
 *
 * 设计稿 §3「手绘线条样式」：粗/细线档位、虚线、箭头线，以及三色荧光笔触。
 *
 * ## 虚线为什么不用 stroke-dasharray
 *
 * 因为笔迹不是描边而是**闭合的可变宽度带**（见 marker.ts）：笔画按进度截断后
 * 每帧重新生成 path，`stroke-dasharray` 作用在描边上，对 `fill` 的带子无效。
 * 所以虚线在**几何层**实现：把折线按弧长切成一段段短折线，每段各自是一条
 * 完整的笔迹带。副作用是免费得到了正确的书写动画——真人画虚线就是一段一段
 * 戳出来的，而 dasharray 的动画会是"一条实线逐渐长出虚线的形状"。
 *
 * ## 荧光笔为什么不是"粗一点的马克笔"
 *
 * 荧光笔的三个特征都不是宽度：**半透明**（叠色而非覆盖）、**平头**（端点是
 * 方的，不是圆的）、**压在文字下面**（z 序在文字之前）。只把 width 调大会
 * 得到"一根很粗的黑线盖住了字"。
 */

import type { Pt, TimelineEl } from "../whiteboard/index";
import {
  arrowHead,
  clamp01,
  cumLengths,
  easeInOutSine,
  fmt,
  hashSeed,
  mulberry32,
  pointAtLength,
  wobble,
} from "../whiteboard/index";
import { HIGHLIGHT_OPACITY } from "./palette";
import { markerStrokesEl } from "./marker";
import type { MarkerStrokesOpts } from "./marker";

/**
 * 设计稿 §3 的线宽档位（px，按 1080 宽画幅标定）。
 *
 * 四档之间是**可辨识的跳变**而不是等差数列：线宽是分类信号（这是标题线 /
 * 这是辅助线），相邻两档差不到 40% 时观众读不出区别，只会觉得"线粗细不匀"。
 *
 * 绝对值整体偏细（8 / 5.5 / 3.5）。设计稿的"粗线条"也只是**比细线明显粗**，
 * 不是记号笔涂出来的色带——bold 定到 13 会让每个框都抢过框里的内容，下划线
 * 还会压到标题底部的笔画上。
 */
export const LINE_W = {
  /** 粗线条：标题下划线、主流程框. */
  bold: 8,
  /** 中线条：正文级框线、箭头杆. */
  medium: 5.5,
  /** 细线条：辅助线、注解引线. */
  thin: 3.5,
} as const;

export type LineWeight = keyof typeof LINE_W;

// ---- 虚线（§3 虚线条 / 虚线箭头） ----

/** 虚线默认节奏：段长与间隔（px）. */
const DASH_LEN = 30;
const DASH_GAP = 20;

/**
 * 把一条折线按弧长切成虚线的各个短段。
 *
 * 段长带 ±12% 的确定性抖动：等长的段读起来像机器画的（CAD 虚线），而设计稿
 * 的虚线是手戳的。抖动来自 seed，逐帧稳定。
 */
export function dashSegments(
  pts: readonly Pt[],
  seed: string,
  dashLen = DASH_LEN,
  gapLen = DASH_GAP,
): Pt[][] {
  if (pts.length < 2) return [];
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;
  if (total <= 0) return [];
  const rnd = mulberry32(hashSeed(`dash:${seed}`));
  const out: Pt[][] = [];
  let s = 0;
  while (s < total - 1) {
    const len = dashLen * (0.88 + rnd() * 0.24);
    const e = Math.min(total, s + len);
    // 每段取首尾 + 中点，够短所以不必细分（弯折处由外层 wobble 负责）
    out.push([
      pointAtLength(pts, cum, s),
      pointAtLength(pts, cum, (s + e) / 2),
      pointAtLength(pts, cum, e),
    ]);
    s = e + gapLen * (0.88 + rnd() * 0.24);
  }
  return out;
}

/**
 * 虚线元素：几何切段 + 逐段描画。
 *
 * `overshoot: false` 是必须的——每一小段都过冲会让虚线变成"一串小箭头"。
 */
export function dashedStrokesEl(
  paths: readonly Pt[][],
  o: MarkerStrokesOpts & { dashLen?: number; gapLen?: number },
): TimelineEl {
  const segs = paths.flatMap((p, i) =>
    dashSegments(p, `${o.seed}:${i}`, o.dashLen, o.gapLen),
  );
  return markerStrokesEl(segs, {
    ...o,
    overshoot: false,
    inkPool: false,
    amp: o.amp ?? 1.2,
  });
}

// ---- 箭头（§3 箭头线 / §4 箭头、曲线箭头、虚线箭头） ----

/** 直箭头的折线组（杆 + 两翼）. */
export function straightArrow(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  headSize = 26,
): Pt[][] {
  const shaft: Pt[] = [
    [x0, y0],
    [x1, y1],
  ];
  return [shaft, arrowHead(shaft, headSize)];
}

/**
 * 设计稿 §4 的曲线箭头：二次贝塞尔采样成折线 + 末端两翼。
 *
 * `bow` 是弓形高度相对弦长的比例（正值向上弯）。用采样折线而不是 SVG 的
 * `Q` 命令，是因为下游 wobble/笔迹带只吃折线——保持"一切都能被笔描出来"。
 */
export function curvedArrow(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bow = 0.28,
  headSize = 26,
  steps = 26,
): Pt[][] {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  // 控制点沿弦的法向偏移
  const cx = mx - (dy / len) * len * bow;
  const cy = my + (dx / len) * len * bow;
  const shaft: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    shaft.push([
      u * u * x0 + 2 * u * t * cx + t * t * x1,
      u * u * y0 + 2 * u * t * cy + t * t * y1,
    ]);
  }
  return [shaft, arrowHead(shaft, headSize)];
}

/**
 * 虚线箭头（§4）：杆走虚线、箭头两翼保持实线。
 *
 * 两翼不虚化是刻意的——虚线的语义是"这条连接是假设/可选的"，而箭头本身
 * 要指得明确。把翼也切成虚线会让箭头看起来只是"几个散点"。
 */
export function dashedArrowEl(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: MarkerStrokesOpts & { headSize?: number },
): TimelineEl {
  const head = o.headSize ?? 26;
  const [shaft, wings] = straightArrow(x0, y0, x1, y1, head);
  const shaftEl = dashedStrokesEl([shaft!], {
    ...o,
    dur: o.dur * 0.72,
  });
  const wingEl = markerStrokesEl([wings!], {
    ...o,
    t0: o.t0 + o.dur * 0.72,
    dur: o.dur * 0.28,
    overshoot: false,
    inkPool: false,
  });
  return {
    t0: shaftEl.t0,
    t1: wingEl.t1,
    svg: (t) => shaftEl.svg(t) + wingEl.svg(t),
    pen: (t) =>
      t < wingEl.t0 ? (shaftEl.pen?.(t) ?? null) : (wingEl.pen?.(t) ?? null),
  };
}

// ---- 荧光笔触（§3 强调色 1/2/3） ----

export interface HighlightOpts {
  t0: number;
  dur: number;
  /** 涂抹色（走 palette 的 highlightOf）. */
  color: string;
  /** 涂抹带高度（通常取字号的 0.8~1.0）. */
  height: number;
  seed: string;
  /** 不透明度. Default {@link HIGHLIGHT_OPACITY}. */
  opacity?: number;
}

/**
 * 荧光笔涂抹：一条从左到右刷过的半透明平头色带。
 *
 * 实现为 `<rect>` 的宽度动画而不是笔迹带：荧光笔一刷而过，笔头宽度恒定
 * （平头贴着板面），没有马克笔那种沿弧长的宽度起伏。用矩形还顺带避免了
 * 半透明笔迹带在自交处叠色变深的问题——荧光笔涂两遍确实会更深，但那是
 * 涂两遍，不是画一笔。
 *
 * 两端斜切（左端上斜、右端下斜）来自平头笔的握持角度，是"这是荧光笔而不是
 * 一个色块"最省的一笔。
 */
export function highlightEl(
  x: number,
  y: number,
  w: number,
  o: HighlightOpts,
): TimelineEl {
  const op = o.opacity ?? HIGHLIGHT_OPACITY;
  const h = o.height;
  const skew = h * 0.18;
  const t1 = o.t0 + o.dur;
  return {
    t0: o.t0,
    t1,
    svg(t) {
      if (t < o.t0) return "";
      const p = t >= t1 ? 1 : easeInOutSine(clamp01((t - o.t0) / o.dur));
      const cw = w * p;
      if (cw <= 1) return "";
      // 平行四边形：左端上斜、右端下斜（平头笔的两个切角）
      const d = [
        `M ${fmt(x)} ${fmt(y + skew)}`,
        `L ${fmt(x + skew * 0.7)} ${fmt(y)}`,
        `L ${fmt(x + cw)} ${fmt(y)}`,
        `L ${fmt(x + cw - skew * 0.7)} ${fmt(y + h)}`,
        `L ${fmt(x)} ${fmt(y + h)}`,
        `Z`,
      ].join(" ");
      return `<path d="${d}" fill="${o.color}" fill-opacity="${fmt(op)}"/>`;
    },
  };
}

/**
 * 设计稿 §3 的「强调色」样例笔触：来回涂抹的锯齿（scribble）。
 *
 * 设计稿里三条强调色画的是**乱涂的一团**，不是整齐的色带——它示意的是
 * "拿荧光笔来回划了几下"。这个形状用在需要更强调、更随意的场合（例如
 * 圈住一个关键词），而 {@link highlightEl} 用在规整的下划高亮。
 */
export function scribblePaths(
  x: number,
  y: number,
  w: number,
  h: number,
  passes = 4,
): Pt[][] {
  const pts: Pt[] = [];
  const n = passes * 2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // 之字形：x 单调推进，y 在上下沿之间来回
    pts.push([x + w * t, i % 2 === 0 ? y + h * 0.12 : y + h * 0.88]);
  }
  return [pts];
}

/** 锯齿涂抹元素（用荧光色 + 半透明，宽笔迹带）. */
export function scribbleEl(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { t0: number; dur: number; color: string; seed: string; passes?: number },
): TimelineEl {
  return markerStrokesEl(scribblePaths(x, y, w, h, o.passes), {
    t0: o.t0,
    dur: o.dur,
    color: o.color,
    width: h * 0.34,
    seed: o.seed,
    amp: 2.2,
    overshoot: false,
    inkPool: false,
    opacity: 0.55,
  });
}

/** 手绘波浪下划线（§13 的「波浪下划线」，也用于装饰强调）. */
export function wavyUnderline(
  x: number,
  y: number,
  w: number,
  amp = 5,
  cycles = 5,
): Pt[][] {
  const pts: Pt[] = [];
  const steps = Math.max(16, cycles * 8);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([x + w * t, y + Math.sin(t * Math.PI * 2 * cycles) * amp]);
  }
  return [pts];
}

/** 便捷构造：按档位取线宽（供调用点少写魔法数字）. */
export function lineWidth(weight: LineWeight): number {
  return LINE_W[weight];
}

// ---- 2.0 §2 补齐：点线 / 双向箭头 / 波浪线 / 闪电线 ----

/**
 * 点线（设计稿 2.0 §2「点线」）：虚线的极端情形——段长趋近于 0。
 *
 * 复用 {@link dashSegments} 而不是新写一套：点线和虚线的区别只是"段长/间隔"
 * 的比例。段长取线宽的 0.9 倍（再短会被笔迹带的圆端帽吃掉，看起来还是虚线），
 * 间隔取线宽的 2.4 倍（点之间要留得比点本身宽，否则读成虚线）。
 */
export function dottedStrokesEl(
  paths: readonly Pt[][],
  o: MarkerStrokesOpts,
): TimelineEl {
  return dashedStrokesEl(paths, {
    ...o,
    dashLen: o.width * 0.9,
    gapLen: o.width * 2.4,
    amp: 0.8,
  });
}

/**
 * 双向箭头（设计稿 2.0 §2「双向箭头」）：一根杆 + 两端各一组翼。
 *
 * 语义是"双向/互相/等价"，所以两端的翼必须**一样大**：一端大一端小会读成
 * "主要往这边、顺带往那边"。
 */
export function biArrow(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  headSize = 22,
): Pt[][] {
  const shaft: Pt[] = [
    [x0, y0],
    [x1, y1],
  ];
  const back: Pt[] = [
    [x1, y1],
    [x0, y0],
  ];
  return [shaft, arrowHead(shaft, headSize), arrowHead(back, headSize)];
}

/**
 * 波浪线（设计稿 2.0 §2「波浪线」）：等幅正弦，用作装饰分隔或"这里省略了一段"。
 *
 * 与 {@link wavyUnderline} 的区别只是默认参数（这条更长更缓），共用采样逻辑。
 */
export function wavyLine(
  x: number,
  y: number,
  w: number,
  amp = 9,
  cycles = 3.5,
): Pt[][] {
  return wavyUnderline(x, y, w, amp, cycles);
}

/**
 * 闪电线（设计稿 2.0 §2「闪电线」）：折返的锯齿，语义是"冲突/中断/突然"。
 *
 * 关键是**折点不等距**：等距锯齿读成装饰花边，不等距才读成闪电。这里用固定
 * 的比例序列（不是随机），保证同一条闪电逐帧稳定。
 */
export function lightningPath(
  x: number,
  y: number,
  w: number,
  h: number,
): Pt[] {
  // (沿线比例, 横向偏移比例) —— 偏移在中轴两侧交替且幅度递变
  const steps: Array<[number, number]> = [
    [0, 0.32],
    [0.22, -0.18],
    [0.4, 0.24],
    [0.58, -0.3],
    [0.78, 0.14],
    [1, -0.24],
  ];
  return steps.map(([t, dx]) => [x + w * (0.5 + dx), y + h * t] as Pt);
}

/** 供 wobble 复用的默认抖幅（细线抖动要小，否则看起来像画歪了）. */
export function wobbleFor(weight: LineWeight): number {
  return weight === "thin" ? 1.6 : weight === "medium" ? 2.6 : 3.4;
}

/** 直线折线（§3 的粗/中/细线条样例）. */
export function straightLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Pt[] {
  return [
    [x0, y0],
    [x1, y1],
  ];
}

/** 内部：给形状库复用的"已抖动"折线（避免各处重复 wobble 参数）. */
export function handDrawn(pts: readonly Pt[], seed: string, amp = 2.6): Pt[] {
  return wobble(pts, hashSeed(seed), { amp, step: 18, wavelength: 130 });
}

// ---- 2.0 §4「手绘笔触效果」 ----

/**
 * 设计稿 2.0 §4 的六种笔触。
 *
 * `marker`（马克笔）与 `highlighter`（荧光笔）已由 {@link markerStrokesEl} 和
 * {@link highlightEl} 提供，这里补余下四种。
 */
export type BrushKind =
  "marker" | "brush" | "highlighter" | "chalk" | "watercolor" | "gradient";

export const BRUSH_KINDS: readonly BrushKind[] = [
  "marker",
  "brush",
  "highlighter",
  "chalk",
  "watercolor",
  "gradient",
];

export function isBrushKind(v: string): v is BrushKind {
  return (BRUSH_KINDS as readonly string[]).includes(v);
}

/**
 * 毛笔笔触（§4「毛笔笔触」）：起笔重、收笔尖。
 *
 * 与马克笔的区别**只在宽度剖面**，不在颜色或形状：马克笔是恒宽（笔头是硬的
 * 平面），毛笔是"压下去粗、提起来细"。所以这里直接复用 {@link markerStrokesEl}
 * 的笔迹带，只把 taper 参数推到极端——起笔 1.0 倍宽、收笔收到 0.12 倍。
 *
 * 顺带关掉 `inkPool`：积墨点是马克笔起笔洇出来的一小团，毛笔起笔本身就是最粗
 * 的地方，再叠一个圆点会变成一个墨疙瘩。
 */
export function brushStrokesEl(
  paths: readonly Pt[][],
  o: MarkerStrokesOpts,
): TimelineEl {
  return markerStrokesEl(paths, {
    ...o,
    inkPool: false,
    jitter: o.jitter ?? 0.26,
    opacity: o.opacity ?? 0.96,
  });
}

/**
 * 粉笔笔触（§4「粉笔效果」）：半透明 + 沿途的颗粒缺口。
 *
 * 粉笔的质感来自**断续**：粉笔灰不会均匀附着，笔迹里有细小的空隙。实现是把
 * 折线切成密集的短段（比点线更密、间隔更小），再降低不透明度。
 *
 * 不用 SVG 滤镜做颗粒（`feTurbulence`）：resvg 的滤镜支持有限，而且滤镜要在
 * 每帧重新求值，会击穿帧预算。几何断续是纯路径，逐帧稳定且免费。
 */
export function chalkStrokesEl(
  paths: readonly Pt[][],
  o: MarkerStrokesOpts,
): TimelineEl {
  const segs = paths.flatMap((p, i) =>
    dashSegments(p, `chalk:${o.seed}:${i}`, o.width * 1.6, o.width * 0.42),
  );
  return markerStrokesEl(segs, {
    ...o,
    overshoot: false,
    inkPool: false,
    amp: o.amp ?? 1.8,
    jitter: 0.34,
    opacity: o.opacity ?? 0.62,
  });
}

/**
 * 水彩涂抹（§4「水彩涂抹」）：柔边的半透明色块，边缘不规则。
 *
 * 与荧光笔（规整平行四边形）的区别是**边界**：水彩是渗出去的，所以轮廓用带
 * 低频扰动的闭合折线，而且叠两层（外层更淡更大、内层更实更小）——真实水彩
 * 干燥后边缘会留一圈更深的水痕，两层叠加是最省的近似。
 */
export function watercolorSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { color: string; seed: string; opacity?: number },
): string {
  const op = o.opacity ?? 0.3;
  const blob = (inset: number, seedSuffix: string): string => {
    const rx = w / 2 - inset;
    const ry = h / 2 - inset;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const base: Pt[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      base.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    // 沿轮廓做低频扰动（水痕），闭合
    const wob = wobble(base, hashSeed(`${o.seed}:${seedSuffix}`), {
      amp: Math.min(rx, ry) * 0.16,
      step: Math.max(6, rx / 4),
      wavelength: 90,
    });
    const d =
      `M ${fmt(wob[0]![0])} ${fmt(wob[0]![1])} ` +
      wob
        .slice(1)
        .map(([px, py]) => `L ${fmt(px)} ${fmt(py)}`)
        .join(" ") +
      " Z";
    return d;
  };
  return (
    `<path d="${blob(0, "outer")}" fill="${o.color}" fill-opacity="${fmt(op * 0.62)}"/>` +
    `<path d="${blob(Math.min(w, h) * 0.14, "inner")}" fill="${o.color}" fill-opacity="${fmt(op)}"/>`
  );
}

/**
 * 渐变笔触（§4「渐变笔触」）：沿笔画方向由一色过渡到另一色的宽笔迹。
 *
 * 用 `<linearGradient>` + 一条粗描边实现，而不是笔迹带：笔迹带是 `fill` 的
 * 闭合路径，给它套渐变需要知道路径的主方向（否则渐变方向和笔画方向不一致，
 * 看起来像是"被打了一道光"）。这里限定为**直线段**并让渐变与线段同向，是刻意
 * 缩小适用范围换取正确性——弯曲的渐变笔触需要沿路径的渐变（SVG 不原生支持）。
 *
 * `id` 必须全文档唯一（同一帧可能有多条渐变笔触）。
 */
export function gradientStrokeSvg(
  id: string,
  from: Pt,
  to: Pt,
  width: number,
  colors: readonly [string, string],
  opacity = 0.85,
): string {
  return (
    `<defs><linearGradient id="${id}" x1="${fmt(from[0])}" y1="${fmt(from[1])}" ` +
    `x2="${fmt(to[0])}" y2="${fmt(to[1])}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0%" stop-color="${colors[0]}"/>` +
    `<stop offset="100%" stop-color="${colors[1]}"/></linearGradient></defs>` +
    `<line x1="${fmt(from[0])}" y1="${fmt(from[1])}" x2="${fmt(to[0])}" y2="${fmt(to[1])}" ` +
    `stroke="url(#${id})" stroke-width="${fmt(width)}" stroke-linecap="round" ` +
    `opacity="${fmt(opacity)}"/>`
  );
}
