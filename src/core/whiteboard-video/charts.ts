/**
 * @module core/whiteboard-video/charts
 *
 * 设计稿 2.0 §7「数据可视化元素」：柱状图 / 折线图 / 饼图 / 环形图 / 面积图 /
 * 雷达图 / 漏斗图 / 仪表盘 / 金字塔 / 对比图 / 时间轴。
 *
 * ## 为什么图表值得单独一层
 *
 * 讲解视频里最难用嘴说清的就是量的关系——"增长了不少""这块占大头""三者
 * 差不多"。这些话配一张图，观众一眼就懂；只用嘴说，观众得自己在脑子里建模。
 * 前面几层（形状、线条、图标）解决的是"画面不空"，这一层解决的是"讲得清"。
 *
 * ## 统一约定
 *
 * 每个图表返回 {@link ChartDrawing}：`strokes`（要被笔描的折线组，按描画顺序）
 * + `fills`（描完之后淡入的实心块，如柱子的填色、饼图的扇形）。
 *
 * 分成两份是因为**笔只画轮廓，不涂色**：真人在白板上画柱状图是先画轴、再画
 * 柱子的框，最后拿马克笔把柱子涂上——涂色是"填进去"的，不是"描出来"的。
 * 如果让笔迹带去画填充块，会得到一根巨粗的线，而不是一个色块。
 *
 * ## 数据都由调用方给
 *
 * 本模块不做数据聚合、不做"漂亮的刻度"（axis ticks 的 nice-number 算法）。
 * 输入是已经归一化的 `0..1` 数值，坐标系由调用方给的矩形决定。理由：白板图表
 * 是**示意**而不是报表，纵轴写不写数字取决于版式，硬塞一套刻度算法反而挡路。
 */

import type { Pt } from "../whiteboard/index";
import { ellipsePts, fmt } from "../whiteboard/index";
import { PALETTE, seriesColor } from "./palette";

/** 一个图表的绘制材料（先描 strokes，再淡入 fills）. */
export interface ChartDrawing {
  /** 要被笔描画的折线组（数组顺序 = 描画顺序）. */
  strokes: Pt[][];
  /** 描完后淡入的实心块（静态 SVG 片段）. */
  fills: string[];
}

/** 图表画布矩形. */
export interface ChartBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 空图表（数据为空时返回，调用方不必判空）. */
const EMPTY: ChartDrawing = { strokes: [], fills: [] };

