/**
 * @module @core/whiteboard (library)
 *
 * 基础视觉元素库（Q5=D 混合体系）：
 * - 线稿件（icon）：归一化 100×100 坐标系里的折线组，实例化时缩放
 *   平移，由 strokesEl 用笔描画——与白板形态完全同构；
 * - 色块装饰件（sticker）：静态 SVG 片段（低饱和填充），fadeGroup
 *   拉入，不走笔描。
 *
 * 全部数据即代码（无外部素材文件、零授权风险）；新增元素 = 加一个
 * 表项。曲线用椭圆弧/参数曲线采样为折线，保持"可被笔描画"。
 */

import type { Pt } from "./geometry";
import { ellipsePts, fmt, hashSeed, mulberry32 } from "./geometry";

/** 一个线稿元素：归一化 100×100 框内的折线组（描画顺序即数组序）. */
export interface LineArtDef {
  /** 折线组（每条按书写顺序）. */
  strokes: readonly Pt[][];
  /** 描画时长权重（相对基准 1 = 约 0.7s）. */
  weight: number;
}

const line = (a: Pt, b: Pt): Pt[] => [a, b];

/** 参数化心形采样（经典 heart curve，归一化进 100×100）. */
function heartPts(): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * 2 * Math.PI;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    pts.push([50 + x * 2.55, 46 - y * 2.55]);
  }
  return pts;
}

/** 五角星单笔连线（外顶点跳画，一笔成星）. */
function starPts(cx: number, cy: number, r: number): Pt[] {
  const order = [0, 2, 4, 1, 3, 0];
  return order.map((k) => {
    const a = (-90 + k * 72) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** 爆炸框（doodle burst）：内外交替的 12 尖闭合折线. */
function burstPts(): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = ((i * 15 - 90) * Math.PI) / 180;
    const r = i % 2 === 0 ? 46 : 30;
    pts.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  return pts;
}

/** 波浪线（装饰下划线）. */
function wavePts(): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 60; i++) {
    const x = 5 + (90 * i) / 60;
    pts.push([x, 50 + Math.sin((i / 60) * Math.PI * 4) * 8]);
  }
  return pts;
}

