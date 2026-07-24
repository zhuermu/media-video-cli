/**
 * @module @core/cards (layout)
 *
 * layoutCard — the pure layout core (Workflow 1): cardText wrapping with
 * 避头 handling, subtitle pagination, and emphasis positioning.
 *
 * Boundary rules honored here:
 * - BR-U4-1: per-character width table measurement ({@link charWidthEm}).
 * - BR-U4-2: 避头 — a line must not start with 全角句读（，。！？；：、）;
 *   the punctuation carries the previous character down with it.
 * - BR-U4-4: subtitle overflow paginates（禁截断/禁缩字号）— 3 行/页.
 * - BR-U4-8: pure function — no filesystem/Date/randomness (snapshot anchor).
 */

import { ValidationError } from "@core/errors";
import type { Segment } from "@core/script";

import { charWidthEm } from "./measure";
import { CANVAS } from "./types";
import type { CardLayout, CardTemplate, EmphasisRange } from "./types";

/** 避头字符集：行首禁止落这些全角句读（BR-U4-2）. */
export const FORBIDDEN_LINE_START = new Set([
  "，",
  "。",
  "！",
  "？",
  "；",
  "：",
  "、",
]);

/** 字幕区每页行数上限（domain-entities: 每页 ≤3 行，与 safeArea.bottom 协同）. */
export const SUBTITLE_LINES_PER_PAGE = 3;

/** Float guard for the width accumulation (widths are exact halves). */
const EPS = 1e-6;

/** One placed character: the glyph plus its source code-point index. */
interface PlacedChar {
  ch: string;
  idx: number;
}

/**
 * Pure wrap core: text → lines of placed characters. Greedy per-character
 * accumulation (逐字累加超 maxWidth 即换行) with the 避头 carry rule: when a
 * forbidden punctuation would start a new line, the previous character is
 * carried down with it (only when the previous line keeps ≥1 character —
 * degenerate sub-2em widths fall back to a plain wrap).
 */
function wrapText(
  text: string,
  fontSize: number,
  maxWidthPx: number,
): PlacedChar[][] {
  const lines: PlacedChar[][] = [];
  let current: PlacedChar[] = [];
  let currentWidth = 0;

  const codePoints = [...text];
  for (let i = 0; i < codePoints.length; i++) {
    const ch = codePoints[i]!;
    const w = charWidthEm(ch) * fontSize;
    if (current.length > 0 && currentWidth + w > maxWidthPx + EPS) {
      if (FORBIDDEN_LINE_START.has(ch) && current.length >= 2) {
        const carried = current.pop()!;
        lines.push(current);
        current = [carried];
        currentWidth = charWidthEm(carried.ch) * fontSize;
      } else {
        lines.push(current);
        current = [];
        currentWidth = 0;
      }
    }
    current.push({ ch, idx: i });
    currentWidth += w;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Joins a placed-character line back into a string. */
function lineText(line: PlacedChar[]): string {
  return line.map((c) => c.ch).join("");
}

/** Finds `needle` inside `haystack` (both code-point arrays); -1 if absent. */
function findCodePoints(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Pure function (Workflow 1): segment + subtitle text + template →
 * {@link CardLayout}.
 *
 * 1. 要点区换行: cardText per-character measurement → titleLines;
 *    >maxLines → ValidationError (defensive; upstream BR-U3 cardText≤80
 *    should prevent this).
 * 2. 避头处理: inside {@link wrapText}.
 * 3. 字幕分页: subtitleText wrapped at bodySize over the subtitle area
 *    width, {@link SUBTITLE_LINES_PER_PAGE} lines per page; always ≥1 page
 *    (每段至少一帧 invariant).
 * 4. emphasis 定位: first occurrence per term located in titleLines;
 *    cross-line spans yield one range per line; absent terms are skipped.
 * 5. backgroundImage 透传: segment 原值原样进 layout（相对/绝对路径的
 *    解析与文件读取在 frames.ts — 那里才有 VideoDir）.
 *
 * @throws ValidationError when cardText exceeds the template capacity.
 */
export function layoutCard(
  segment: Segment,
  subtitleText: string,
  template: CardTemplate,
): CardLayout {
  // 1+2. Title wrap (capacity: maxCharsPerLine × 1.0em × titleSize).
  const titleMaxWidth = template.maxCharsPerLine * template.titleSize;
  const titleWrap = wrapText(
    segment.cardText,
    template.titleSize,
    titleMaxWidth,
  );
  if (titleWrap.length > template.maxLines) {
    throw new ValidationError(
      `cardText 超出模板容量: 需要 ${titleWrap.length} 行 > maxLines ${template.maxLines}` +
        `（模板 "${template.name}" 每行 ${template.maxCharsPerLine} 全角字符）。` +
        `请精简 cardText（上游约束 ≤80 字符）: "${segment.cardText}"`,
    );
  }
  const titleLines = titleWrap.map(lineText);

  // 3. Subtitle pagination (line width = canvas minus side margins, at bodySize).
  const subtitleMaxWidth =
    CANVAS.width - template.safeArea.left - template.safeArea.right;
  const subtitleLines =
    subtitleText.length === 0
      ? []
      : wrapText(subtitleText, template.bodySize, subtitleMaxWidth).map(
          lineText,
        );
  const subtitlePages: string[][] = [];
  for (let i = 0; i < subtitleLines.length; i += SUBTITLE_LINES_PER_PAGE) {
    subtitlePages.push(subtitleLines.slice(i, i + SUBTITLE_LINES_PER_PAGE));
  }
  if (subtitlePages.length === 0) subtitlePages.push([]); // 每段至少一帧

  // 4. Emphasis positioning over the title wrap (code-point coordinates).
  const positionOf: Array<{ line: number; col: number }> = [];
  titleWrap.forEach((line, lineIdx) => {
    line.forEach((placed, col) => {
      positionOf[placed.idx] = { line: lineIdx, col };
    });
  });

  const cardCodePoints = [...segment.cardText];
  const emphasisRanges: EmphasisRange[] = [];
  for (const term of segment.emphasis ?? []) {
    const start = findCodePoints(cardCodePoints, [...term]);
    if (start === -1) continue; // 子串缺失即跳过（上游 BR-U3-10 保证存在）
    let currentRange: EmphasisRange | undefined;
    for (let k = start; k < start + [...term].length; k++) {
      const pos = positionOf[k]!;
      if (
        currentRange !== undefined &&
        currentRange.line === pos.line &&
        currentRange.start + currentRange.len === pos.col
      ) {
        currentRange.len += 1;
      } else {
        if (currentRange !== undefined) emphasisRanges.push(currentRange);
        currentRange = { line: pos.line, start: pos.col, len: 1 };
      }
    }
    if (currentRange !== undefined) emphasisRanges.push(currentRange);
  }

  // 5. Background photo passthrough（原值透传，保持纯函数：解析为绝对
  //    路径需要 VideoDir 上下文，发生在 frames.ts）.
  const layout: CardLayout = { titleLines, subtitlePages, emphasisRanges };
  if (segment.backgroundImage !== undefined) {
    layout.backgroundImage = segment.backgroundImage;
  }
  return layout;
}
