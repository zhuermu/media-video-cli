/**
 * @module @core/whiteboard (types)
 *
 * Whiteboard 手绘动画渲染的类型契约：主题（配色/纸面/笔）、场景元素 DSL
 * （script schema 的 additive 扩展在 @core/script 侧引用这里的 shape）、
 * 规划产物（WhiteboardPlan）。
 *
 * Boundary rules honored here:
 * - 与 @core/cards 同构的纯度契约：类型字段全部是 path/number/string/
 *   plain object——无 Date、无随机、无可变引用（快照可测）。
 * - 主题模板化（质感维度 E）：配色/网格/笔倾角收敛为 WhiteboardTheme，
 *   内置多套可选，禁止在渲染代码里散落硬编码颜色。
 */

/** 输出画幅（与 cards 的 CANVAS 一致：竖版 9:16）. */
export const OUT = { width: 1080, height: 1920 } as const;

/** 大画布单元格 = 一个场景的镜头框（与输出画幅同尺寸）. */
export const CELL = { width: 1080, height: 1920 } as const;

/** 默认输出帧率（白板手绘风格 30fps 已足够顺滑）. */
export const DEFAULT_FPS = 30;

/** 纸面网格风格. */
export type GridStyle = "dots" | "ruled" | "none";

/** Whiteboard 主题：纸面 + 墨色 + 强调色 + 笔参数（质感维度 E 的模板化）. */
export interface WhiteboardTheme {
  name: string;
  /** 纸面底色（暖白优于纯白，降低刺眼感）. */
  paper: string;
  grid: GridStyle;
  gridColor: string;
  /** 主墨色（文字/主线条）. */
  ink: string;
  /** 强调色（下划线/曲线/圈注/勾）. */
  accent: string;
  /** 强调色的浅填充（柱体填色/色块装饰）. */
  accentSoft: string;
  /** 次要色（辅助线/注释）. */
  muted: string;
  /** 笔贴图静态倾角（度，书写时叠加微幅摆动）. */
  penTiltDeg: number;
}

/** 内置主题表（Q5=D 混合体系的三套起步配色）. */
export const THEMES: Record<string, WhiteboardTheme> = {
  clean: {
    name: "clean",
    paper: "#fbfaf6",
    grid: "dots",
    gridColor: "#e9e6de",
    ink: "#23272f",
    accent: "#e8590c",
    accentSoft: "#e8590c",
    muted: "#98a0ab",
    penTiltDeg: 33,
  },
  ocean: {
    name: "ocean",
    paper: "#f8fafc",
    grid: "dots",
    gridColor: "#e2e8f0",
    ink: "#1e293b",
    accent: "#2563eb",
    accentSoft: "#2563eb",
    muted: "#94a3b8",
    penTiltDeg: 33,
  },
  forest: {
    name: "forest",
    paper: "#fafaf7",
    grid: "ruled",
    gridColor: "#e6e8e2",
    ink: "#252b25",
    accent: "#0d9464",
    accentSoft: "#0d9464",
    muted: "#9aa39a",
    penTiltDeg: 33,
  },
};

/** 默认主题名. */
export const DEFAULT_THEME = "clean";

// ---- 场景元素 DSL（script schema 的 additive 扩展引用此 shape） ----

/** 图表预设种类. */
export type ChartKind = "bars-up" | "line-up" | "steps";

/**
 * 一个场景元素：LLM 生成 script 时按语义声明"画什么"，坐标由自动版式
 * 决定（竖排流式布局），避免让脚本生成方关心像素。
 */
export type SceneElement =
  | {
      /** 大标题手写（真笔顺；非 CJK 字符回退扫掠揭示）. */
      type: "title";
      text: string;
      /** 是否加强调下划线. */
      underline?: boolean;
    }
  | {
      /** 正文手写行. */
      type: "text";
      text: string;
    }
  | {
      /** 带对勾的要点行. */
      type: "bullet";
      text: string;
    }
  | {
      /** 元素库线稿图标（笔描画）. */
      type: "icon";
      name: string;
      /** 用强调色描画. */
      accent?: boolean;
      /** 图标下方的小标注（手写）. */
      label?: string;
    }
  | {
      /** 图表预设（坐标轴 + 数据形态，笔描画 + 填色淡入）. */
      type: "chart";
      chart: ChartKind;
      label?: string;
    }
  | {
      /** 照片拉入（拍立得样式滑入 + 可选圈注）. */
      type: "image";
      /** 相对 input/images/ 或绝对路径（同 cards.backgroundImage 约定）. */
      src: string;
      circle?: boolean;
      label?: string;
    }
  | {
      /** 色块装饰件（Q5=D：拉入式，非笔描）. */
      type: "sticker";
      name: string;
    };

/** 一段口播对应的场景描述（script.segments[].scene）. */
export interface WhiteboardScene {
  elements: SceneElement[];
}

/** scene.elements 数量上限（版式容量 + 单段时长约束）. */
export const SCENE_ELEMENTS_MAX = 6;

// ---- 时间轴/规划产物 ----

/** 时间轴元素：t<t0 不可见，[t0,t1] 入场动画，t>t1 定格. */
export interface TimelineEl {
  t0: number;
  t1: number;
  svg(t: number): string;
  /** 笔尖画布坐标（仅笔描元素提供；区间外 null）. */
  pen?(t: number): readonly [number, number] | null;
  /**
   * 画布坐标包围盒 [x0, y0, x1, y1]（规划器按场景单元格 + 入场余量
   * 填写）。帧渲染用它做视口剔除：完全在镜头外的元素不进 SVG——
   * 既缩小每帧体积，也规避 resvg 对"部分轴相交的画外 opacity 图层"
   * 的原生崩溃（geom.rs unwrap panic）。
   */
  bbox?: readonly [number, number, number, number];
}

/** 镜头位（画布坐标中心 + 视野宽，高按 9:16 推导）. */
export type CamPose = readonly [cx: number, cy: number, viewW: number];

/** 镜头移动（两点间 ease，之外保持端点）. */
export interface CamMove {
  t0: number;
  t1: number;
  from: CamPose;
  to: CamPose;
}

/** 笔活跃区间（音效混音的输入：这段时间笔在纸上写）. */
export interface PenActiveSpan {
  t0: number;
  t1: number;
}

/** planWhiteboard 的产物：帧渲染器的全部输入. */
export interface WhiteboardPlan {
  theme: WhiteboardTheme;
  /** 大画布尺寸（按场景数网格推导）. */
  canvasW: number;
  canvasH: number;
  els: TimelineEl[];
  camMoves: CamMove[];
  /** 笔退场完成时刻（此后不再渲染笔）. */
  penExitAt: number;
  /** 笔在纸上书写的区间表（升序、不重叠）. */
  penActive: PenActiveSpan[];
  /** 总时长（= Σ实测段时长，音画对齐锚点）. */
  totalSec: number;
}
