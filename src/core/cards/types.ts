/**
 * @module @core/cards (types)
 *
 * Locked card types (component-methods.md 核心类型定义: PngFile /
 * CardTemplate) plus the U4 layout value objects (domain-entities.md:
 * CardLayout / EmphasisRange).
 *
 * CardTemplate additive extension (documented deviation, U5-style):
 * `foreground` and `accent` are added to the locked shape — the SVG text
 * fill and the emphasis highlight need concrete colors, and the WCAG
 * contrast check (BR-U4-11) needs a foreground to check against. No locked
 * field was changed or removed.
 */

/** Rendered PNG artifact (locked fields, component-methods.md). */
export interface PngFile {
  path: string;
  width: number;
  height: number;
}

/** Card template (locked fields + additive foreground/accent, see above). */
export interface CardTemplate {
  name: string;
  /** 背景：颜色（#rrggbb）或资产路径. */
  background: string;
  /** 正文/要点前景色（additive; WCAG 对比度检查对象, BR-U4-11）. */
  foreground: string;
  /** emphasis 高亮色（additive; 同受对比度检查）. */
  accent: string;
  fontFamily: string;
  titleSize: number;
  bodySize: number;
  safeArea: { top: number; bottom: number; left: number; right: number };
  /** 要点区换行容量（按 1.0em×titleSize 折算；超出抛 ValidationError）. */
  maxCharsPerLine: number;
  maxLines: number;
  /**
   * 背景照片上的遮罩色（additive；仅当卡片带 backgroundImage 时渲染）.
   * 缺省 {@link DEFAULT_OVERLAY_COLOR}.
   */
  overlayColor?: string;
  /**
   * 遮罩不透明度（additive；范围 [0, {@link MAX_OVERLAY_OPACITY}]，模板
   * 校验强制）. 缺省 {@link DEFAULT_OVERLAY_OPACITY}.
   */
  overlayOpacity?: number;
}

/** 背景照片遮罩缺省色（黑色，压暗照片保文字对比度）. */
export const DEFAULT_OVERLAY_COLOR = "#000000";

/** 背景照片遮罩缺省不透明度. */
export const DEFAULT_OVERLAY_OPACITY = 0.55;

/** 遮罩不透明度上限（再高照片近乎不可见，失去配图意义）. */
export const MAX_OVERLAY_OPACITY = 0.85;

/** Fixed 9:16 canvas (FR-3: 1080×1920 vertical video). */
export const CANVAS = { width: 1080, height: 1920 } as const;

/** One emphasis highlight span located inside titleLines (code-point units). */
export interface EmphasisRange {
  /** titleLines 行号（0 起）. */
  line: number;
  /** 行内起始列（code point 计数）. */
  start: number;
  /** 长度（code point 计数）. */
  len: number;
}

/**
 * Layout computation result — a pure value object (snapshot-test anchor,
 * BR-U4-8: no filesystem/Date/randomness anywhere in its production).
 *
 * 背景照片经两个字段分工以保住 buildCardSvg 的纯函数性：
 * `backgroundImage` 只做路径记账（layoutCard 透传 segment 原值，frames.ts
 * 在栅格化前解析为绝对路径），`backgroundImageDataUri` 由 frames.ts 读文件
 * + base64 后填入——SVG 生成只消费 data URI 字符串，永不碰文件系统。
 */
export interface CardLayout {
  /** 卡片要点文案的换行结果（cardText 经度量换行 + 避头）. */
  titleLines: string[];
  /** 字幕分页（Q3=A）：每页 ≤3 行口播文字；至少一页（每段至少一帧）. */
  subtitlePages: string[][];
  /** 高亮词在行内的定位（emphasis 子串规则；找不到即跳过）. */
  emphasisRanges: EmphasisRange[];
  /**
   * 背景照片路径（layoutCard 透传 segment 原值；frames.ts 解析为绝对
   * 路径并检查存在性）. buildCardSvg 不读此字段.
   */
  backgroundImage?: string;
  /**
   * 背景照片 base64 data URI（frames.ts 读文件填入；buildCardSvg 仅消费
   * 此字符串，保持 BR-U4-8 纯函数不变式）.
   */
  backgroundImageDataUri?: string;
}
