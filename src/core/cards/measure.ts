/**
 * @module @core/cards (measure)
 *
 * TextMeasure character-class width table (domain-entities.md, Q1=A):
 * a pure TS constant table, zero dependencies, inside the coverage
 * denominator.
 *
 * | class                          | em width |
 * |--------------------------------|----------|
 * | CJK ideographs / 全角标点      | 1.0      |
 * | ASCII letters/digits/punct/space | 0.5    |
 * | everything else (emoji 等)     | 1.0 (兜底) |
 *
 * Boundary rules honored here:
 * - BR-U4-1: character-class width table, never a monospace approximation.
 * - BR-U4-8: pure functions — no filesystem/Date/randomness.
 */

/**
 * Unicode ranges measured as full-width (1.0em). Kept explicit so the
 * classification is reviewable; anything not ASCII-printable falls back to
 * 1.0em anyway (兜底), so these ranges are documentation-grade precision.
 */
const FULL_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x3000, 0x303f], // CJK Symbols and Punctuation（、。〈〉《》 等）
  [0x3040, 0x30ff], // Hiragana / Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms（，！？；： 等全角标点/字母）
  [0xffe0, 0xffe6], // Fullwidth signs（￥ 等）
  [0x20000, 0x2ebef], // CJK Extensions B-F
];

/** ASCII printable range measured as half-width (0.5em). */
const ASCII_PRINTABLE = [0x20, 0x7e] as const;

/**
 * Pure function: single character (one code point) → em width.
 * CJK/full-width → 1.0; ASCII printable (letters, digits, half-width
 * punctuation, space) → 0.5; everything else (emoji 等) → 1.0 兜底.
 */
export function charWidthEm(char: string): number {
  const cp = char.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp >= ASCII_PRINTABLE[0] && cp <= ASCII_PRINTABLE[1]) return 0.5;
  for (const [lo, hi] of FULL_WIDTH_RANGES) {
    if (cp >= lo && cp <= hi) return 1.0;
  }
  return 1.0; // 兜底（emoji、扩展区、控制符以外的一切）
}

/**
 * Pure function: text → pixel width at `fontSize` (逐字累加 em × fontSize).
 * Iterates by code point so surrogate pairs (emoji) count once.
 */
export function measureText(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) {
    em += charWidthEm(char);
  }
  return em * fontSize;
}
