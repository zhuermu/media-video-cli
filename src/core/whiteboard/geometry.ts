/**
 * @module @core/whiteboard (geometry)
 *
 * 折线弧长工具、缓动函数、确定性平滑抖动。全部纯函数（BR-U4-8 同款
 * 纯度契约：无 fs/Date/Math.random——随机性全部来自显式 seed）。
 *
 * 质感升级点（vs 实验版白噪声抖动）：
 * - wobble 改为「重采样 + 沿弧长的平滑值噪声 + 垂直位移」——手抖是
 *   低频连续的，白噪声逐点抖动会出现高频毛刺；
 * - 端点用包络锚定（起笔/收笔处位移归零），交点对得上；
 * - 同 seed 同输出，逐帧稳定不"沸腾"。
 */

/** 画布坐标点. */
export type Pt = readonly [number, number];

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** SVG 属性数字格式化：2 位小数去尾零. */
export function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

// ---- 缓动（质感维度 D：节奏） ----

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 书写用：起笔收笔柔和的正弦缓动. */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** 运镜用：五次缓动，中段快两端稳，比 cubic 更"稳重". */
export function easeInOutQuint(t: number): number {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

// ---- 弧长 ----

/** 累计弧长表：cum[i] = 前 i 段总长（cum[0] = 0）. */
export function cumLengths(pts: readonly Pt[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dy = pts[i]![1] - pts[i - 1]![1];
    cum.push(cum[i - 1]! + Math.hypot(dx, dy));
  }
  return cum;
}

/**
 * 端点过冲（手绘感）：沿两端切向把折线各延长 startPx/endPx——真人
 * 起笔落点略早、收笔越过终点。原端点仍在路径上（插入而非替换）。
 */
export function overshootPts(
  pts: readonly Pt[],
  startPx: number,
  endPx: number,
): Pt[] {
  if (pts.length < 2) return [...pts];
  const out: Pt[] = [...pts];
  if (startPx > 0) {
    const [ax, ay] = pts[0]!;
    const [bx, by] = pts[1]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    out.unshift([
      ax - ((bx - ax) / len) * startPx,
      ay - ((by - ay) / len) * startPx,
    ]);
  }
  if (endPx > 0) {
    const [ax, ay] = pts[pts.length - 2]!;
    const [bx, by] = pts[pts.length - 1]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    out.push([bx + ((bx - ax) / len) * endPx, by + ((by - ay) / len) * endPx]);
  }
  return out;
}

/** 折线上距起点弧长 L 处的点（L 越界取端点）. */
export function pointAtLength(
  pts: readonly Pt[],
  cum: readonly number[],
  L: number,
): Pt {
  const total = cum[cum.length - 1]!;
  if (L <= 0 || pts.length === 1) return pts[0]!;
  if (L >= total) return pts[pts.length - 1]!;
  let i = 1;
  while (cum[i]! < L) i++;
  const segLen = cum[i]! - cum[i - 1]!;
  const t = segLen === 0 ? 0 : (L - cum[i - 1]!) / segLen;
  return [
    lerp(pts[i - 1]![0], pts[i]![0], t),
    lerp(pts[i - 1]![1], pts[i]![1], t),
  ];
}

/** 折线从起点截取弧长 L 的部分折线（至少含起点）. */
export function slicePolyline(
  pts: readonly Pt[],
  cum: readonly number[],
  L: number,
): Pt[] {
  const total = cum[cum.length - 1]!;
  if (L >= total) return [...pts];
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i]! <= L) {
      out.push(pts[i]!);
    } else {
      out.push(pointAtLength(pts, cum, L));
      break;
    }
  }
  return out;
}

// ---- 确定性随机 ----

/** mulberry32 PRNG（同 seed 同序列）. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 字符串 → 32 位种子. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 一维平滑值噪声：整数格点取确定性随机值，格点间余弦插值。
 * 返回 n(x) ∈ [-1, 1]，低频连续——模拟手部微颤。
 */
export function valueNoise1D(seed: number): (x: number) => number {
  const rnd = mulberry32(seed);
  const lattice = new Map<number, number>();
  const at = (i: number): number => {
    let v = lattice.get(i);
    if (v === undefined) {
      // 用格点索引再散列，保证与查询顺序无关
      const r = mulberry32((seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0)();
      v = r * 2 - 1;
      lattice.set(i, v);
    }
    return v;
  };
  void rnd;
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const s = (1 - Math.cos(Math.PI * f)) / 2; // cosine smoothstep
    return at(i) * (1 - s) + at(i + 1) * s;
  };
}

