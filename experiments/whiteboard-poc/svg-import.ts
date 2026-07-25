/**
 * PoC: 外部 SVG 线稿导入器
 *
 * 这是通往 VideoScribe 观感的关键技术件。VideoScribe 的素材库本质是
 * 「为逐笔绘制而作的 SVG 线稿」——每个素材内含笔画顺序，播放时按顺序
 * 描出来。我们缺的不是渲染能力（marker.ts 已经能描），而是**把任意
 * 下载来的 SVG 变成可描折线**的转换层。
 *
 * 关键判断：只有**描边式**（stroke，有中心线）的 SVG 才能被"真的画出来"。
 * 填充式（fill，纯色块）没有中心线，笔无从下手——只能描它的轮廓，或者
 * 退化成遮罩扫掠（"擦出来"而不是"画出来"）。所以素材要挑描边式图标集。
 *
 * 支持：<path>（M/L/H/V/C/S/Q/T/A/Z 全部含相对形式）、<line>、<rect>、
 * <circle>、<ellipse>、<polyline>、<polygon>；viewBox 归一化 + 等比适配
 * 到目标方框。不支持：<use>/<defs> 引用、gradient、嵌套 transform 矩阵
 * 链（当前只解 translate/scale/matrix 单层）——PoC 范围内够用。
 */

import type { Pt } from "../../src/core/whiteboard/index";
import { cumLengths } from "../../src/core/whiteboard/index";

/** 曲线采样密度：每段贝塞尔/圆弧的最小采样点数. */
const CURVE_MIN_STEPS = 10;
/** 曲线采样密度：按弦长每多少单位加一个采样点. */
const CURVE_UNITS_PER_STEP = 1.6;

// ---- path d 解析 ----

type Token = { cmd: string } | { num: number };

function tokenize(d: string): Token[] {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (m[1] !== undefined) out.push({ cmd: m[1] });
    else out.push({ num: Number(m[2]) });
  }
  return out;
}

/** 三次贝塞尔采样（点数按控制点跨度自适应）. */
function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const span =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(CURVE_MIN_STEPS, Math.round(span / CURVE_UNITS_PER_STEP));
  const pts: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] +
        3 * u * u * t * p1[0] +
        3 * u * t * t * p2[0] +
        t * t * t * p3[0],
      u * u * u * p0[1] +
        3 * u * u * t * p1[1] +
        3 * u * t * t * p2[1] +
        t * t * t * p3[1],
    ]);
  }
  return pts;
}

/** 二次贝塞尔采样（升阶为三次，复用同一套采样）. */
function quad(p0: Pt, c: Pt, p1: Pt): Pt[] {
  const c1: Pt = [
    p0[0] + (2 / 3) * (c[0] - p0[0]),
    p0[1] + (2 / 3) * (c[1] - p0[1]),
  ];
  const c2: Pt = [
    p1[0] + (2 / 3) * (c[0] - p1[0]),
    p1[1] + (2 / 3) * (c[1] - p1[1]),
  ];
  return cubic(p0, c1, c2, p1);
}

/**
 * SVG 椭圆弧 → 折线（endpoint → center 参数化，W3C 附录 F.6.5）。
 * Lucide 这类图标的圆角就是 `a` 命令，不支持它会把圆角画成直角缺口。
 */
function arc(
  p0: Pt,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
): Pt[] {
  if (p0[0] === p1[0] && p0[1] === p1[1]) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [p1];

  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (p0[0] - p1[0]) / 2;
  const dy2 = (p0[1] - p1[1]) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // 半径过小时按规范等比放大
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0[1] + p1[1]) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    const a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta0 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const arcLen = Math.abs(dTheta) * Math.max(rx, ry);
  const n = Math.max(
    CURVE_MIN_STEPS,
    Math.round(arcLen / CURVE_UNITS_PER_STEP),
  );
  const pts: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const th = theta0 + (dTheta * i) / n;
    const x = rx * Math.cos(th);
    const y = ry * Math.sin(th);
    pts.push([cosP * x - sinP * y + cx, sinP * x + cosP * y + cy]);
  }
  return pts;
}

