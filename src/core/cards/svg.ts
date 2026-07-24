/**
 * @module @core/cards (svg)
 *
 * buildCardSvg — pure SVG string generation (Workflow 2): background →
 * optional background photo (cover-fit) + dark overlay → title lines
 * (emphasis highlighted via accent-filled tspans) → subtitle page lines →
 * page-dot indicator (multi-page only).
 *
 * Boundary rules honored here:
 * - BR-U4-7: every text node is XML-escaped (&<>"') — injection defense.
 * - BR-U4-8: pure function — no filesystem/Date/randomness; same input →
 *   character-identical output (FR-3.3 AC-1 snapshot anchor). 背景照片
 *   以 layout.backgroundImageDataUri（frames.ts 预读的 base64 字符串）
 *   进入——本模块永不读文件.
 */

import { ValidationError } from "@core/errors";

import {
  CANVAS,
  DEFAULT_OVERLAY_COLOR,
  DEFAULT_OVERLAY_OPACITY,
} from "./types";
import type { CardLayout, CardTemplate, EmphasisRange } from "./types";

/** Title line height factor (baseline-to-baseline = titleSize × this). */
const TITLE_LINE_HEIGHT = 1.5;

/** Subtitle line height factor. */
const SUBTITLE_LINE_HEIGHT = 1.4;

/** Page-dot geometry: radius / center spacing / distance from bottom edge. */
const PAGE_DOT = { radius: 8, spacing: 36, marginBottom: 48 } as const;

/** Escapes the five XML special characters in a text node (BR-U4-7). */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Renders one title line's inner content: plain runs escaped as-is,
 * emphasis runs wrapped in accent-filled tspans. Ranges are clamped and
 * de-overlapped defensively (code-point coordinates from layoutCard).
 */
function renderTitleLineContent(
  line: string,
  lineIndex: number,
  ranges: EmphasisRange[],
  accent: string,
): string {
  const codePoints = [...line];
  const lineRanges = ranges
    .filter((r) => r.line === lineIndex)
    .sort((a, b) => a.start - b.start);

  let cursor = 0;
  let out = "";
  for (const range of lineRanges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.start + range.len, codePoints.length);
    if (end <= start) continue;
    if (start > cursor) {
      out += escapeXml(codePoints.slice(cursor, start).join(""));
    }
    out += `<tspan fill="${escapeXml(accent)}">${escapeXml(
      codePoints.slice(start, end).join(""),
    )}</tspan>`;
    cursor = end;
  }
  if (cursor < codePoints.length) {
    out += escapeXml(codePoints.slice(cursor).join(""));
  }
  return out;
}

/**
 * Pure function (Workflow 2): layout page → 1080×1920 SVG string.
 *
 * Deterministic assembly order: background rect → [background photo
 * (cover-fit `slice`) + overlay rect, 仅当 layout.backgroundImageDataUri
 * 存在] → title text elements → subtitle text elements for `page` → page
 * dots (only when the layout has more than one subtitle page).
 *
 * @throws ValidationError when `page` is outside [0, subtitlePages.length).
 */
export function buildCardSvg(
  layout: CardLayout,
  page: number,
  template: CardTemplate,
): string {
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    page >= layout.subtitlePages.length
  ) {
    throw new ValidationError(
      `页码越界: ${page}（该布局共 ${layout.subtitlePages.length} 页）`,
    );
  }

  const fontFamily = escapeXml(`${template.fontFamily}, sans-serif`);
  const foreground = escapeXml(template.foreground);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">`,
  );
  parts.push(
    `  <rect width="${CANVAS.width}" height="${CANVAS.height}" fill="${escapeXml(template.background)}"/>`,
  );

  // 背景照片（cover-fit 满幅）+ 深色遮罩。data URI 仅含 base64 字符集
  // （[A-Za-z0-9+/=] 与 "data:image/...;base64," 前缀），不含 XML 特殊
  // 字符——escapeXml 恒等通过，防御性保留（BR-U4-7）。
  if (layout.backgroundImageDataUri !== undefined) {
    const overlayColor = template.overlayColor ?? DEFAULT_OVERLAY_COLOR;
    const overlayOpacity = template.overlayOpacity ?? DEFAULT_OVERLAY_OPACITY;
    parts.push(
      `  <image href="${escapeXml(layout.backgroundImageDataUri)}" width="${CANVAS.width}" height="${CANVAS.height}" preserveAspectRatio="xMidYMid slice"/>`,
    );
    parts.push(
      `  <rect width="${CANVAS.width}" height="${CANVAS.height}" fill="${escapeXml(overlayColor)}" fill-opacity="${overlayOpacity}"/>`,
    );
  }

  // 要点区（title lines, emphasis via accent tspans）.
  const titleLineHeight = Math.round(template.titleSize * TITLE_LINE_HEIGHT);
  layout.titleLines.forEach((line, i) => {
    const y = template.safeArea.top + template.titleSize + i * titleLineHeight;
    const content = renderTitleLineContent(
      line,
      i,
      layout.emphasisRanges,
      template.accent,
    );
    parts.push(
      `  <text x="${template.safeArea.left}" y="${y}" font-family="${fontFamily}" font-size="${template.titleSize}" font-weight="600" fill="${foreground}">${content}</text>`,
    );
  });

  // 字幕区（current page's lines inside the bottom safe area）.
  const subtitleLineHeight = Math.round(
    template.bodySize * SUBTITLE_LINE_HEIGHT,
  );
  const subtitleTop =
    CANVAS.height - template.safeArea.bottom + template.bodySize;
  const pageLines = layout.subtitlePages[page]!;
  pageLines.forEach((line, i) => {
    const y = subtitleTop + i * subtitleLineHeight;
    parts.push(
      `  <text x="${template.safeArea.left}" y="${y}" font-family="${fontFamily}" font-size="${template.bodySize}" fill="${foreground}">${escapeXml(line)}</text>`,
    );
  });

  // 页码指示（multi-page only）: centered dot row, active dot in accent.
  const pageCount = layout.subtitlePages.length;
  if (pageCount > 1) {
    const cy = CANVAS.height - PAGE_DOT.marginBottom;
    const startX = CANVAS.width / 2 - ((pageCount - 1) * PAGE_DOT.spacing) / 2;
    for (let p = 0; p < pageCount; p++) {
      const cx = startX + p * PAGE_DOT.spacing;
      const attrs =
        p === page
          ? `fill="${escapeXml(template.accent)}"`
          : `fill="${foreground}" opacity="0.35"`;
      parts.push(
        `  <circle cx="${cx}" cy="${cy}" r="${PAGE_DOT.radius}" ${attrs}/>`,
      );
    }
  }

  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}