// ---- 手绘抖动（质感维度 C：线条质量） ----

/** wobble 参数. */
export interface WobbleOpts {
  /** 最大垂直位移 px. */
  amp?: number;
  /** 重采样间距 px. */
  step?: number;
  /** 噪声波长（px，越大越平缓）. */
  wavelength?: number;
}

/**
 * 手绘化折线：按 ~step 等距重采样，沿弧长取平滑噪声做**垂直于切向**的
 * 位移；两端 12% 弧长内用包络把位移压到 0（起笔收笔对位）。
 */
export function wobble(
  pts: readonly Pt[],
  seed: number,
  opts: WobbleOpts = {},
): Pt[] {
  const amp = opts.amp ?? 2.6;
  const step = opts.step ?? 26;
  const wavelength = opts.wavelength ?? 150;
  if (pts.length < 2 || amp <= 0) return [...pts];

  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;
  if (total < step * 1.5) return [...pts];

  const noise = valueNoise1D(seed);
  const n = Math.max(3, Math.round(total / step));
  const out: Pt[] = [];
  const edge = Math.max(1e-6, total * 0.12);
  for (let k = 0; k <= n; k++) {
    const L = (total * k) / n;
    const p = pointAtLength(pts, cum, L);
    // 切向：取邻近两点差分
    const ahead = pointAtLength(pts, cum, Math.min(total, L + 1));
    const behind = pointAtLength(pts, cum, Math.max(0, L - 1));
    const tx = ahead[0] - behind[0];
    const ty = ahead[1] - behind[1];
    const tl = Math.hypot(tx, ty) || 1;
    // 法向单位向量
    const nx = -ty / tl;
    const ny = tx / tl;
    // 端点包络：两端 12% 弧长内位移线性归零
    const env = Math.min(1, L / edge, (total - L) / edge);
    const d = noise(L / wavelength) * amp * env;
    out.push([p[0] + nx * d, p[1] + ny * d]);
  }
  return out;
}

// ---- 形状采样 ----

/**
 * 手绘化重采样的步长：既要够粗（抖动才平滑、点数才可控），又不能粗到**吃掉
 * 输入本身的细节**。
 *
 * 只按总弧长推导（早先的 `min(26, max(6, total/14))`）会出一个隐蔽的坏结果：
 * 路径一长，步长就顶到 26px，而圆角、小弧这些特征的分段只有 2-3px——重采样
 * 直接把它们抹平。实测一个 300×60 的胶囊形（78 点、周长 689）被压成 27 点，
 * 四个圆角全变成斜切面，渲出来是个六边形。这个 bug 会影响所有圆角/曲线形状。
 *
 * 所以再加一道上限：**输入分段长度的中位数 × 3**。密采样的弧（分段短）因此
 * 得到小步长、细节保住；一条两点直线（分段就是全长）步长不变、成本不变。
 *
 * 代价可以忽略：`wobble` 只在元素**构造期**跑一次，而每帧的笔迹带是按自己的
 * `BAND_STEP` 重采样的，与这里的点数几乎无关。
 */
export function resampleStep(pts: readonly Pt[], total: number): number {
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(
      pts[i]![0] - pts[i - 1]![0],
      pts[i]![1] - pts[i - 1]![1],
    );
    if (d > 1e-6) segs.push(d);
  }
  const byLength = Math.max(6, total / 14);
  if (segs.length === 0) return Math.min(26, byLength);
  segs.sort((a, b) => a - b);
  const median = segs[Math.floor(segs.length / 2)]!;
  return Math.min(26, byLength, Math.max(4, median * 3));
}

/** 椭圆弧采样为折线（角度制）. */
export function ellipsePts(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg: number,
  sweepDeg: number,
  steps = 84,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + (sweepDeg * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** polyline points 属性串. */
export function polylineAttr(pts: readonly Pt[]): string {
  return pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
}

/** 折线末端切向的箭头两翼（返回 [翼A, 尖, 翼B] 折线）. */
export function arrowHead(pts: readonly Pt[], size = 32): Pt[] {
  const tip = pts[pts.length - 1]!;
  const prev = pts[Math.max(0, pts.length - 4)]!;
  const ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
  const spread = (152 * Math.PI) / 180;
  const a: Pt = [
    tip[0] + size * Math.cos(ang + spread),
    tip[1] + size * Math.sin(ang + spread),
  ];
  const b: Pt = [
    tip[0] + size * Math.cos(ang - spread),
    tip[1] + size * Math.sin(ang - spread),
  ];
  return [a, tip, b];
}