/** path 的 d 属性 → 子路径折线组（每个 M 起一条新折线）. */
export function parsePathD(d: string): Pt[][] {
  const tk = tokenize(d);
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // 上一段曲线的控制点（S/T 的镜像基准）
  let prevC: Pt | null = null;
  let prevQ: Pt | null = null;
  let cmd = "";
  let i = 0;

  const num = (): number => {
    const t = tk[i++];
    if (t === undefined || !("num" in t)) return 0;
    return t.num;
  };
  const flush = (): void => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };

  while (i < tk.length) {
    const t = tk[i]!;
    if ("cmd" in t) {
      cmd = t.cmd;
      i++;
      if (cmd === "Z" || cmd === "z") {
        if (cur.length > 0) cur.push([startX, startY]);
        flush();
        cx = startX;
        cy = startY;
        prevC = null;
        prevQ = null;
        continue;
      }
    } else if (cmd === "") {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const bx = rel ? cx : 0;
    const by = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case "M": {
        flush();
        cx = bx + num();
        cy = by + num();
        startX = cx;
        startY = cy;
        cur = [[cx, cy]];
        // 隐式后续坐标对按 L 处理
        cmd = rel ? "l" : "L";
        prevC = null;
        prevQ = null;
        break;
      }
      case "L": {
        cx = bx + num();
        cy = by + num();
        cur.push([cx, cy]);
        prevC = null;
        prevQ = null;
        break;
      }
      case "H": {
        cx = bx + num();
        cur.push([cx, cy]);
        prevC = null;
        prevQ = null;
        break;
      }
      case "V": {
        cy = by + num();
        cur.push([cx, cy]);
        prevC = null;
        prevQ = null;
        break;
      }
      case "C": {
        const p0: Pt = [cx, cy];
        const c1: Pt = [bx + num(), by + num()];
        const c2: Pt = [bx + num(), by + num()];
        const p1: Pt = [bx + num(), by + num()];
        cur.push(...cubic(p0, c1, c2, p1));
        cx = p1[0];
        cy = p1[1];
        prevC = c2;
        prevQ = null;
        break;
      }
      case "S": {
        const p0: Pt = [cx, cy];
        const c1: Pt =
          prevC === null ? p0 : [2 * cx - prevC[0], 2 * cy - prevC[1]];
        const c2: Pt = [bx + num(), by + num()];
        const p1: Pt = [bx + num(), by + num()];
        cur.push(...cubic(p0, c1, c2, p1));
        cx = p1[0];
        cy = p1[1];
        prevC = c2;
        prevQ = null;
        break;
      }
      case "Q": {
        const p0: Pt = [cx, cy];
        const c: Pt = [bx + num(), by + num()];
        const p1: Pt = [bx + num(), by + num()];
        cur.push(...quad(p0, c, p1));
        cx = p1[0];
        cy = p1[1];
        prevQ = c;
        prevC = null;
        break;
      }
      case "T": {
        const p0: Pt = [cx, cy];
        const c: Pt =
          prevQ === null ? p0 : [2 * cx - prevQ[0], 2 * cy - prevQ[1]];
        const p1: Pt = [bx + num(), by + num()];
        cur.push(...quad(p0, c, p1));
        cx = p1[0];
        cy = p1[1];
        prevQ = c;
        prevC = null;
        break;
      }
      case "A": {
        const p0: Pt = [cx, cy];
        const rx = num();
        const ry = num();
        const rot = num();
        const laf = num() !== 0;
        const sf = num() !== 0;
        const p1: Pt = [bx + num(), by + num()];
        cur.push(...arc(p0, rx, ry, rot, laf, sf, p1));
        cx = p1[0];
        cy = p1[1];
        prevC = null;
        prevQ = null;
        break;
      }
      default:
        i++;
    }
  }
  flush();
  return out;
}

// ---- 元素 → 折线 ----

function attrNum(tag: string, name: string, dflt = 0): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m === null ? dflt : Number(m[1]) || 0;
}

function attrStr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m === null ? null : m[1]!;
}

/** 采样椭圆为闭合折线（起点在 12 点方向——真人画圆多从顶端起笔）. */
function ellipseToPts(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const n = Math.max(
    24,
    Math.round((2 * Math.PI * Math.max(rx, ry)) / CURVE_UNITS_PER_STEP),
  );
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** 圆角矩形 → 折线（rx/ry 支持；一笔闭合）. */
function rectToPts(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
): Pt[] {
  if (rx <= 0 && ry <= 0) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ];
  }
  const r = Math.min(rx > 0 ? rx : ry, w / 2);
  const q = Math.min(ry > 0 ? ry : rx, h / 2);
  const corner = (ccx: number, ccy: number, from: number): Pt[] => {
    const n = 8;
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = from + (Math.PI / 2) * (i / n);
      pts.push([ccx + r * Math.cos(a), ccy + q * Math.sin(a)]);
    }
    return pts;
  };
  return [
    [x + r, y],
    [x + w - r, y],
    ...corner(x + w - r, y + q, -Math.PI / 2),
    [x + w, y + h - q],
    ...corner(x + w - r, y + h - q, 0),
    [x + r, y + h],
    ...corner(x + r, y + h - q, Math.PI / 2),
    [x, y + q],
    ...corner(x + r, y + q, Math.PI),
    [x + r, y],
  ];
}

function parsePoints(s: string, close: boolean): Pt[] {
  const nums = s.match(/-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push([Number(nums[i]), Number(nums[i + 1])]);
  }
  if (close && pts.length > 1) pts.push(pts[0]!);
  return pts;
}

export interface ImportedIcon {
  /** viewBox 坐标系下的折线组（文档顺序 = 默认笔画顺序）. */
  strokes: Pt[][];
  /** 源 viewBox. */
  viewBox: readonly [number, number, number, number];
  /** 是否检测到填充式图形（这类素材"画不出来"，只能描轮廓）. */
  hasFill: boolean;
}

