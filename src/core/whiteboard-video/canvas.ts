/**
 * @module core/whiteboard-video/canvas
 *
 * 无限白板：把每一段摆在一块**大画布**的不同位置，段间用运镜平移过去，收尾
 * 拉远看全景。
 *
 * ## 为什么不是一页一页
 *
 * 早先每段复用同一块屏幕矩形、段间整板擦净。那套结构的观感是**翻 PPT**：每页
 * 从标题起手、写满、擦掉、下一页。而白板讲解的现场感恰恰来自"这块板一直在，
 * 讲过的东西还在上面"——观众能回头看见前面的结论，最后拉远还能看到整门课的形状。
 *
 * 擦板换页还有个副作用：讲过的内容真的消失了，于是"前面说的那个坑"只能靠嘴重述。
 * 平移到空白处则连"消失"都不发生。
 *
 * ## 为什么蛇形铺，不是一路向右
 *
 * 一路向右铺 14 段，整块画布是 14:1 的长条；收尾拉远塞进 16:9 的画幅里，每段
 * 只剩几十像素宽，全景等于什么都看不见。蛇形（向右若干格 → 下移一行 → 折回向左）
 * 能把总体外形做成接近画幅比例的一块，拉远时才真的看得见东西。
 *
 * 折回方向交替也符合"人在大白板上写字"的移动方式：不会写到最右边再横跨回最左边。
 */

import type { CamMove, CamPose } from "../whiteboard/index";

/** 画布上的一格（一段内容的地盘），画布坐标. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SerpentineOpts {
  /** 单格尺寸（通常就是画幅尺寸，这样一格正好填满一屏）. */
  cellW: number;
  cellH: number;
  /**
   * 格间横向留白占格宽的比例. Default 0.05.
   *
   * 留白刻意留得小：平移过去时相邻格的笔迹会从画面边缘擦过，观众看到的是
   * **同一块画布被拖动**，而不是切到一张干净的新板。留白给到 0.08 以上时，
   * 平移中途有一段两边都空，那一瞬间就退回"换页"的观感了。
   */
  gapXRatio?: number;
  /** 格间纵向留白占格高的比例. Default 0.07. */
  gapYRatio?: number;
}

/**
 * 每行放几格：让整块画布的外形**最接近单格的宽高比**（也就是画幅比例）。
 *
 * 逐个试而不是解析求解：格数最多几十个，穷举一遍的代价可以忽略，而闭式解要处理
 * 间隙、取整、边界（1 格、2 格）等一堆特例，容易在小格数上给出荒谬结果。
 */
export function bestPerRow(count: number, o: SerpentineOpts): number {
  if (count <= 1) return 1;
  const gapX = o.cellW * (o.gapXRatio ?? 0.05);
  const gapY = o.cellH * (o.gapYRatio ?? 0.07);
  const target = o.cellW / o.cellH;
  let best = 1;
  let bestErr = Infinity;
  for (let perRow = 1; perRow <= count; perRow++) {
    const rows = Math.ceil(count / perRow);
    const w = perRow * o.cellW + (perRow - 1) * gapX;
    const h = rows * o.cellH + (rows - 1) * gapY;
    // 用比值的对数差，避免"太宽"和"太高"被不对称地惩罚
    const err = Math.abs(Math.log(w / h) - Math.log(target));
    if (err < bestErr) {
      bestErr = err;
      best = perRow;
    }
  }
  return best;
}

/**
 * 蛇形铺格：第 0 行从左向右，第 1 行从右向左，依此交替。
 *
 * 返回的顺序**就是段落顺序**（第 i 段用 cells[i]），格子的 x/y 已经是画布坐标。
 */
export function serpentineCells(count: number, o: SerpentineOpts): Cell[] {
  if (count <= 0) return [];
  const gapX = o.cellW * (o.gapXRatio ?? 0.05);
  const gapY = o.cellH * (o.gapYRatio ?? 0.07);
  const perRow = bestPerRow(count, o);
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const idxInRow = i % perRow;
    // 奇数行反向：折回向左
    const col = row % 2 === 0 ? idxInRow : perRow - 1 - idxInRow;
    cells.push({
      x: col * (o.cellW + gapX),
      y: row * (o.cellH + gapY),
      w: o.cellW,
      h: o.cellH,
    });
  }
  return cells;
}

