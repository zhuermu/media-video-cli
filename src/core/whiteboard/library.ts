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

/**
 * 一枚花瓣：长轴沿 `angleDeg` 方向、外端离中心 `reach` 的旋转椭圆。
 *
 * 椭圆中心放在半径的中点（`reach/2`），长半轴取 `reach/2`——这样花瓣的内端刚好
 * 落在花心上，外端到达 `reach`，五枚花瓣自然围成一朵花而不是一圈分离的斑点。
 */
function petalPts(
  cx: number,
  cy: number,
  angleDeg: number,
  reach: number,
  halfWidth: number,
  steps = 22,
): Pt[] {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ox = cx + ca * (reach / 2);
  const oy = cy + sa * (reach / 2);
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    // 局部坐标：u 沿长轴、v 沿短轴，再旋转到 angleDeg
    const u = (reach / 2) * Math.cos(t);
    const v = halfWidth * Math.sin(t);
    pts.push([ox + u * ca - v * sa, oy + u * sa + v * ca]);
  }
  return pts;
}

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
  /**
   * 奖杯：杯口一条横线 + 碗身外轮廓 + 两侧把手 + 杯柄 + 底座。
   *
   * 早先的画法把碗身画成"上宽下窄的梯形"，在视频里读作漏斗（实测截图里就是
   * 漏斗）：真实奖杯的碗是**圆底**的，收窄发生在下三分之一而不是一开始，而且
   * 把手要明显外凸——把手半径 8 时它贴在杯壁上，几乎看不出是把手。
   */
  trophy: {
    strokes: [
      // 杯口（一条横线：奖杯的口是敞开的，画成闭合椭圆会读作罐子）
      [
        [26, 20],
        [74, 20],
      ],
      // 碗身：两侧先近乎竖直，到下三分之一才收成圆底
      [
        [26, 20],
        [27, 34],
        [32, 48],
        [42, 56],
        [58, 56],
        [68, 48],
        [73, 34],
        [74, 20],
      ],
      // 把手（明显外凸的半环）
      ellipsePts(24, 31, 13, 13, 90, 180, 16),
      ellipsePts(76, 31, 13, 13, -90, 180, 16),
      // 杯柄
      [
        [45, 56],
        [44, 70],
        [56, 70],
        [55, 56],
      ],
      // 底座
      [
        [33, 70],
        [67, 70],
        [70, 80],
        [30, 80],
        [33, 70],
      ],
    ],
    weight: 1.3,
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

  // —— 设计稿 §5「常用图标风格（手绘）」批次 ——
  //
  // 十五个图标里已有 target / lightbulb / magnifier / cloud / trophy，
  // 这里补齐余下十个。共同约定：
  // - 都画在归一化 100×100 框内，视觉重心居中（不是包围盒居中——人形图标
  //   的头比脚小，包围盒居中会显得头重）；
  // - 笔画顺序按真人画法（先主体轮廓、后细节），因为描画动画会照这个顺序演；
  // - 一律线稿、不填色：设计稿的图标是单色线条，填色件属于 sticker 体系。

  /** 用户：圆头 + 肩线（不画全身——半身像在小尺寸下更清楚）. */
  user: {
    strokes: [
      ellipsePts(50, 30, 17, 17, -90, 360, 40),
      // 肩线：两侧向下收的弧，末端不闭合（留开口读成"身体延伸出画外"）
      ellipsePts(50, 88, 30, 30, 190, 160, 32),
    ],
    weight: 1,
  },

  /**
   * 团队：三个头 + 一条贯通的肩弧。
   *
   * 三个头而不是两个：两个人形读起来是"一对/对话"，三个才读成"一群"。
   *
   * 关键取舍是**共用一条肩弧**，而不是每人各画一条。每人一条肩弧时，单条肩宽
   * 约为头宽的 3 倍，三条必然互相穿插——在 66px 的图标尺寸下渲出来是一团带
   * 三个凸起的乱线（实测像一只蟹）。一条贯通的肩弧把"这是一群人"说得更清楚，
   * 而且笔画数从 6 降到 4，描画动画也更利落。
   */
  team: {
    strokes: [
      ellipsePts(22, 36, 12, 12, -90, 360, 26),
      ellipsePts(78, 36, 12, 12, -90, 360, 26),
      // 中间的头略大略高（前排），最后画所以压在肩弧之前
      ellipsePts(50, 28, 14, 14, -90, 360, 30),
      ellipsePts(50, 94, 42, 42, 202, 136, 34),
    ],
    weight: 1.4,
  },

  /** 电脑：屏幕框 + 底座梯形（笔记本的侧影）. */
  laptop: {
    strokes: [
      [
        [20, 22],
        [80, 22],
        [80, 62],
        [20, 62],
        [20, 23],
      ],
      // 底座：比屏幕宽的梯形（合起来才像笔记本而不是显示器）
      [
        [12, 74],
        [88, 74],
        [80, 62],
        [20, 62],
        [12, 74],
      ],
      // 触控板提示线
      line([44, 69], [56, 69]),
    ],
    weight: 1.2,
  },

  /** 手机：竖长圆角框 + 听筒 + Home 键. */
  phone: {
    strokes: [
      [
        [34, 10],
        [66, 10],
        [66, 90],
        [34, 90],
        [34, 11],
      ],
      line([45, 18], [55, 18]),
      ellipsePts(50, 82, 5, 5, 0, 360, 16),
    ],
    weight: 1,
  },

  /** 文档：纸张 + 右上折角 + 三条正文线. */
  document: {
    strokes: [
      [
        [26, 12],
        [62, 12],
        [76, 26],
        [76, 88],
        [26, 88],
        [26, 13],
      ],
      // 折角（两笔：折痕 + 折下来的边）
      [
        [62, 12],
        [62, 26],
        [76, 26],
      ],
      line([36, 44], [66, 44]),
      line([36, 58], [66, 58]),
      line([36, 72], [56, 72]),
    ],
    weight: 1.4,
  },

  /**
   * 数据库：三层圆柱（顶部椭圆 + 两条侧壁 + 两道分层弧）。
   *
   * 分层弧只画**前半段**（下半弧）：整圈画出来就变成三个独立的圆环，
   * 圆柱的立体感来自"看不见背面"。
   */
  database: {
    strokes: [
      ellipsePts(50, 24, 28, 11, 0, 360, 36),
      line([22, 24], [22, 76]),
      line([78, 24], [78, 76]),
      ellipsePts(50, 76, 28, 11, 0, 180, 20),
      ellipsePts(50, 42, 28, 11, 0, 180, 20),
      ellipsePts(50, 59, 28, 11, 0, 180, 20),
    ],
    weight: 1.5,
  },

  /** 流程：一个父节点分出两个子节点（组织/流程结构的最小可辨识形态）. */
  flow: {
    strokes: [
      [
        [36, 8],
        [64, 8],
        [64, 30],
        [36, 30],
        [36, 9],
      ],
      // 分叉连线：下 → 横 → 两侧下
      [
        [50, 30],
        [50, 44],
        [22, 44],
        [22, 58],
      ],
      [
        [50, 44],
        [78, 44],
        [78, 58],
      ],
      [
        [8, 58],
        [36, 58],
        [36, 80],
        [8, 80],
        [8, 59],
      ],
      [
        [64, 58],
        [92, 58],
        [92, 80],
        [64, 80],
        [64, 59],
      ],
    ],
    weight: 1.7,
  },

  /**
   * 设置：齿轮（八齿外轮廓 + 中心孔）。
   *
   * 齿数取 8 是可辨识下限：6 齿看起来像螺母，12 齿在小尺寸下糊成圆。
   */
  settings: {
    strokes: [
      gearPts(50, 50, 42, 30, 8),
      ellipsePts(50, 50, 13, 13, 0, 360, 24),
    ],
    weight: 1.6,
  },

  /** 时间：表盘 + 时针分针（指向 10:10，比 12:00 更有"钟"的辨识度）. */
  time: {
    strokes: [
      ellipsePts(50, 50, 40, 40, -90, 360, 60),
      line([50, 50], [50, 24]),
      line([50, 50], [70, 58]),
    ],
    weight: 1.2,
  },

  /** 安全：盾牌 + 内部对勾（"已保护"而不是"有个盾"）. */
  security: {
    strokes: [
      [
        [50, 8],
        [84, 22],
        [84, 52],
        [50, 88],
        [16, 52],
        [16, 22],
        [50, 8],
      ],
      [
        [34, 46],
        [46, 60],
        [68, 34],
      ],
    ],
    weight: 1.3,
  },

  // —— 设计稿 2.0 §6「常用贴图 / 图标库（分类）」批次 ——
  //
  // 八个分类：人物 / 物品 / 办公 / 商业 / 教育 / 科技 / 自然 / 符号。
  // 已有的 user·team（人物）、phone·laptop·time·settings·database（物品/办公/
  // 科技）、target（商业）、check·cross·heart·star（符号）不再重复。
  //
  // 共同约定同上批：归一化 100×100、视觉重心居中、笔顺按真人画法、一律线稿。

  // ---- 人物 ----

  /**
   * 女性用户：圆头 + 齐耳发（发帽弧 + 两侧发梢）+ 肩线。
   *
   * 第一版把头发画成两侧各一段外扩短弧，放大看是**头两边各一个括号**——读不出
   * 是头发。改成"上半圈发帽 + 两条竖下来的发梢"：发帽压在头顶轮廓外一点，发梢
   * 落到耳下，这两笔才让人认出发型。
   */
  "person-female": {
    strokes: [
      ellipsePts(50, 30, 17, 17, -90, 360, 40),
      // 发帽：略大于头的上半圈
      ellipsePts(50, 30, 21, 21, 180, 180, 26),
      // 两侧发梢
      line([29, 30], [27, 48]),
      line([71, 30], [73, 48]),
      ellipsePts(50, 88, 30, 30, 190, 160, 32),
    ],
    weight: 1.5,
  },

  /** 讲解者：人 + 举起的手臂（"我在讲"）. */
  "person-speaker": {
    strokes: [
      ellipsePts(42, 28, 15, 15, -90, 360, 36),
      ellipsePts(42, 86, 28, 28, 192, 156, 30),
      // 举起的手臂：肩 → 肘 → 手
      [
        [62, 62],
        [76, 50],
        [86, 34],
      ],
    ],
    weight: 1.4,
  },

  // ---- 物品 ----

  /** 文件：纸张 + 折角（无正文线，与 document 区分：document 带三条文字线）. */
  file: {
    strokes: [
      [
        [28, 12],
        [62, 12],
        [74, 24],
        [74, 88],
        [28, 88],
        [28, 13],
      ],
      [
        [62, 12],
        [62, 24],
        [74, 24],
      ],
    ],
    weight: 1,
  },

  /** 书本：翻开的两页 + 中缝. */
  book: {
    strokes: [
      [
        [10, 24],
        [48, 32],
        [48, 84],
        [10, 74],
        [10, 25],
      ],
      [
        [90, 24],
        [52, 32],
        [52, 84],
        [90, 74],
        [90, 25],
      ],
      line([48, 32], [52, 32]),
    ],
    weight: 1.4,
  },

  /** 礼物：盒子 + 十字丝带 + 蝴蝶结. */
  gift: {
    strokes: [
      [
        [16, 34],
        [84, 34],
        [84, 86],
        [16, 86],
        [16, 35],
      ],
      line([16, 48], [84, 48]),
      line([50, 34], [50, 86]),
      ellipsePts(40, 26, 10, 9, 20, 300, 20),
      ellipsePts(60, 26, 10, 9, -140, 300, 20),
    ],
    weight: 1.5,
  },

  // ---- 办公 ----

  /** 日历：外框 + 挂环 + 表头分隔线. */
  calendar: {
    strokes: [
      [
        [14, 22],
        [86, 22],
        [86, 86],
        [14, 86],
        [14, 23],
      ],
      line([14, 40], [86, 40]),
      line([32, 12], [32, 28]),
      line([68, 12], [68, 28]),
      line([30, 56], [46, 56]),
      line([56, 56], [72, 56]),
    ],
    weight: 1.5,
  },

  /**
   * 文件夹：夹身 + 左上凸起的标签页。
   *
   * 拆成**两笔**（夹身一个闭合矩形、标签一段折线）而不是一笔连通的轮廓：一笔画
   * 时那个"标签台阶"会和夹身的上边连成一条斜线，放大看是个口袋/布袋，认不出是
   * 文件夹。两笔之后标签是独立可辨的一块。
   */
  folder: {
    strokes: [
      [
        [12, 42],
        [88, 42],
        [88, 84],
        [12, 84],
        [12, 43],
      ],
      [
        [12, 42],
        [16, 28],
        [42, 28],
        [46, 42],
      ],
    ],
    weight: 1.3,
  },

  /** 打印机：机身 + 出纸 + 面板灯. */
  printer: {
    strokes: [
      [
        [16, 44],
        [84, 44],
        [84, 74],
        [16, 74],
        [16, 45],
      ],
      // 上方待打印的纸
      [
        [30, 44],
        [30, 20],
        [70, 20],
        [70, 44],
      ],
      // 下方吐出的纸
      [
        [32, 74],
        [32, 90],
        [68, 90],
        [68, 74],
      ],
      line([72, 54], [78, 54]),
    ],
    weight: 1.6,
  },

  // ---- 商业 ----

  /** 图表：坐标轴 + 三根柱（商业分类的"报表"）. */
  chart: {
    strokes: [
      [
        [16, 14],
        [16, 84],
        [88, 84],
      ],
      [
        [28, 84],
        [28, 60],
        [42, 60],
        [42, 84],
      ],
      [
        [46, 84],
        [46, 40],
        [60, 40],
        [60, 84],
      ],
      [
        [64, 84],
        [64, 24],
        [78, 24],
        [78, 84],
      ],
    ],
    weight: 1.6,
  },

  /** 增长：向右上的折线 + 箭头（与 chart 的区别是"趋势"而非"数量"）. */
  growth: {
    strokes: [
      [
        [14, 78],
        [36, 58],
        [54, 66],
        [84, 26],
      ],
      [
        [66, 26],
        [86, 24],
        [84, 44],
      ],
    ],
    weight: 1,
  },

  /** 金钱：钱袋 + 束口 + 货币符号（不用具体币种，避免地域化）. */
  money: {
    strokes: [
      [
        [34, 30],
        [66, 30],
        [82, 60],
        [72, 86],
        [28, 86],
        [18, 60],
        [34, 30],
      ],
      [
        [36, 30],
        [32, 18],
        [68, 18],
        [64, 30],
      ],
      line([50, 44], [50, 74]),
      ellipsePts(50, 52, 10, 8, -20, 200, 18),
      ellipsePts(50, 66, 10, 8, 160, 200, 18),
    ],
    weight: 1.8,
  },

  // ---- 教育 ----

  /** 黑板：板面 + 支架 + 板上一条线. */
  blackboard: {
    strokes: [
      [
        [12, 18],
        [88, 18],
        [88, 68],
        [12, 68],
        [12, 19],
      ],
      line([26, 36], [62, 36]),
      line([26, 50], [48, 50]),
      [
        [30, 68],
        [24, 88],
      ],
      [
        [70, 68],
        [76, 88],
      ],
    ],
    weight: 1.7,
  },

  /** 铅笔：笔身 + 笔尖 + 笔头分隔线. */
  pencil: {
    strokes: [
      [
        [22, 84],
        [30, 60],
        [70, 18],
        [84, 30],
        [44, 72],
        [22, 84],
      ],
      line([30, 60], [44, 72]),
      line([64, 24], [78, 36]),
    ],
    weight: 1.3,
  },

  /** 毕业帽：菱形帽面 + 帽檐 + 流苏. */
  graduation: {
    strokes: [
      [
        [50, 22],
        [90, 40],
        [50, 58],
        [10, 40],
        [50, 22],
      ],
      [
        [26, 48],
        [26, 70],
        [50, 80],
        [74, 70],
        [74, 48],
      ],
      [
        [86, 44],
        [86, 70],
      ],
      ellipsePts(86, 74, 5, 5, 0, 360, 14),
    ],
    weight: 1.7,
  },

  // ---- 科技 ----

  /** 机器人：头 + 天线 + 眼睛 + 身体. */
  robot: {
    strokes: [
      [
        [24, 26],
        [76, 26],
        [76, 62],
        [24, 62],
        [24, 27],
      ],
      line([50, 10], [50, 26]),
      ellipsePts(50, 8, 5, 5, 0, 360, 14),
      ellipsePts(38, 42, 6, 6, 0, 360, 14),
      ellipsePts(62, 42, 6, 6, 0, 360, 14),
      [
        [34, 62],
        [34, 86],
        [66, 86],
        [66, 62],
      ],
    ],
    weight: 1.8,
  },

  /** 芯片：方形本体 + 四边引脚. */
  chip: {
    strokes: [
      [
        [28, 28],
        [72, 28],
        [72, 72],
        [28, 72],
        [28, 29],
      ],
      line([40, 28], [40, 14]),
      line([60, 28], [60, 14]),
      line([40, 72], [40, 86]),
      line([60, 72], [60, 86]),
      line([28, 40], [14, 40]),
      line([28, 60], [14, 60]),
      line([72, 40], [86, 40]),
      line([72, 60], [86, 60]),
    ],
    weight: 2,
  },

  /** 云同步：云 + 内部双向箭头. */
  "cloud-sync": {
    strokes: [
      [
        ...ellipsePts(32, 52, 16, 14, 90, 200, 24),
        ...ellipsePts(50, 38, 18, 16, 170, 190, 28),
        ...ellipsePts(70, 50, 15, 13, 250, 200, 24),
        [78, 64],
        [26, 64],
      ],
      [
        [36, 80],
        [64, 80],
      ],
      [
        [56, 72],
        [66, 80],
        [56, 88],
      ],
    ],
    weight: 1.4,
  },

  // ---- 自然 ----

  /** 树：树冠（三层）+ 树干. */
  tree: {
    strokes: [
      [
        [50, 8],
        [72, 40],
        [28, 40],
        [50, 8],
      ],
      [
        [50, 28],
        [78, 62],
        [22, 62],
        [50, 28],
      ],
      [
        [44, 62],
        [44, 88],
        [56, 88],
        [56, 62],
      ],
    ],
    weight: 1.5,
  },

  /**
   * 花：五枚径向花瓣 + 花心 + 茎。
   *
   * 花瓣必须是**沿半径拉长的椭圆**，不能是圆。第一版用五个圆，放大看是"一串
   * 葡萄/气球"——圆没有方向性，五个圆挨在一起只是一堆圆。拉长并让长轴指向圆心，
   * 才读出"从中心长出来的花瓣"。
   */
  flower: {
    strokes: [
      ...[0, 1, 2, 3, 4].map((k) => petalPts(50, 42, -90 + k * 72, 42, 10)),
      ellipsePts(50, 42, 6, 6, 0, 360, 16),
      line([50, 64], [50, 94]),
    ],
    weight: 1.9,
  },

  /** 山：双峰 + 雪线. */
  mountain: {
    strokes: [
      [
        [8, 80],
        [36, 30],
        [54, 58],
        [64, 44],
        [92, 80],
        [8, 80],
      ],
      [
        [28, 44],
        [36, 38],
        [44, 46],
      ],
    ],
    weight: 1.4,
  },

  /** 太阳：圆 + 八条光线（等长，太阳就该是等长的）. */
  sun: {
    strokes: [
      ellipsePts(50, 50, 22, 22, 0, 360, 32),
      line([50, 8], [50, 20]),
      line([50, 80], [50, 92]),
      line([8, 50], [20, 50]),
      line([80, 50], [92, 50]),
      line([20, 20], [29, 29]),
      line([71, 71], [80, 80]),
      line([80, 20], [71, 29]),
      line([29, 71], [20, 80]),
    ],
    weight: 1.9,
  },

  // ---- 符号 ----

  /** 问号：弯钩 + 下方的点. */
  question: {
    strokes: [
      [...ellipsePts(50, 34, 20, 20, 190, 210, 30), [50, 58], [50, 68]],
      line([50, 82], [50, 84]),
    ],
    weight: 1,
  },

  /** 感叹号：竖线 + 下方的点. */
  exclaim: {
    strokes: [line([50, 16], [50, 66]), line([50, 82], [50, 84])],
    weight: 0.6,
  },
};

