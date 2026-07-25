/**
 * @core/whiteboard library 单测：线稿定义合法性（归一化边界）、实例化
 * 缩放、装饰件 SVG。
 */
import { describe, expect, test } from "bun:test";

import {
  LINE_ART,
  LINE_ART_NAMES,
  STICKER_NAMES,
  iconDrawSec,
  iconPaths,
  stickerSvg,
} from "./library";

describe("LINE_ART 定义合法性", () => {
  test("每个元素至少一条折线且点数 ≥2", () => {
    for (const name of LINE_ART_NAMES) {
      const def = LINE_ART[name]!;
      expect(def.strokes.length).toBeGreaterThan(0);
      for (const path of def.strokes) {
        expect(path.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("所有点落在归一化 100×100 框内（含少量出血余量）", () => {
    for (const name of LINE_ART_NAMES) {
      for (const path of LINE_ART[name]!.strokes) {
        for (const [x, y] of path) {
          expect(x).toBeGreaterThanOrEqual(-45);
          expect(x).toBeLessThanOrEqual(145);
          expect(y).toBeGreaterThanOrEqual(-45);
          expect(y).toBeLessThanOrEqual(160);
        }
      }
    }
  });

  test("weight 为正", () => {
    for (const name of LINE_ART_NAMES) {
      expect(LINE_ART[name]!.weight).toBeGreaterThan(0);
    }
  });
});

describe("iconPaths 实例化", () => {
  test("check 图标按中心/尺寸缩放", () => {
    const paths = iconPaths("check", 500, 500, 100);
    expect(paths.length).toBe(1);
    const [first] = paths[0]!;
    // 归一化 (20,55) → 中心 500 尺寸 100：450 + 20 = 470
    expect(first![0]).toBeCloseTo(470, 5);
    expect(first![1]).toBeCloseTo(505, 5);
  });

  test("未知名字返回空数组", () => {
    expect(iconPaths("nope", 0, 0, 100)).toEqual([]);
  });

  test("iconDrawSec 按权重折算，未知名回退 0.7", () => {
    expect(iconDrawSec("check")).toBeCloseTo(0.7 * 0.5, 5);
    expect(iconDrawSec("nope")).toBe(0.7);
  });
});

describe("stickerSvg", () => {
  test("已知装饰件输出非空且带填充色", () => {
    for (const name of STICKER_NAMES) {
      const svg = stickerSvg(name, 100, 100, 200, "#ff0000");
      expect(svg.length).toBeGreaterThan(0);
      expect(svg).toContain("#ff0000");
    }
  });

  test("未知装饰件输出空串", () => {
    expect(stickerSvg("nope", 0, 0, 100, "#000")).toBe("");
  });
});
