/**
 * @core/whiteboard geometry 单测：弧长/截取/缓动边界/确定性噪声与抖动。
 */
import { describe, expect, test } from "bun:test";

import {
  arrowHead,
  clamp01,
  cumLengths,
  easeInOutCubic,
  easeInOutQuint,
  easeInOutSine,
  easeOutCubic,
  ellipsePts,
  fmt,
  hashSeed,
  mulberry32,
  overshootPts,
  pointAtLength,
  polylineAttr,
  slicePolyline,
  valueNoise1D,
  wobble,
} from "./geometry";
import type { Pt } from "./geometry";

const square: Pt[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

describe("弧长工具", () => {
  test("cumLengths 累计正确", () => {
    expect(cumLengths(square)).toEqual([0, 100, 200, 300]);
  });

  test("pointAtLength 中点与端点钳制", () => {
    const cum = cumLengths(square);
    expect(pointAtLength(square, cum, 150)).toEqual([100, 50]);
    expect(pointAtLength(square, cum, -5)).toEqual([0, 0]);
    expect(pointAtLength(square, cum, 999)).toEqual([0, 100]);
  });

  test("slicePolyline 截取部分折线且末点在弧长处", () => {
    const cum = cumLengths(square);
    const part = slicePolyline(square, cum, 150);
    expect(part[part.length - 1]).toEqual([100, 50]);
    expect(part.length).toBe(3); // [0,0] [100,0] [100,50]
    expect(slicePolyline(square, cum, 300)).toEqual(square);
  });
});

describe("缓动函数", () => {
  const eases = [easeInOutCubic, easeOutCubic, easeInOutSine, easeInOutQuint];
  test("端点 0/1 且单调", () => {
    for (const ease of eases) {
      expect(ease(0)).toBeCloseTo(0, 6);
      expect(ease(1)).toBeCloseTo(1, 6);
      let prev = 0;
      for (let i = 1; i <= 20; i++) {
        const v = ease(i / 20);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  test("clamp01 边界", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe("确定性随机", () => {
  test("mulberry32 同 seed 同序列", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });

  test("hashSeed 稳定且区分输入", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });

  test("valueNoise1D 值域 [-1,1] 且与查询顺序无关", () => {
    const n1 = valueNoise1D(7);
    const forward = [0.3, 1.7, 5.2].map(n1);
    const n2 = valueNoise1D(7);
    const backward = [5.2, 1.7, 0.3].map(n2).reverse();
    expect(forward).toEqual(backward);
    for (const v of forward) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});

describe("wobble 手绘抖动", () => {
  const linePts: Pt[] = [
    [0, 0],
    [400, 0],
  ];

  test("同 seed 逐次调用输出一致（逐帧稳定）", () => {
    const a = wobble(linePts, 123);
    const b = wobble(linePts, 123);
    expect(a).toEqual(b);
  });

  test("端点锚定（起笔收笔归位）", () => {
    const w = wobble(linePts, 9);
    expect(w[0]).toEqual([0, 0]);
    const last = w[w.length - 1]!;
    expect(last[0]).toBeCloseTo(400, 5);
    expect(last[1]).toBeCloseTo(0, 5);
  });

  test("位移不超过 amp 且确有位移", () => {
    const amp = 3;
    const w = wobble(linePts, 5, { amp });
    let maxDev = 0;
    for (const [, y] of w) maxDev = Math.max(maxDev, Math.abs(y));
    expect(maxDev).toBeLessThanOrEqual(amp + 1e-6);
    expect(maxDev).toBeGreaterThan(0.1);
  });

  test("短线/零幅度直接返回原折线", () => {
    const tiny: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(wobble(tiny, 1)).toEqual(tiny);
    expect(wobble(linePts, 1, { amp: 0 })).toEqual(linePts);
  });
});

describe("形状与属性", () => {
  test("ellipsePts 闭合弧首尾角度正确", () => {
    const pts = ellipsePts(0, 0, 10, 10, 0, 360, 4);
    expect(pts.length).toBe(5);
    expect(pts[0]![0]).toBeCloseTo(10, 5);
    expect(pts[4]![0]).toBeCloseTo(10, 5);
  });

  test("polylineAttr 与 fmt 格式化", () => {
    expect(fmt(1.257)).toBe("1.26");
    expect(fmt(2)).toBe("2");
    expect(fmt(3.1)).toBe("3.1");
    expect(polylineAttr([[1.234, 5.678]])).toBe("1.23,5.68");
  });

  test("arrowHead 尖端为折线末点", () => {
    const head = arrowHead(
      [
        [0, 0],
        [100, 0],
      ],
      20,
    );
    expect(head[1]).toEqual([100, 0]);
    expect(head.length).toBe(3);
  });
});

describe("overshootPts 端点过冲", () => {
  test("沿切向延长且原端点仍在路径上", () => {
    const pts: Pt[] = [
      [0, 0],
      [100, 0],
    ];
    const out = overshootPts(pts, 5, 10);
    expect(out.length).toBe(4);
    expect(out[0]).toEqual([-5, 0]); // 起笔提前落点
    expect(out[1]).toEqual([0, 0]); // 原起点保留
    expect(out[2]).toEqual([100, 0]); // 原终点保留
    expect(out[3]).toEqual([110, 0]); // 收笔越过
  });

  test("零过冲/单点折线原样返回", () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(overshootPts(pts, 0, 0)).toEqual(pts);
    expect(overshootPts([[1, 1]], 5, 5)).toEqual([[1, 1]]);
  });
});
