/**
 * Tests for buildCardSvg (Workflow 2: XML escaping BR-U4-7, emphasis
 * tspans, page dots, purity BR-U4-8) and template validation (structure →
 * ValidationError; contrast/font-size findings → warnings, BR-U4-11).
 */
import { describe, expect, test } from "bun:test";

import {
  buildCardSvg,
  contrastRatio,
  loadTemplate,
  validateTemplate,
} from "@core/cards";
import type { CardLayout } from "@core/cards";
import { ValidationError } from "@core/errors";

const { template } = loadTemplate();

function layout(partial: Partial<CardLayout>): CardLayout {
  return {
    titleLines: ["要点"],
    subtitlePages: [[]],
    emphasisRanges: [],
    ...partial,
  };
}

describe("buildCardSvg (Workflow 2)", () => {
  test("XML 转义: 文本节点一律 escape（BR-U4-7 注入防护）", () => {
    const svg = buildCardSvg(
      layout({
        titleLines: ["A<B&C>"],
        subtitlePages: [['"注" \'s']],
      }),
      0,
      template,
    );
    expect(svg).toContain("A&lt;B&amp;C&gt;");
    expect(svg).toContain("&quot;注&quot; &apos;s");
    expect(svg).not.toContain("<B&");
  });

  test("emphasis 高亮 tspan（accent fill，前后普通文本保持裸转义）", () => {
    const svg = buildCardSvg(
      layout({
        titleLines: ["一二三四"],
        emphasisRanges: [{ line: 0, start: 1, len: 2 }],
      }),
      0,
      template,
    );
    expect(svg).toContain(`一<tspan fill="${template.accent}">二三</tspan>四`);
  });

  test("页码指示: 多页出圆点（当前页 accent），单页无圆点", () => {
    const multi = buildCardSvg(
      layout({ subtitlePages: [["甲"], ["乙"]] }),
      0,
      template,
    );
    expect(multi.match(/<circle /g)?.length).toBe(2);
    expect(multi).toContain(`fill="${template.accent}"/>`);
    expect(multi).toContain('opacity="0.35"');

    const single = buildCardSvg(layout({}), 0, template);
    expect(single).not.toContain("<circle");
  });

  test("画布/背景/字号结构锚点（1080×1920, 模板取值）", () => {
    const svg = buildCardSvg(
      layout({ subtitlePages: [["口播字幕"]] }),
      0,
      template,
    );
    expect(svg).toContain('width="1080" height="1920"');
    expect(svg).toContain(`fill="${template.background}"/>`);
    expect(svg).toContain(`font-size="${template.titleSize}"`);
    expect(svg).toContain(`font-size="${template.bodySize}"`);
  });

  test("页码越界 → ValidationError；纯函数同输入逐字符相等", () => {
    expect(() => buildCardSvg(layout({}), 1, template)).toThrow(
      ValidationError,
    );
    const input = layout({
      titleLines: ["要点一"],
      subtitlePages: [["字幕"], ["更多"]],
      emphasisRanges: [{ line: 0, start: 0, len: 2 }],
    });
    expect(buildCardSvg(input, 1, template)).toBe(
      buildCardSvg(input, 1, template),
    );
  });
});

describe("template 校验（载入校验 + BR-U4-11 警告）", () => {
  const validRaw = {
    name: "t",
    background: "#1a1a2e",
    foreground: "#ffffff",
    accent: "#ffd166",
    fontFamily: "PingFang SC",
    titleSize: 64,
    bodySize: 40,
    safeArea: { top: 180, bottom: 320, left: 90, right: 90 },
    maxCharsPerLine: 14,
    maxLines: 4,
  };

  test("默认模板加载干净: 零告警，对比度实测 ≥12:1（宣称复核）", () => {
    const result = loadTemplate();
    expect(result.template.name).toBe("default");
    expect(result.warnings).toEqual([]);
    expect(
      contrastRatio(result.template.foreground, result.template.background),
    ).toBeGreaterThanOrEqual(12);
  });

  test("结构问题 → ValidationError（字段缺失/safeArea 重叠/容量不自洽）", () => {
    const { titleSize: _dropped, ...missingField } = validRaw;
    expect(() => validateTemplate(missingField)).toThrow(ValidationError);
    expect(() =>
      validateTemplate({
        ...validRaw,
        safeArea: { top: 180, bottom: 320, left: 600, right: 600 },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateTemplate({ ...validRaw, maxCharsPerLine: 20 }),
    ).toThrow(ValidationError); // 20×64=1280 > 可用宽 900
    expect(() => validateTemplate("not an object")).toThrow(ValidationError);
  });

  test("对比度不足与字号低于下限 → 警告列表，不抛错（BR-U4-11）", () => {
    const { warnings, template: loaded } = validateTemplate({
      ...validRaw,
      foreground: "#22223a", // 与 #1a1a2e 对比度 < 4.5
      bodySize: 30, // 低于 36px 下限
    });
    expect(loaded.name).toBe("t");
    expect(warnings.length).toBe(2);
    expect(warnings.join("\n")).toContain("对比度");
    expect(warnings.join("\n")).toContain("36px");
  });

  test("contrastRatio: WCAG 公式锚点（白/黑 = 21:1）", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#000000")).toThrow(ValidationError);
  });
});
