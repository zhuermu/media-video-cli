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
}

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
 */
export interface CardLayout {
  /** 卡片要点文案的换行结果（cardText 经度量换行 + 避头）. */
  titleLines: string[];
  /** 字幕分页（Q3=A）：每页 ≤3 行口播文字；至少一页（每段至少一帧）. */
  subtitlePages: string[][];
  /** 高亮词在行内的定位（emphasis 子串规则；找不到即跳过）. */
  emphasisRanges: EmphasisRange[];
}
