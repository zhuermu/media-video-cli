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

/**
 * 一格的高度占画幅高度的比例（无限画布的行间距，见 compose 的 `serpentineCells`）。
 *
 * 小于 1 是故意的：镜头视野因此比格子高，上下行的笔迹会从画面边缘露出一角，
 * 观感是"同一块画布被拖动"而不是翻页。代价写在 {@link contentBottom}——镜头把
 * 一格居中放进画幅，段内容因此整体下移 (1-ratio)/2 个画幅高。
 */
export const CELL_H_RATIO = 0.78;

/**
 * 内容可以画到的**最低点**：底部安全边距与**字幕带顶边**取更靠上的那个。
 *
 * `marginBottom` 只管平台 UI，管不到字幕——字幕带由 `subtitleEl` 自己定位
 * （底边 12% 画高，白底板 + 一行字），横版算下来带顶在 888px，而
 * `height - marginBottom` 是 988px。差出的这 100px 正好是"流程图最后一个节点
 * 被字幕压住"的宽度，只有把两者一起算才不会出现。
 */
export function contentBottom(l: Layout): number {
  const scale = Math.min(l.width, l.height) / 1080;
  // 与 subtitleEl 的默认取值保持一致：底边 12% 画高，字号 46×scale，白底板上下各
  // 留 0.34 字高。注意那里的 y 是**基线**（baseY - size），字形还要往上占一个字高，
  // 所以带顶要减 2.34 个字号而不是 1.34——差出的这一个字号正好是"最后一个节点被
  // 字幕压住"的量。
  const bandTop = l.height * 0.88 - 46 * scale * 2.34;
  // 段坐标是**格子局部坐标**，而镜头把格子居中放进画幅：局部 y 落在画幅
  // y + (1-CELL_H_RATIO)/2 × 画幅高 处。字幕带是画幅坐标里的东西，换算回局部
  // 要把这段位移减掉，否则算出来的"安全底"比实际低了一个格边（横版 119px），
  // 正好是最后一个节点被字幕压住的量。
  const cellH = l.height * CELL_H_RATIO;
  const camShift = (l.height - cellH) / 2;
  return Math.min(cellH - l.marginBottom * 0.5, bandTop - camShift);
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
    // 标题刻意**不大**：讲解视频的主体是图，标题只是"这一块讲什么"的标签。
    // 早先竖版 118px 的标题占掉一屏宽度的 80%，画面读起来是"大标题 + 一点内容"，
    // 而参考的 scribe 风格里标题只是手写的一行小字，视线立刻落到图上。
    title: 76,
    subtitle: 44,
    body: 52,
    label: 44,
    titlePerChar: 0.32,
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
    // 同竖版：标题降权，把画面让给图（见 PORTRAIT 的注释）
    title: 64,
    subtitle: 40,
    body: 46,
    label: 38,
    titlePerChar: 0.28,
    bodyPerChar: 0.17,
  },
};

export function layoutFor(o: Orientation): Layout {
  return o === "portrait" ? PORTRAIT : LANDSCAPE;
}