/** 归一化数值夹到 0..1（脏数据不该让图画到框外）. */
function unit(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * L 形坐标轴（左纵轴 + 下横轴，一笔画完）。
 *
 * 只画两条边而不是画一个框：白板图表的轴是"参考线"，四边全画会变成一个盒子，
 * 视觉重量压过数据本身。
 */
export function axisPath(b: ChartBox): Pt[] {
  return [
    [b.x, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ];
}

// ---- 柱状图 / 面积图 / 折线图 ----

export interface BarChartOpts {
  /** 每根柱子的高度（0..1）. */
  values: readonly number[];
  /** 柱宽占单位槽宽的比例. Default 0.56. */
  barRatio?: number;
  /** 各柱颜色；省略则按 {@link seriesColor} 轮转. */
  colors?: readonly string[];
  /** 画 L 形坐标轴. Default true. */
  axis?: boolean;
}

/**
 * 柱状图（§7「柱状图」）。
 *
 * 柱子的**轮廓**进 strokes（笔一根根画框），**填色**进 fills（画完再涂）。
 */
export function barChart(b: ChartBox, o: BarChartOpts): ChartDrawing {
  const n = o.values.length;
  if (n === 0) return EMPTY;
  const strokes: Pt[][] = [];
  const fills: string[] = [];
  if (o.axis !== false) strokes.push(axisPath(b));
  const slot = b.w / n;
  const bw = slot * (o.barRatio ?? 0.56);
  for (const [i, raw] of o.values.entries()) {
    const v = unit(raw);
    const bh = b.h * v;
    // 高度为 0 的柱子不画：一条贴在轴上的横线读起来像轴的一部分
    if (bh < 1) continue;
    const bx = b.x + slot * i + (slot - bw) / 2;
    const by = b.y + b.h - bh;
    strokes.push([
      [bx, b.y + b.h],
      [bx, by],
      [bx + bw, by],
      [bx + bw, b.y + b.h],
    ]);
    const color = o.colors?.[i] ?? seriesColor(i);
    fills.push(
      `<rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(bw)}" height="${fmt(bh)}" fill="${color}" opacity="0.72"/>`,
    );
  }
  return { strokes, fills };
}

/** 折线图/面积图的数据点 → 画布坐标. */
function seriesPoints(b: ChartBox, values: readonly number[]): Pt[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [[b.x + b.w / 2, b.y + b.h * (1 - unit(values[0]!))]];
  return values.map((v, i) => [
    b.x + (b.w * i) / (n - 1),
    b.y + b.h * (1 - unit(v)),
  ]);
}

export interface LineChartOpts {
  values: readonly number[];
  color?: string;
  axis?: boolean;
  /** 数据点画小圆点（设计稿的折线图带点）. Default true. */
  dots?: boolean;
}

/** 折线图（§7「折线图」）：轴 + 折线 + 数据点. */
export function lineChart(b: ChartBox, o: LineChartOpts): ChartDrawing {
  const pts = seriesPoints(b, o.values);
  if (pts.length === 0) return EMPTY;
  const strokes: Pt[][] = [];
  const fills: string[] = [];
  if (o.axis !== false) strokes.push(axisPath(b));
  if (pts.length > 1) strokes.push(pts);
  const color = o.color ?? PALETTE.primary;
  if (o.dots !== false) {
    const r = Math.max(3, Math.min(b.w, b.h) * 0.022);
    for (const [px, py] of pts) {
      fills.push(
        `<circle cx="${fmt(px)}" cy="${fmt(py)}" r="${fmt(r)}" fill="${color}"/>`,
      );
    }
  }
  return { strokes, fills };
}

/**
 * 面积图（§7「面积图」）：折线 + 折线以下填色。
 *
 * 填充区用 `<polygon>` 一次成形（不是逐柱矩形）：面积图的语义是"连续的量"，
 * 拿一排矩形拼出来在边界上会露出台阶。
 */
export function areaChart(b: ChartBox, o: LineChartOpts): ChartDrawing {
  const base = lineChart(b, o);
  const pts = seriesPoints(b, o.values);
  if (pts.length < 2) return base;
  const color = o.color ?? PALETTE.primary;
  const poly = [
    ...pts.map(([px, py]) => `${fmt(px)},${fmt(py)}`),
    `${fmt(pts[pts.length - 1]![0])},${fmt(b.y + b.h)}`,
    `${fmt(pts[0]![0])},${fmt(b.y + b.h)}`,
  ].join(" ");
  return {
    strokes: base.strokes,
    // 填充垫在数据点之下（先 push 面，再是原来的点）
    fills: [
      `<polygon points="${poly}" fill="${color}" opacity="0.28"/>`,
      ...base.fills,
    ],
  };
}

// ---- 饼图 / 环形图 ----

export interface PieChartOpts {
  /** 各扇区占比（会自动归一化到合计 1）. */
  values: readonly number[];
  colors?: readonly string[];
  /** 内半径比例 > 0 即环形图（§7「环形图」）. Default 0. */
  innerRatio?: number;
}

/**
 * 饼图 / 环形图（§7）。
 *
 * 扇形的**分隔半径**进 strokes（笔画的是"切开这块饼"的那几刀），扇形填色进
 * fills。外圈整圆也进 strokes——先画圆再切，是真人的顺序。
 *
 * 起始角固定在 12 点方向（-90°）：饼图从正上方开始是普遍约定，从别处开始会
 * 让人多花一秒确认"哪块是第一块"。
 */
export function pieChart(
  cx: number,
  cy: number,
  r: number,
  o: PieChartOpts,
): ChartDrawing {
  const total = o.values.reduce((a, v) => a + Math.max(0, v), 0);
  if (total <= 0 || r <= 0) return EMPTY;
  const inner = r * Math.min(0.92, Math.max(0, o.innerRatio ?? 0));
  const strokes: Pt[][] = [ellipsePts(cx, cy, r, r, -90, 360, 60)];
  if (inner > 0) strokes.push(ellipsePts(cx, cy, inner, inner, -90, 360, 44));
  const fills: string[] = [];
  let acc = -90;
  for (const [i, raw] of o.values.entries()) {
    const frac = Math.max(0, raw) / total;
    const sweep = frac * 360;
    if (sweep <= 0) continue;
    const color = o.colors?.[i] ?? seriesColor(i);
    const outer = ellipsePts(cx, cy, r, r, acc, sweep, 44);
    const ring =
      inner > 0
        ? [
            ...outer,
            ...ellipsePts(cx, cy, inner, inner, acc + sweep, -sweep, 44),
          ]
        : [[cx, cy] as Pt, ...outer];
    fills.push(
      `<polygon points="${ring.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(" ")}" fill="${color}" opacity="0.78"/>`,
    );
    // 分隔刀：整圆时不必画最后一刀（它与起始刀重合）
    if (o.values.length > 1) {
      const a = (acc * Math.PI) / 180;
      strokes.push([
        [cx + inner * Math.cos(a), cy + inner * Math.sin(a)],
        [cx + r * Math.cos(a), cy + r * Math.sin(a)],
      ]);
    }
    acc += sweep;
  }
  return { strokes, fills };
}

// ---- 雷达图 ----

export interface RadarChartOpts {
  /** 每个轴上的值（0..1）；长度即轴数（>= 3）. */
  values: readonly number[];
  color?: string;
  /** 画外框网格. Default true. */
  grid?: boolean;
}

/**
 * 雷达图（§7「雷达图」）：外框多边形 + 各轴 + 数据多边形。
 *
 * 轴数少于 3 画不出面（两个轴退化成一条线），直接返回空——比画一个读不懂的
 * 图形好。
 */
export function radarChart(
  cx: number,
  cy: number,
  r: number,
  o: RadarChartOpts,
): ChartDrawing {
  const n = o.values.length;
  if (n < 3 || r <= 0) return EMPTY;
  const at = (i: number, k: number): Pt => {
    const a = ((-90 + (360 * i) / n) * Math.PI) / 180;
    return [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)];
  };
  const strokes: Pt[][] = [];
  if (o.grid !== false) {
    const outer: Pt[] = [];
    for (let i = 0; i <= n; i++) outer.push(at(i % n, 1));
    strokes.push(outer);
    // 中间一圈参考线（只画一圈：两圈以上在小尺寸下糊成一团）
    const mid: Pt[] = [];
    for (let i = 0; i <= n; i++) mid.push(at(i % n, 0.55));
    strokes.push(mid);
    for (let i = 0; i < n; i++) strokes.push([[cx, cy], at(i, 1)]);
  }
  const data: Pt[] = [];
  for (let i = 0; i <= n; i++) data.push(at(i % n, unit(o.values[i % n]!)));
  strokes.push(data);
  const color = o.color ?? PALETTE.primary;
  return {
    strokes,
    fills: [
      `<polygon points="${data.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(" ")}" fill="${color}" opacity="0.3"/>`,
    ],
  };
}

// ---- 漏斗图 / 金字塔 ----

export interface StackOpts {
  /** 层数（>= 2）. */
  levels: number;
  colors?: readonly string[];
  /** 层间缝隙占层高的比例. Default 0.1. */
  gapRatio?: number;
}

/**
 * 漏斗图（§7「漏斗图」）：自上而下逐层收窄的梯形堆叠。
 *
 * 最底层宽度收到顶层的 22%——收得不够就读成"一堆矩形"。漏斗的语义全在
 * "越来越窄"这件事上。
 */
export function funnelChart(b: ChartBox, o: StackOpts): ChartDrawing {
  return stacked(b, o, true);
}

/**
 * 金字塔（§7「金字塔」）：自上而下逐层变宽的梯形堆叠（漏斗的反向）。
 *
 * 与漏斗共用实现：两者的差别只是宽度序列的方向。分成两个导出函数而不是加一个
 * `direction` 参数，是因为调用点写 `pyramid(...)` 比 `stacked(..., false)` 更
 * 说明意图。
 */
export function pyramidChart(b: ChartBox, o: StackOpts): ChartDrawing {
  return stacked(b, o, false);
}

function stacked(b: ChartBox, o: StackOpts, narrowing: boolean): ChartDrawing {
  const n = Math.floor(o.levels);
  if (n < 2) return EMPTY;
  const gap = o.gapRatio ?? 0.1;
  const lh = b.h / n;
  const bodyH = lh * (1 - gap);
  const strokes: Pt[][] = [];
  const fills: string[] = [];
  const cx = b.x + b.w / 2;
  /** 第 i 层（0 = 最上）的半宽. */
  const halfAt = (i: number): number => {
    const t = i / n; // 0..1 自上而下
    const k = narrowing ? 1 - 0.78 * t : 0.22 + 0.78 * t;
    return (b.w * k) / 2;
  };
  for (let i = 0; i < n; i++) {
    const top = b.y + lh * i;
    const h0 = halfAt(i);
    const h1 = halfAt(i + 1);
    const quad: Pt[] = [
      [cx - h0, top],
      [cx + h0, top],
      [cx + h1, top + bodyH],
      [cx - h1, top + bodyH],
      [cx - h0, top],
    ];
    strokes.push(quad);
    const color = o.colors?.[i] ?? seriesColor(i);
    fills.push(
      `<polygon points="${quad.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(" ")}" fill="${color}" opacity="0.7"/>`,
    );
  }
  return { strokes, fills };
}

// ---- 仪表盘 ----

export interface GaugeOpts {
  /** 指针位置（0..1）. */
  value: number;
  color?: string;
  /** 表盘张角（度）；180 = 半圆. Default 200. */
  sweepDeg?: number;
}

/**
 * 仪表盘（§7「仪表盘」）：弧形表盘 + 刻度 + 指针。
 *
 * 张角默认 200° 而不是 180°：正半圆的两端指向水平，指针指到端点时和表盘边
 * 重合，读不出"到底了"。多出来的 20° 让两端略微下垂，端点位置一眼可辨。
 */
export function gauge(
  cx: number,
  cy: number,
  r: number,
  o: GaugeOpts,
): ChartDrawing {
  if (r <= 0) return EMPTY;
  const sweep = o.sweepDeg ?? 200;
  const start = -90 - sweep / 2;
  const strokes: Pt[][] = [ellipsePts(cx, cy, r, r, start, sweep, 48)];
  // 刻度：两端 + 中点
  for (const k of [0, 0.5, 1]) {
    const a = ((start + sweep * k) * Math.PI) / 180;
    strokes.push([
      [cx + r * 0.84 * Math.cos(a), cy + r * 0.84 * Math.sin(a)],
      [cx + r * Math.cos(a), cy + r * Math.sin(a)],
    ]);
  }
  // 指针
  const pa = ((start + sweep * unit(o.value)) * Math.PI) / 180;
  strokes.push([
    [cx, cy],
    [cx + r * 0.74 * Math.cos(pa), cy + r * 0.74 * Math.sin(pa)],
  ]);
  const color = o.color ?? PALETTE.danger;
  return {
    strokes,
    fills: [
      `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(Math.max(3, r * 0.07))}" fill="${color}"/>`,
    ],
  };
}

// ---- 时间轴 / 对比图 ----

export interface TimelineOpts {
  /** 节点数（>= 2）. */
  nodes: number;
  /** 已完成到第几个节点（0-based，含）；-1 = 都没完成. Default -1. */
  doneUpTo?: number;
  color?: string;
}

/**
 * 时间轴（§7「时间轴」）：一条横轴 + 均匀分布的节点圈。
 *
 * 已完成的节点用实心（fills），未完成的用空心（只有 strokes 的圈）。实心/空心
 * 比"改颜色"更稳：投屏和手机上颜色会偏，但实心与空心的差别永远看得出来。
 */
export function timeline(b: ChartBox, o: TimelineOpts): ChartDrawing {
  const n = Math.floor(o.nodes);
  if (n < 2) return EMPTY;
  const cy = b.y + b.h / 2;
  const r = Math.min(b.h / 2, b.w / (n * 3));
  const strokes: Pt[][] = [
    [
      [b.x, cy],
      [b.x + b.w, cy],
    ],
  ];
  const fills: string[] = [];
  const done = o.doneUpTo ?? -1;
  const color = o.color ?? PALETTE.primary;
  for (let i = 0; i < n; i++) {
    const px = b.x + (b.w * i) / (n - 1);
    strokes.push(ellipsePts(px, cy, r, r, 0, 360, 22));
    if (i <= done) {
      fills.push(
        `<circle cx="${fmt(px)}" cy="${fmt(cy)}" r="${fmt(r * 0.94)}" fill="${color}"/>`,
      );
    } else {
      // 空心节点也要有底色，否则轴线会穿过圈里
      fills.push(
        `<circle cx="${fmt(px)}" cy="${fmt(cy)}" r="${fmt(r * 0.9)}" fill="#FFFFFF"/>`,
      );
    }
  }
  return { strokes, fills };
}

export interface CompareOpts {
  /** 左右两侧的柱高（0..1）. */
  left: number;
  right: number;
  colors?: readonly [string, string];
}

/**
 * 对比图（§7「对比图」）：左右两根柱 + 中间留出 "VS" 的位置。
 *
 * 中间的空档是留给调用方写 "VS" 的——本模块不写字（文字必须走矢量手写路径，
 * 那是 blocks.ts 的事）。返回的 `gap` 让调用方知道往哪儿写。
 */
export function compareChart(
  b: ChartBox,
  o: CompareOpts,
): ChartDrawing & { gap: ChartBox } {
  const colW = b.w * 0.34;
  const gapW = b.w - colW * 2;
  const mk = (x: number, v: number, color: string): [Pt[], string] => {
    const h = b.h * unit(v);
    const y = b.y + b.h - h;
    const outline: Pt[] = [
      [x, b.y + b.h],
      [x, y],
      [x + colW, y],
      [x + colW, b.y + b.h],
    ];
    return [
      outline,
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(colW)}" height="${fmt(h)}" fill="${color}" opacity="0.72"/>`,
    ];
  };
  const [lp, lf] = mk(b.x, o.left, o.colors?.[0] ?? PALETTE.primary);
  const [rp, rf] = mk(
    b.x + colW + gapW,
    o.right,
    o.colors?.[1] ?? PALETTE.danger,
  );
  return {
    strokes: [lp, rp],
    fills: [lf, rf],
    gap: { x: b.x + colW, y: b.y, w: gapW, h: b.h },
  };
}

/** 全部图表种类名（供脚本层校验 / 枚举）. */
export const CHART_NAMES = [
  "bar",
  "line",
  "area",
  "pie",
  "donut",
  "radar",
  "funnel",
  "pyramid",
  "gauge",
  "timeline",
  "compare",
] as const;

export type ChartName = (typeof CHART_NAMES)[number];

export function isChartName(v: string): v is ChartName {
  return (CHART_NAMES as readonly string[]).includes(v);
}