/**
 * 齿轮外轮廓：在外/内两个半径之间交替落点，每个齿由 4 个点构成
 * （齿根 → 齿顶起 → 齿顶止 → 齿根），得到方齿而不是尖齿。
 */
function gearPts(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  teeth: number,
): Pt[] {
  const pts: Pt[] = [];
  const step = (Math.PI * 2) / teeth;
  // 齿顶占单齿角度的 46%（留出齿间空隙，否则齿顶相接成圆）
  const half = step * 0.23;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    const at = (r: number, ang: number): Pt => [
      cx + r * Math.cos(ang),
      cy + r * Math.sin(ang),
    ];
    pts.push(
      at(rInner, a - half * 1.5),
      at(rOuter, a - half),
      at(rOuter, a + half),
      at(rInner, a + half * 1.5),
    );
  }
  pts.push(pts[0]!);
  return pts;
}

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

/**
 * 设计稿 2.0 §6 的分类索引。
 *
 * 图标到了五十多个之后，扁平的一张表就不再可用了：写文章的人（或上游 LLM）
 * 需要"这一段讲团队协作，有哪些人物类图标"这种检索方式，而不是通读全表。
 *
 * 一个图标**可以出现在多个分类**里（`time` 既是办公也是符号语义），所以这里
 * 是分类 → 名字数组，不是名字 → 分类。分类只是入口，不改变图标本身。
 */