/** 线稿元素库（名字 → 归一化定义）. */
export const LINE_ART: Record<string, LineArtDef> = {
  "arrow-right": {
    strokes: [
      line([8, 50], [80, 50]),
      [
        [62, 34],
        [82, 50],
        [62, 66],
      ],
    ],
    weight: 0.7,
  },
  "arrow-swoosh": {
    strokes: [
      ellipsePts(45, 95, 55, 62, -175, 78, 40),
      [
        [78, 30],
        [86, 44],
        [68, 48],
      ],
    ],
    weight: 0.9,
  },
  circle: { strokes: [ellipsePts(50, 50, 44, 40, -80, 385, 72)], weight: 1 },
  check: {
    strokes: [
      [
        [20, 55],
        [42, 78],
        [84, 24],
      ],
    ],
    weight: 0.5,
  },
  cross: {
    strokes: [line([26, 26], [74, 74]), line([74, 26], [26, 74])],
    weight: 0.5,
  },
  star: { strokes: [starPts(50, 52, 44)], weight: 0.9 },
  burst: { strokes: [burstPts()], weight: 1.1 },
  wave: { strokes: [wavePts()], weight: 0.6 },
  lightbulb: {
    strokes: [
      ellipsePts(50, 42, 26, 26, 128, 284, 56),
      [
        [38, 66],
        [38, 78],
        [62, 78],
        [62, 66],
      ],
      line([42, 86], [58, 86]),
      line([50, 4], [50, 12]),
      line([16, 18], [24, 26]),
      line([84, 18], [76, 26]),
    ],
    weight: 1.3,
  },
  box: {
    strokes: [
      [
        [14, 22],
        [86, 22],
        [86, 78],
        [14, 78],
        [14, 24],
      ],
    ],
    weight: 0.9,
  },
  "speech-bubble": {
    strokes: [
      [
        [16, 20],
        [84, 20],
        [84, 62],
        [46, 62],
        [32, 80],
        [34, 62],
        [16, 62],
        [16, 22],
      ],
    ],
    weight: 1,
  },
  cloud: {
    strokes: [
      [
        ...ellipsePts(32, 58, 16, 14, 90, 200, 24),
        ...ellipsePts(50, 44, 18, 16, 170, 190, 28),
        ...ellipsePts(70, 56, 15, 13, 250, 200, 24),
        [78, 70],
        [26, 70],
      ],
    ],
    weight: 1,
  },
  magnifier: {
    strokes: [
      ellipsePts(42, 42, 26, 26, -60, 370, 56),
      line([62, 62], [86, 86]),
    ],
    weight: 0.9,
  },
  heart: { strokes: [heartPts()], weight: 0.9 },
  target: {
    strokes: [
      ellipsePts(50, 50, 42, 40, -80, 370, 64),
      ellipsePts(50, 50, 24, 23, 100, 370, 48),
      ellipsePts(50, 50, 6, 6, 0, 360, 16),
    ],
    weight: 1.1,
  },
  // —— 流行元素批次（自媒体常用点缀） ——
  rocket: {
    strokes: [
      [
        [50, 6],
        [62, 20],
        [68, 42],
        [66, 60],
        [34, 60],
        [32, 42],
        [38, 20],
        [50, 6],
      ],
      [
        [34, 60],
        [22, 78],
        [37, 70],
      ],
      [
        [66, 60],
        [78, 78],
        [63, 70],
      ],
      ellipsePts(50, 36, 9, 9, 0, 360, 20),
      [
        [42, 68],
        [46, 82],
        [50, 70],
        [54, 84],
        [58, 68],
      ],
    ],
    weight: 1.3,
  },
  trophy: {
    strokes: [
      [
        [30, 18],
        [70, 18],
        [69, 40],
        [60, 52],
        [40, 52],
        [31, 40],
        [30, 18],
      ],
      ellipsePts(24, 28, 8, 10, -90, 180, 16),
      ellipsePts(76, 28, 8, 10, 90, 180, 16),
      [
        [45, 52],
        [43, 64],
        [57, 64],
        [55, 52],
      ],
      [
        [34, 72],
        [66, 72],
        [64, 82],
        [36, 82],
        [34, 72],
      ],
    ],
    weight: 1.2,
  },
  "thumbs-up": {
    strokes: [
      [
        [40, 48],
        [48, 46],
        [52, 32],
        [52, 22],
        [58, 20],
        [62, 28],
        [58, 46],
        [72, 46],
        [76, 52],
        [74, 76],
        [68, 82],
        [42, 82],
        [40, 48],
      ],
      [
        [28, 48],
        [40, 48],
        [40, 84],
        [28, 84],
        [28, 48],
      ],
    ],
    weight: 1.1,
  },
  crown: {
    strokes: [
      [
        [20, 68],
        [15, 32],
        [34, 50],
        [50, 22],
        [66, 50],
        [85, 32],
        [80, 68],
        [20, 68],
      ],
      [
        [22, 78],
        [78, 78],
      ],
    ],
    weight: 1,
  },
  fire: {
    strokes: [
      [
        [50, 8],
        [63, 28],
        [60, 42],
        [72, 38],
        [75, 60],
        [65, 80],
        [35, 80],
        [25, 60],
        [29, 40],
        [41, 46],
        [37, 24],
        [50, 8],
      ],
      [
        [50, 48],
        [58, 62],
        [50, 74],
        [42, 62],
        [50, 48],
      ],
    ],
    weight: 1.1,
  },
  sparkles: {
    strokes: [star4(32, 36, 20), star4(64, 22, 11), star4(60, 62, 14)],
    weight: 0.8,
  },
  flag: {
    strokes: [
      line([28, 10], [28, 88]),
      [
        [28, 16],
        [50, 12],
        [74, 18],
        [74, 44],
        [50, 38],
        [28, 44],
      ],
    ],
    weight: 0.9,
  },
  pin: {
    strokes: [
      ellipsePts(50, 38, 23, 23, 150, 240, 44),
      [
        [32, 52],
        [50, 84],
        [68, 52],
      ],
      ellipsePts(50, 38, 8, 8, 0, 360, 18),
    ],
    weight: 1,
  },
};

/** 四角星（sparkles 部件）：尖-腰交替的闭合折线. */
function star4(cx: number, cy: number, r: number): Pt[] {
  const w = r * 0.28;
  return [
    [cx, cy - r],
    [cx + w, cy - w],
    [cx + r, cy],
    [cx + w, cy + w],
    [cx, cy + r],
    [cx - w, cy + w],
    [cx - r, cy],
    [cx - w, cy - w],
    [cx, cy - r],
  ];
}

/** 元素库名字表（校验用）. */
export const LINE_ART_NAMES = Object.keys(LINE_ART);

/** 实例化线稿元素：归一化 → 画布坐标（cx,cy 为中心，size 为边长）. */
export function iconPaths(
  name: string,
  cx: number,
  cy: number,
  size: number,
): Pt[][] {
  const def = LINE_ART[name];
  if (def === undefined) return [];
  const s = size / 100;
  const ox = cx - size / 2;
  const oy = cy - size / 2;
  return def.strokes.map((path) =>
    path.map(([x, y]) => [ox + x * s, oy + y * s]),
  );
}

