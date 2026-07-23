/**
 * @module @core/cards (template)
 *
 * CardTemplate loading + validation (Workflow: 模板载入校验) and the WCAG
 * contrast checker (Integration Assumptions: the 12:1 claim is re-verified
 * here by an automated check at load time).
 *
 * Boundary rules honored here:
 * - 校验逻辑 (functional-design): 字段齐全、safeArea 不重叠、fontSize 与
 *   容量参数自洽（maxCharsPerLine×1.0em×titleSize ≤ 可用宽度）→ 违反抛
 *   ValidationError.
 * - BR-U4-11: 前景/背景对比度 ≥4.5:1、字幕字号下限 36px → 违反是模板校验
 *   **警告**（warnings 列表），不抛错。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IoError, ValidationError } from "@core/errors";

import { CANVAS } from "./types";
import type { CardTemplate } from "./types";

/** Shipped default template asset (version-controlled, BR-U4 模板定义). */
export const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL("../../../assets/templates/default.json", import.meta.url),
);

/** BR-U4-11: minimum subtitle font size for mobile readability (px). */
export const MIN_BODY_SIZE = 36;

/** BR-U4-11 / WCAG AA: minimum foreground/background contrast ratio. */
export const MIN_CONTRAST_RATIO = 4.5;

/** Validated template plus its non-fatal warnings (BR-U4-11). */
export interface TemplateLoadResult {
  template: CardTemplate;
  /** 对比度/字号类告警（不阻塞加载；BR-U4-11 违反行为=警告）. */
  warnings: string[];
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** sRGB channel → linearized value (WCAG relative-luminance formula). */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb color. */
function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Pure function: WCAG contrast ratio between two #rrggbb colors
 * ((L1+0.05)/(L2+0.05), lighter over darker). Range [1, 21].
 *
 * @throws ValidationError when either color is not #rrggbb hex.
 */
export function contrastRatio(colorA: string, colorB: string): number {
  for (const color of [colorA, colorB]) {
    if (!HEX_COLOR.test(color)) {
      throw new ValidationError(`颜色不是 #rrggbb 十六进制值: "${color}"`);
    }
  }
  const la = relativeLuminance(colorA);
  const lb = relativeLuminance(colorB);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  raw: Record<string, unknown>,
  field: string,
  problems: string[],
): string {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${field}: 缺失或不是非空字符串`);
    return "";
  }
  return value;
}

function requirePositiveNumber(
  raw: Record<string, unknown>,
  field: string,
  problems: string[],
): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(`${field}: 缺失或不是正数`);
    return 0;
  }
  return value;
}

/**
 * Pure function: raw parsed JSON → validated {@link CardTemplate} plus
 * warnings. Structural problems (字段齐全/safeArea 不重叠/容量自洽) throw a
 * single itemized ValidationError; contrast/font-size findings are warnings.
 *
 * @throws ValidationError with the full problem list (never one-at-a-time).
 */
export function validateTemplate(raw: unknown): TemplateLoadResult {
  if (!isRecord(raw)) {
    throw new ValidationError("模板必须是 JSON 对象");
  }

  const problems: string[] = [];
  const name = requireString(raw, "name", problems);
  const background = requireString(raw, "background", problems);
  const foreground = requireString(raw, "foreground", problems);
  const accent = requireString(raw, "accent", problems);
  const fontFamily = requireString(raw, "fontFamily", problems);
  const titleSize = requirePositiveNumber(raw, "titleSize", problems);
  const bodySize = requirePositiveNumber(raw, "bodySize", problems);
  const maxCharsPerLine = requirePositiveNumber(
    raw,
    "maxCharsPerLine",
    problems,
  );
  const maxLines = requirePositiveNumber(raw, "maxLines", problems);

  let safeArea = { top: 0, bottom: 0, left: 0, right: 0 };
  const rawSafeArea = raw["safeArea"];
  if (!isRecord(rawSafeArea)) {
    problems.push("safeArea: 缺失或不是对象");
  } else {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const value = rawSafeArea[side];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        problems.push(`safeArea.${side}: 缺失或不是非负数`);
      }
    }
    if (problems.length === 0) {
      safeArea = rawSafeArea as unknown as CardTemplate["safeArea"];
    }
  }

  // Geometry checks only when the fields themselves parsed.
  if (problems.length === 0) {
    if (safeArea.top + safeArea.bottom >= CANVAS.height) {
      problems.push(
        `safeArea 上下重叠: top ${safeArea.top} + bottom ${safeArea.bottom} ≥ 画布高 ${CANVAS.height}`,
      );
    }
    if (safeArea.left + safeArea.right >= CANVAS.width) {
      problems.push(
        `safeArea 左右重叠: left ${safeArea.left} + right ${safeArea.right} ≥ 画布宽 ${CANVAS.width}`,
      );
    }
    const usableWidth = CANVAS.width - safeArea.left - safeArea.right;
    if (maxCharsPerLine * titleSize > usableWidth) {
      problems.push(
        `容量参数不自洽: maxCharsPerLine ${maxCharsPerLine} × 1.0em × titleSize ${titleSize} = ` +
          `${maxCharsPerLine * titleSize}px > 可用宽度 ${usableWidth}px`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(
      `CardTemplate 校验失败:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  const template: CardTemplate = {
    name,
    background,
    foreground,
    accent,
    fontFamily,
    titleSize,
    bodySize,
    safeArea,
    maxCharsPerLine,
    maxLines,
  };

  // BR-U4-11 findings are WARNINGS — reported, never thrown.
  const warnings: string[] = [];
  if (bodySize < MIN_BODY_SIZE) {
    warnings.push(
      `bodySize ${bodySize}px 低于字幕字号下限 ${MIN_BODY_SIZE}px（BR-U4-11 移动可读性）`,
    );
  }
  if (HEX_COLOR.test(background)) {
    for (const [label, color] of [
      ["foreground", foreground],
      ["accent", accent],
    ] as const) {
      if (!HEX_COLOR.test(color)) {
        warnings.push(`${label} "${color}" 不是 #rrggbb，无法计算对比度`);
        continue;
      }
      const ratio = contrastRatio(color, background);
      if (ratio < MIN_CONTRAST_RATIO) {
        warnings.push(
          `${label}/background 对比度 ${ratio.toFixed(2)}:1 低于 WCAG AA 下限 ${MIN_CONTRAST_RATIO}:1（BR-U4-11）`,
        );
      }
    }
  } else {
    warnings.push(
      `background "${background}" 不是 #rrggbb（资产路径?），跳过对比度检查`,
    );
  }

  return { template, warnings };
}

/**
 * Loads and validates a card template JSON file.
 *
 * @throws IoError when the file cannot be read.
 * @throws ValidationError on bad JSON or structural problems.
 */
export function loadTemplate(
  path: string = DEFAULT_TEMPLATE_PATH,
): TemplateLoadResult {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (cause) {
    throw new IoError(`模板文件读取失败: ${path}`, { cause });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new ValidationError(`模板文件不是合法 JSON: ${path}`, { cause });
  }

  return validateTemplate(raw);
}
