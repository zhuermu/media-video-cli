/**
 * 深色板面的测试。
 *
 * 深板最危险的失效方式是**静默的**：底色换了而墨色没换，成片里所有字都在，
 * 只是看不见——渲染成功、日志干净、测试全绿。所以这里钉住"底色与墨色成对"
 * 这件事，以及优先级链（CLI > 文章 > 默认）里墨色跟着**生效的**板面走。
 */

import { describe, expect, test } from "bun:test";

import {
  BOARD_BACKGROUNDS,
  backgroundDefs,
  backgroundSurface,
  boardStyleFor,
  isBoardBackground,
  isDarkBackground,
} from "./board";
import { themedInk } from "./config";
import { DARK_PALETTE, PALETTE, rolesFor } from "./palette";

describe("深色板面", () => {
  test("两个深色值都在枚举里且能过守卫", () => {
    for (const bg of ["dark", "dark-grid"] as const) {
      expect(BOARD_BACKGROUNDS).toContain(bg);
      expect(isBoardBackground(bg)).toBe(true);
      expect(isDarkBackground(bg)).toBe(true);
    }
  });

  test("纸面背景不是深板", () => {
    for (const bg of [
      "plain",
      "grid",
      "lined",
      "cream",
      "texture",
      "dots",
    ] as const) {
      expect(isDarkBackground(bg)).toBe(false);
    }
  });

  test("深板底色是深的，纸面底色是浅的", () => {
    const dark = backgroundSurface("dark");
    const light = backgroundSurface("grid");
    // 亮度判断：取 R 通道足够（两套都是中性色）
    expect(parseInt(dark.surface.slice(1, 3), 16)).toBeLessThan(0x40);
    expect(parseInt(light.surface.slice(1, 3), 16)).toBeGreaterThan(0xc0);
  });

  test("深板关掉反光（深板不该有日光灯高光）", () => {
    expect(boardStyleFor("dark-grid").glare).toBe(0);
    expect(boardStyleFor("grid").glare).toBe(0);
    // 深板的框比纸面的框暗
    const d = boardStyleFor("dark-grid").frame;
    const l = boardStyleFor("grid").frame;
    expect(parseInt(d.slice(1, 3), 16)).toBeLessThan(
      parseInt(l.slice(1, 3), 16),
    );
  });

  test("dark 无纹理、dark-grid 有格线", () => {
    expect(backgroundDefs("dark")).toBe("");
    expect(backgroundDefs("dark-grid")).toContain("<pattern");
  });
});

describe("墨色与底色成对", () => {
  test("深板拿浅墨，纸面拿深墨", () => {
    expect(themedInk("dark-grid").ink).toBe(DARK_PALETTE.ink);
    expect(themedInk("grid").ink).toBe(PALETTE.ink);
  });

  test("深板的墨色明显比底色亮（否则字看不见）", () => {
    const ink = parseInt(themedInk("dark").ink.slice(1, 3), 16);
    const surface = parseInt(backgroundSurface("dark").surface.slice(1, 3), 16);
    expect(ink - surface).toBeGreaterThan(0x80);
  });

  test("语义色整套切换，不是只换 ink", () => {
    const dark = rolesFor(true);
    const light = rolesFor(false);
    for (const role of [
      "ink",
      "muted",
      "primary",
      "success",
      "danger",
    ] as const) {
      expect(dark[role]).not.toBe(light[role]);
    }
  });

  test("深板的 muted 比亮板的 muted 亮（小字注解在深底上最先糊）", () => {
    const d = parseInt(DARK_PALETTE.muted.slice(1, 3), 16);
    const l = parseInt(PALETTE.muted.slice(1, 3), 16);
    expect(d).toBeGreaterThan(l);
  });
});