/** 线稿元素的描画时长（秒；weight 1 ≈ 0.7s）. */
export function iconDrawSec(name: string): number {
  const def = LINE_ART[name];
  return def === undefined ? 0.7 : 0.7 * def.weight;
}

// ---- 色块装饰件（sticker，拉入式） ----

/** sticker 名字表. */
export const STICKER_NAMES = [
  "blob",
  "tape",
  "star-badge",
  "confetti",
  "highlight",
] as const;

export type StickerName = (typeof STICKER_NAMES)[number];

/**
 * 色块装饰件静态 SVG（低饱和、低不透明度，垫在内容后面/角落点缀）。
 * fill 传主题 accentSoft。
 */
export function stickerSvg(
  name: string,
  cx: number,
  cy: number,
  size: number,
  fill: string,
): string {
  const s = size / 100;
  switch (name) {
    case "blob": {
      // 有机圆角斑块（固定控制点，缩放实例化）
      const d = `M ${fmt(cx - 46 * s)} ${fmt(cy)} C ${fmt(cx - 48 * s)} ${fmt(cy - 34 * s)}, ${fmt(cx - 16 * s)} ${fmt(cy - 48 * s)}, ${fmt(cx + 12 * s)} ${fmt(cy - 42 * s)} C ${fmt(cx + 42 * s)} ${fmt(cy - 36 * s)}, ${fmt(cx + 50 * s)} ${fmt(cy - 6 * s)}, ${fmt(cx + 42 * s)} ${fmt(cy + 20 * s)} C ${fmt(cx + 34 * s)} ${fmt(cy + 44 * s)}, ${fmt(cx - 4 * s)} ${fmt(cy + 50 * s)}, ${fmt(cx - 28 * s)} ${fmt(cy + 38 * s)} C ${fmt(cx - 46 * s)} ${fmt(cy + 26 * s)}, ${fmt(cx - 45 * s)} ${fmt(cy + 12 * s)}, ${fmt(cx - 46 * s)} ${fmt(cy)} Z`;
      return `<path d="${d}" fill="${fill}" opacity="0.16"/>`;
    }
    case "tape":
      return `<g transform="translate(${fmt(cx)},${fmt(cy)}) rotate(-8)"><rect x="${fmt(-52 * s)}" y="${fmt(-14 * s)}" width="${fmt(104 * s)}" height="${fmt(28 * s)}" fill="${fill}" opacity="0.28"/></g>`;
    case "star-badge": {
      const pts = starPts(0, 0, 46)
        .map(([x, y]) => `${fmt(cx + x * s)},${fmt(cy + y * s)}`)
        .join(" ");
      return `<polygon points="${pts}" fill="${fill}" opacity="0.22"/>`;
    }
    case "confetti": {
      // 确定性散布的小纸屑（矩形/圆点交替、随机倾角）
      const rnd = mulberry32(hashSeed(`confetti:${cx}:${cy}`));
      const bits: string[] = [];
      for (let i = 0; i < 14; i++) {
        const bx = cx + (rnd() * 2 - 1) * 50 * s;
        const by = cy + (rnd() * 2 - 1) * 50 * s;
        const rot = rnd() * 360;
        const op = 0.18 + rnd() * 0.2;
        if (i % 3 === 0) {
          bits.push(
            `<circle cx="${fmt(bx)}" cy="${fmt(by)}" r="${fmt(4.5 * s)}" fill="${fill}" opacity="${fmt(op)}"/>`,
          );
        } else {
          bits.push(
            `<rect x="${fmt(bx - 6 * s)}" y="${fmt(by - 2.5 * s)}" width="${fmt(12 * s)}" height="${fmt(5 * s)}" transform="rotate(${fmt(rot)} ${fmt(bx)} ${fmt(by)})" fill="${fill}" opacity="${fmt(op)}"/>`,
          );
        }
      }
      return bits.join("");
    }
    case "highlight":
      // 荧光笔划（宽扁圆角条，轻微倾斜，垫在文字后）
      return `<g transform="translate(${fmt(cx)},${fmt(cy)}) rotate(-2)"><rect x="${fmt(-55 * s)}" y="${fmt(-13 * s)}" width="${fmt(110 * s)}" height="${fmt(26 * s)}" rx="${fmt(13 * s)}" fill="${fill}" opacity="0.25"/></g>`;
    default:
      return "";
  }
}
