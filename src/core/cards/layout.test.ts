/**
 * Tests for the TextMeasure width table (BR-U4-1) and the pure layout core
 * (Workflow 1): mixed CJK/ASCII wrap snapshot, 避头 carry (BR-U4-2),
 * subtitle pagination (BR-U4-4), emphasis positioning (incl. cross-line),
 * and the defensive capacity ValidationError.
 */
import { describe, expect, test } from "bun:test";

import {
  charWidthEm,
  layoutCard,
  loadTemplate,
  measureText,
} from "@core/cards";
import { ValidationError } from "@core/errors";
import type { Segment } from "@core/script";

const { template } = loadTemplate();

function segment(cardText: string, emphasis?: string[]): Segment {
  return { text: "占位口播", cardText, ...(emphasis ? { emphasis } : {}) };
}

describe("measure (TextMeasure 宽度表, Q1=A)", () => {
  test("character classes: CJK 1.0 / ASCII 0.5 / 全角标点 1.0 / 兜底 1.0", () => {
    expect(charWidthEm("中")).toBe(1);
    expect(charWidthEm("A")).toBe(0.5);
    expect(charWidthEm("7")).toBe(0.5);
    expect(charWidthEm(" ")).toBe(0.5);
    expect(charWidthEm(".")).toBe(0.5);
    expect(charWidthEm("，")).toBe(1);
    expect(charWidthEm("。")).toBe(1);
    expect(charWidthEm("😀")).toBe(1); // emoji 兜底（surrogate pair）
  });

  test("measureText: 逐字累加 em × fontSize（code point 迭代）", () => {
    expect(measureText("中A中", 64)).toBe(160); // (1+0.5+1)×64
    expect(measureText("", 64)).toBe(0);
    expect(measureText("😀😀", 40)).toBe(80); // 2 code points, not 4 units
  });
});

describe("layoutCard (Workflow 1)", () => {
  test("mixed CJK/ASCII wrap snapshot (容量 14em/行)", () => {
    const layout = layoutCard(
      segment("用Bun和FFmpeg三步搞定短视频自动化流水线"),
      "",
      template,
    );
    expect(layout.titleLines).toEqual([
      "用Bun和FFmpeg三步搞定短视频",
      "自动化流水线",
    ]);
  });

  test("避头: 行首全角句读回退携带前字 (BR-U4-2)", () => {
    const layout = layoutCard(
      segment("一二三四五六七八九十甲乙丙丁，戊己"),
      "",
      template,
    );
    expect(layout.titleLines).toEqual([
      "一二三四五六七八九十甲乙丙",
      "丁，戊己",
    ]);
  });

  test("字幕分页: 22 全角字/行 × 3 行/页 (BR-U4-4 禁截断)", () => {
    const layout = layoutCard(segment("要点"), "水".repeat(150), template);
    expect(layout.subtitlePages.length).toBe(3);
    expect(layout.subtitlePages[0]).toEqual([
      "水".repeat(22),
      "水".repeat(22),
      "水".repeat(22),
    ]);
    expect(layout.subtitlePages[2]).toEqual(["水".repeat(18)]);
  });

  test("空字幕仍得一页（每段至少一帧不变式）", () => {
    const layout = layoutCard(segment("要点"), "", template);
    expect(layout.subtitlePages).toEqual([[]]);
  });

  test("emphasis 定位: 单行内 {line,start,len}（code point 单位）", () => {
    const layout = layoutCard(
      segment("用Bun和FFmpeg三步搞定短视频自动化流水线", ["FFmpeg"]),
      "",
      template,
    );
    expect(layout.emphasisRanges).toEqual([{ line: 0, start: 5, len: 6 }]);
  });

  test("emphasis 跨行拆分为逐行 range", () => {
    const layout = layoutCard(
      segment("用Bun和FFmpeg三步搞定短视频自动化流水线", ["短视频自动化"]),
      "",
      template,
    );
    expect(layout.emphasisRanges).toEqual([
      { line: 0, start: 15, len: 3 },
      { line: 1, start: 0, len: 3 },
    ]);
  });

  test("emphasis 子串缺失即跳过（不抛错）", () => {
    const layout = layoutCard(segment("要点文案", ["不存在词"]), "", template);
    expect(layout.emphasisRanges).toEqual([]);
  });

  test("超容量（>maxLines）→ ValidationError（防御性，上游 ≤80 字应保证）", () => {
    // 60 字 ≤ 上游 80 上限，但 60/14 = 5 行 > maxLines 4。
    expect(() => layoutCard(segment("字".repeat(60)), "", template)).toThrow(
      ValidationError,
    );
  });

  test("纯函数: 同输入两次调用结果深度相等", () => {
    const seg = segment("用Bun和FFmpeg三步搞定短视频自动化流水线", ["FFmpeg"]);
    const text = "水".repeat(80);
    expect(layoutCard(seg, text, template)).toEqual(
      layoutCard(seg, text, template),
    );
  });
});