/** 一组格子的外接矩形. */
export function cellsBounds(cells: readonly Cell[]): Cell {
  if (cells.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...cells.map((c) => c.x));
  const y0 = Math.min(...cells.map((c) => c.y));
  const x1 = Math.max(...cells.map((c) => c.x + c.w));
  const y1 = Math.max(...cells.map((c) => c.y + c.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 单格的镜头位（一格填满一屏）. */
export function cellPose(c: Cell): CamPose {
  return [c.x + c.w / 2, c.y + c.h / 2, c.w];
}

/**
 * 能装下全部格子的镜头位（收尾全景）。
 *
 * `aspect` 是画幅宽高比：视野宽度要同时满足横向和纵向都装得下，所以取两者的
 * 较大值。`padRatio` 留一圈边距，否则最外圈的笔迹会贴着画面边缘。
 */
export function fitAllPose(
  cells: readonly Cell[],
  aspect: number,
  padRatio = 0.06,
): CamPose {
  const b = cellsBounds(cells);
  const needW = Math.max(b.w, b.h * aspect) * (1 + padRatio);
  return [b.x + b.w / 2, b.y + b.h / 2, needW];
}

export interface CameraPlanInput {
  cells: readonly Cell[];
  /** 段间平移窗口：`[起, 止]`，长度应为 cells.length - 1. */
  panWindows: ReadonlyArray<readonly [number, number]>;
  /** 收尾拉远的窗口 `[起, 止]`. */
  zoomOutWindow: readonly [number, number];
  /** 画幅宽高比（定全景视野宽度）. */
  aspect: number;
}

/**
 * 镜头计划：段间平移 + 收尾拉远。
 *
 * `cameraAt` 要求 moves 按 t0 升序且不重叠——这里天然满足（平移窗口来自依次
 * 排下来的段落）。驻留期的 Ken Burns 微漂移由 `cameraAt` 自己加。
 */
export function planCamera(input: CameraPlanInput): CamMove[] {
  const { cells, panWindows, zoomOutWindow, aspect } = input;
  if (cells.length === 0) return [];
  const moves: CamMove[] = [];
  for (let i = 1; i < cells.length; i++) {
    const win = panWindows[i - 1];
    if (win === undefined) continue;
    moves.push({
      t0: win[0],
      t1: win[1],
      from: cellPose(cells[i - 1]!),
      to: cellPose(cells[i]!),
    });
  }
  moves.push({
    t0: zoomOutWindow[0],
    t1: zoomOutWindow[1],
    from: cellPose(cells[cells.length - 1]!),
    to: fitAllPose(cells, aspect),
  });
  return moves;
}

/**
 * 某一格在当前视野里是否可见（带一点余量）。
 *
 * 用来剔除画面外的段落：无限画布上讲过的内容都留着，若每帧都把全部段落的 SVG
 * 生成一遍，帧尺寸和耗时会随"讲到第几段"线性上涨——而画面外的东西一个像素都看不到。
 */
export function cellVisible(
  c: Cell,
  pose: CamPose,
  aspect: number,
  marginRatio = 0.12,
): boolean {
  const viewW = pose[2];
  const viewH = viewW / aspect;
  const mx = viewW * marginRatio;
  const my = viewH * marginRatio;
  const vx0 = pose[0] - viewW / 2 - mx;
  const vx1 = pose[0] + viewW / 2 + mx;
  const vy0 = pose[1] - viewH / 2 - my;
  const vy1 = pose[1] + viewH / 2 + my;
  return c.x < vx1 && c.x + c.w > vx0 && c.y < vy1 && c.y + c.h > vy0;
}

/**
 * 相机位 → 画布层的 SVG 变换。
 *
 * 用**屏幕空间不变 + 只给内容层加 transform** 的方式，而不是改 `viewBox`：字幕、
 * 画面边框这些必须钉在屏幕上的东西要留在变换之外，若整体改 viewBox 它们会跟着
 * 一起缩放平移。
 *
 * 映射关系是「画布点 P → 屏幕点 S」：`S = (P − 相机中心) × scale + 屏幕中心`，
 * 所以变换要按 SVG 的从右往左结合顺序写成 translate(屏幕中心) scale translate(−相机中心)。
 */
export function cameraTransform(
  pose: CamPose,
  screenW: number,
  screenH: number,
): string {
  const scale = screenW / pose[2];
  const sx = screenW / 2;
  const sy = screenH / 2;
  // 镜头数值**不能走 fmt**（两位小数）。驻留期的微漂移整段只收 1.5% 视野，
  // 两位小数把它量化成 scale 1 → 1.01 的一次跳变：画面静了十秒，忽然整体
  // 抖一下（1% 在 1920 宽上是 19px）。同一个道理适用于平移量：0.01 画布单位
  // 的台阶在放大后仍是可见的横跳。这里的位数按"亚像素"取：scale 五位、
  // 平移三位，正好让每帧之间的差落在半个像素以内。
  return (
    `translate(${px(sx)} ${px(sy)}) scale(${zoom(scale)}) ` +
    `translate(${px(-pose[0])} ${px(-pose[1])})`
  );
}

/** 亚像素精度的平移量（见 cameraTransform 的位数说明）. */
function px(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/** 亚像素精度的缩放系数（见 cameraTransform 的位数说明）. */
function zoom(n: number): string {
  return Number(n.toFixed(5)).toString();
}

/** 当前视野在画布坐标下的矩形（画板底色/纹理要铺满它）. */
export function viewRect(pose: CamPose, aspect: number): Cell {
  const w = pose[2];
  const h = w / aspect;
  return { x: pose[0] - w / 2, y: pose[1] - h / 2, w, h };
}
