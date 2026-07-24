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

  test("背景照片: <image> cover-fit + 遮罩 rect 于文字层之前，同输入确定性", () => {
    const dataUri = "data:image/png;base64,aGVsbG8=";
    const input = layout({
      titleLines: ["带图要点"],
      subtitlePages: [["口播字幕"]],
      backgroundImageDataUri: dataUri,
    });
    const svg = buildCardSvg(input, 0, template);

    // 满幅 cover-fit 照片 + 缺省遮罩（黑色 0.55）。
    expect(svg).toContain(
      `<image href="${dataUri}" width="1080" height="1920" preserveAspectRatio="xMidYMid slice"/>`,
    );
    expect(svg).toContain('fill="#000000" fill-opacity="0.55"/>');
    // 层序: 底色 rect → 照片 → 遮罩 → 文字（title 仍在，且在遮罩之后）。
    const overlayAt = svg.indexOf('fill-opacity="0.55"');
    const imageAt = svg.indexOf("<image ");
    const titleAt = svg.indexOf("带图要点");
    expect(imageAt).toBeGreaterThan(
      svg.indexOf(`fill="${template.background}"`),
    );
    expect(overlayAt).toBeGreaterThan(imageAt);
    expect(titleAt).toBeGreaterThan(overlayAt);
    // 纯函数确定性（BR-U4-8）：同输入逐字符相等。
    expect(buildCardSvg(input, 0, template)).toBe(svg);
  });

  test("背景照片: 模板自定义遮罩色/不透明度生效", () => {
    const svg = buildCardSvg(
      layout({ backgroundImageDataUri: "data:image/jpeg;base64,YWJj" }),
      0,
      { ...template, overlayColor: "#101020", overlayOpacity: 0.4 },
    );
    expect(svg).toContain('fill="#101020" fill-opacity="0.4"/>');
  });

  test("无背景照片: 输出不含 <image>/遮罩（回归锚点）", () => {
    const svg = buildCardSvg(
      layout({ subtitlePages: [["字幕"]] }),
      0,
      template,
    );
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("fill-opacity");
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

  test("overlay 字段: 合法值保留；overlayOpacity 超上限 0.85 → ValidationError", () => {
    const { template: withOverlay } = validateTemplate({
      ...validRaw,
      overlayColor: "#111122",
      overlayOpacity: 0.6,
    });
    expect(withOverlay.overlayColor).toBe("#111122");
    expect(withOverlay.overlayOpacity).toBe(0.6);
    // 未设置时字段缺省（buildCardSvg 落回 0.55/#000000 缺省值）。
    const { template: plain } = validateTemplate(validRaw);
    expect(plain.overlayOpacity).toBeUndefined();

    expect(() =>
      validateTemplate({ ...validRaw, overlayOpacity: 0.9 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateTemplate({ ...validRaw, overlayOpacity: -0.1 }),
    ).toThrow(ValidationError);
    expect(() =>
      validateTemplate({ ...validRaw, overlayColor: "black" }),
    ).toThrow(ValidationError);
  });

  test("contrastRatio: WCAG 公式锚点（白/黑 = 21:1）", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#000000")).toThrow(ValidationError);
  });
});
