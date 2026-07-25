/**
 * PoC: 画幅与版式规格（横屏 / 竖屏）
 *
 * 之前版式常量写死在 1080×1920。要同时出横屏（B 站/YouTube/公众号内嵌）
 * 和竖屏（视频号/抖音），画幅必须成为参数，而且**不是简单缩放**：
 *
 * - 竖屏 1080×1920：单栏纵向流，标题占满宽度，元素从上往下排；
 * - 横屏 1920×1080：可用高度只有 1080，纵向堆不下 4 段内容，所以走双栏
 *   （左文右图），标题横跨顶部。
 *
 * 字号也不能等比换算：横屏画面更宽更矮，字号相对画面宽度要更小，否则
 * 一行放不下几个字；竖屏观众离手机近，字可以相对更大。所以两套字阶各自
 * 标定，不是一个 scale 系数。
 */

export type Orientation = "portrait" | "landscape";

/** 字阶（绝对 px，按画幅各自标定）. */
export interface TypeScale {
  title: number;
  subtitle: number;
  body: number;
  label: number;
  /** 手写节奏：每字秒数（大字慢、小字快）. */
  titlePerChar: number;
  bodyPerChar: number;
}

export interface Layout {
  orientation: Orientation;
  width: number;
  height: number;
  /** 左右安全边距. */
  marginX: number;
  /** 顶部安全边距. */
  marginTop: number;
  /** 底部安全边距（竖屏要给平台 UI/字幕留位）. */
  marginBottom: number;
  /** 正文栏数：竖屏 1，横屏 2. */
  columns: 1 | 2;
  /** 双栏时左栏占内容宽的比例. */
  leftColRatio: number;
  type: TypeScale;
}

/** 内容区宽度. */
export function contentW(l: Layout): number {
  return l.width - l.marginX * 2;
}

/** 内容区高度. */
export function contentH(l: Layout): number {
  return l.height - l.marginTop - l.marginBottom;
}

/** 左栏（横屏）或整栏（竖屏）的 x 起点与宽度. */
export function leftCol(l: Layout): { x: number; w: number } {
  if (l.columns === 1) return { x: l.marginX, w: contentW(l) };
  return { x: l.marginX, w: contentW(l) * l.leftColRatio };
}

/** 右栏（横屏）；竖屏返回与 leftCol 相同的整栏. */
export function rightCol(l: Layout): { x: number; w: number } {
  if (l.columns === 1) return { x: l.marginX, w: contentW(l) };
  const gap = contentW(l) * 0.06;
  const lw = contentW(l) * l.leftColRatio;
  return { x: l.marginX + lw + gap, w: contentW(l) - lw - gap };
}

export const PORTRAIT: Layout = {
  orientation: "portrait",
  width: 1080,
  height: 1920,
  marginX: 92,
  marginTop: 200,
  marginBottom: 150,
  columns: 1,
  leftColRatio: 1,
  type: {
    title: 118,
    subtitle: 44,
    body: 56,
    label: 46,
    titlePerChar: 0.46,
    bodyPerChar: 0.19,
  },
};

export const LANDSCAPE: Layout = {
  orientation: "landscape",
  width: 1920,
  height: 1080,
  marginX: 120,
  marginTop: 116,
  marginBottom: 92,
  columns: 2,
  // 左栏放文字（标题下的要点），右栏放插画；文字略窄，插画要够大
  leftColRatio: 0.46,
  type: {
    title: 104,
    subtitle: 42,
    body: 50,
    label: 40,
    titlePerChar: 0.4,
    bodyPerChar: 0.17,
  },
};

export function layoutFor(o: Orientation): Layout {
  return o === "portrait" ? PORTRAIT : LANDSCAPE;
}
