/**
 * @core/whiteboard glyphs 单测：字形墨区几何（笔尖对位的地基）。
 *
 * 这三个函数存在的唯一理由是"笔尖必须压在自己正在写的那一笔上"——
 * 可见字形来自手写字体，而笔尖轨迹来自楷体笔顺数据，两者形状不同。
 */
import { describe, expect, test } from "bun:test";

import type { Pt } from "./geometry";
import {
  handwritingGlyphContours,
  handwritingGlyphVector,
  insideContours,
  setHandwritingFontPath,
  snapToInk,
} from "./glyphs";

/** 手写字体是可选素材；没下的话这组用例整体跳过（CI 无字体也要绿）. */
const HAS_FONT = handwritingGlyphVector("白", 100) !== null;

describe("handwritingGlyphContours", () => {
  test.skipIf(!HAS_FONT)("汉字轮廓非空且落在字框附近", () => {
    const polys = handwritingGlyphContours("白", 100);
    expect(polys).not.toBeNull();
    expect(polys!.length).toBeGreaterThan(0);
    for (const poly of polys!) {
      expect(poly.length).toBeGreaterThan(2);
      for (const [x, y] of poly) {
        // 字形以字框左上角为原点；允许少量出框（笔画可以略微超出字框）
        expect(x).toBeGreaterThan(-30);
        expect(x).toBeLessThan(130);
        expect(y).toBeGreaterThan(-30);
        expect(y).toBeLessThan(130);
      }
    }
  });

  test("缺字体时返回 null（调用方回退楷体渲染）", () => {
    setHandwritingFontPath(null);
    try {
      expect(handwritingGlyphContours("白", 100)).toBeNull();
    } finally {
      setHandwritingFontPath(undefined);
    }
  });

  test.skipIf(!HAS_FONT)("同一 (字, 字号) 结果确定（缓存不改变语义）", () => {
    const a = handwritingGlyphContours("动", 88);
    const b = handwritingGlyphContours("动", 88);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("insideContours", () => {
  /** 单位正方形环（顺时针，SVG y 向下）. */
  const square: Pt[][] = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ];

  test("内部命中、外部落空", () => {
    expect(insideContours(square, [5, 5])).toBe(true);
    expect(insideContours(square, [-1, 5])).toBe(false);
    expect(insideContours(square, [11, 5])).toBe(false);
    expect(insideContours(square, [5, 20])).toBe(false);
  });

  test("反向内环挖空（非零环绕数：字腔不算墨）", () => {
    const donut: Pt[][] = [
      ...square,
      // 内环绕向相反 → 环绕数抵消
      [
        [3, 3],
        [3, 7],
        [7, 7],
        [7, 3],
      ],
    ];
    expect(insideContours(donut, [5, 5])).toBe(false);
    expect(insideContours(donut, [1.5, 5])).toBe(true);
  });
});

describe("snapToInk", () => {
  const square: Pt[][] = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ];

  test("已在墨内的点原样返回", () => {
    expect(snapToInk(square, [5, 5], 8)).toEqual([5, 5]);
  });

  test("墨外的点被拉到最近的墨边并略微推入", () => {
    const [x, y] = snapToInk(square, [15, 5], 8);
    // 最近边是 x=10 这条竖边；结果应在边上或稍微进到墨里
    expect(y).toBeCloseTo(5, 5);
    expect(x).toBeLessThanOrEqual(10);
    expect(x).toBeGreaterThan(9);
  });

  test("超出吸附半径不动（避免拉到一笔无关的墨上）", () => {
    expect(snapToInk(square, [200, 5], 8)).toEqual([200, 5]);
  });

  test("空轮廓组不动", () => {
    expect(snapToInk([], [3, 4], 8)).toEqual([3, 4]);
  });

  test.skipIf(!HAS_FONT)("真实字形：中线附近的点被吸到墨里", () => {
    const size = 120;
    const polys = handwritingGlyphContours("十", size)!;
    // "十" 的横画在字框中部；从中心稍微偏上取一个点，吸附后必须在墨内
    const p = snapToInk(polys, [size * 0.5, size * 0.4], size * 0.14);
    expect(insideContours(polys, p)).toBe(true);
  });
});