export const ICON_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  人物: ["user", "person-female", "person-speaker", "team"],
  物品: ["phone", "file", "book", "gift", "document"],
  办公: ["laptop", "calendar", "time", "folder", "printer"],
  商业: ["chart", "growth", "target", "money", "trophy"],
  教育: ["blackboard", "book", "pencil", "graduation"],
  科技: ["robot", "chip", "cloud-sync", "database", "settings", "security"],
  自然: ["tree", "flower", "mountain", "sun", "cloud"],
  符号: ["check", "cross", "question", "exclaim", "heart", "star"],
  强调: [
    "lightbulb",
    "magnifier",
    "fire",
    "sparkles",
    "rocket",
    "crown",
    "flag",
    "pin",
  ],
};

/** 分类名清单（顺序即设计稿 §6 的排列顺序）. */
export const ICON_CATEGORY_NAMES = Object.keys(ICON_CATEGORIES);

/**
 * 某个分类下的图标名（未知分类返回空数组）。
 *
 * 同时兜住一个真实风险：分类表是手写的，很容易写进一个**不存在的图标名**
 * （改名字或删图标时漏改这里）。所以这里过滤掉库里没有的名字，而不是把
 * 一个空图标交给渲染层——`iconPaths` 对未知名返回空折线组，会静默少画一个
 * 元素，那种缺失极难在成片里发现。
 */
export function iconsInCategory(category: string): string[] {
  const names = ICON_CATEGORIES[category];
  if (names === undefined) return [];
  return names.filter((n) => LINE_ART[n] !== undefined);
}

/**
 * 分类表自检：返回所有"分类里写了、但库里没有"的名字。
 *
 * 供测试调用——这是一个断言点而不是运行时逻辑：分类表写错名字属于开发期
 * 错误，应该在测试里红，不该在渲染时静默降级。
 */
export function danglingCategoryIcons(): string[] {
  const bad: string[] = [];
  for (const names of Object.values(ICON_CATEGORIES)) {
    for (const n of names) {
      if (LINE_ART[n] === undefined) bad.push(n);
    }
  }
  return bad;
}

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