/**
 * 解析 SVG 文本为可描折线组。
 *
 * @throws Error 无法解析（缺 viewBox 且缺 width/height，或没有可描图形）
 */
export function importSvg(svgText: string): ImportedIcon {
  const svgTag = /<svg\b[^>]*>/i.exec(svgText)?.[0] ?? "";
  const vbStr = attrStr(svgTag, "viewBox");
  let vb: [number, number, number, number];
  if (vbStr !== null) {
    const n = vbStr
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    vb = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 24, n[3] ?? 24];
  } else {
    vb = [0, 0, attrNum(svgTag, "width", 24), attrNum(svgTag, "height", 24)];
  }

  const strokes: Pt[][] = [];
  let hasFill = false;

  // 文档顺序遍历可描元素（自闭合或成对标签）
  const elRe =
    /<(path|line|rect|circle|ellipse|polyline|polygon)\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = elRe.exec(svgText)) !== null) {
    const kind = m[1]!.toLowerCase();
    const tag = m[0]!;
    const fill = attrStr(tag, "fill");
    if (fill !== null && fill !== "none" && fill !== "transparent") {
      hasFill = true;
    }
    switch (kind) {
      case "path": {
        const d = attrStr(tag, "d");
        if (d !== null) strokes.push(...parsePathD(d));
        break;
      }
      case "line":
        strokes.push([
          [attrNum(tag, "x1"), attrNum(tag, "y1")],
          [attrNum(tag, "x2"), attrNum(tag, "y2")],
        ]);
        break;
      case "rect":
        strokes.push(
          rectToPts(
            attrNum(tag, "x"),
            attrNum(tag, "y"),
            attrNum(tag, "width"),
            attrNum(tag, "height"),
            attrNum(tag, "rx"),
            attrNum(tag, "ry"),
          ),
        );
        break;
      case "circle": {
        const r = attrNum(tag, "r");
        strokes.push(
          ellipseToPts(attrNum(tag, "cx"), attrNum(tag, "cy"), r, r),
        );
        break;
      }
      case "ellipse":
        strokes.push(
          ellipseToPts(
            attrNum(tag, "cx"),
            attrNum(tag, "cy"),
            attrNum(tag, "rx"),
            attrNum(tag, "ry"),
          ),
        );
        break;
      case "polyline":
        strokes.push(parsePoints(attrStr(tag, "points") ?? "", false));
        break;
      case "polygon":
        strokes.push(parsePoints(attrStr(tag, "points") ?? "", true));
        break;
    }
  }

  const kept = strokes.filter((s) => s.length >= 2);
  if (kept.length === 0) {
    throw new Error(
      "SVG 里没有可描画的图形（可能是纯 fill 或用了 <use> 引用）",
    );
  }
  return { strokes: kept, viewBox: vb, hasFill };
}

export interface PlaceOpts {
  /** 目标方框中心. */
  cx: number;
  cy: number;
  /** 目标方框边长（等比适配，长边贴合）. */
  size: number;
  /**
   * 笔画顺序：
   * - "document"（默认）图标作者的编排顺序，通常外框先、细节后
   * - "topDown" 按起点从上到下、从左到右重排（更像真人的视觉扫描顺序）
   * - "longFirst" 长笔画先画（先立骨架再补细节）
   */
  order?: "document" | "topDown" | "longFirst";
}

/** 把导入的折线组等比适配进画布方框，并决定笔画顺序. */
export function placeIcon(icon: ImportedIcon, o: PlaceOpts): Pt[][] {
  const [vx, vy, vw, vh] = icon.viewBox;
  const s = o.size / Math.max(vw || 1, vh || 1);
  const ox = o.cx - (vx + vw / 2) * s;
  const oy = o.cy - (vy + vh / 2) * s;
  const placed = icon.strokes.map((st) =>
    st.map(([x, y]) => [ox + x * s, oy + y * s] as Pt),
  );

  switch (o.order ?? "document") {
    case "topDown":
      return placed
        .map((st, i) => ({ st, i }))
        .sort((a, b) => {
          const ay = a.st[0]![1];
          const by = b.st[0]![1];
          // 同高（±size 的 12%）算一行，按 x 排
          if (Math.abs(ay - by) < o.size * 0.12) {
            return a.st[0]![0] - b.st[0]![0] || a.i - b.i;
          }
          return ay - by;
        })
        .map((e) => e.st);
    case "longFirst":
      return placed
        .map((st, i) => ({ st, i, len: cumLengths(st).at(-1) ?? 0 }))
        .sort((a, b) => b.len - a.len || a.i - b.i)
        .map((e) => e.st);
    default:
      return placed;
  }
}

/** 导入素材的描画时长估算：按总弧长（长的画久一点，短的别拖）. */
export function iconDrawSecFor(paths: readonly Pt[][], size: number): number {
  const total = paths.reduce((a, st) => a + (cumLengths(st).at(-1) ?? 0), 0);
  // 基准：一个 size=240 的图标总弧长约 900px → 1.5s
  return Math.max(0.5, Math.min(3.2, (total / (size * 3.75)) * 1.5));
}
