/**
 * 分支流程图（`flowGraph`）与"内容安全底"（`contentBottom`）的不变量。
 *
 * 这两处都是**看渲图才发现**的问题的沉淀，所以测的是当时那个具体故障：
 * - 分支流程图：拓扑序、生长方向跟着框形状走、分支/汇合真的分层；
 * - 内容安全底：必须在字幕带之上，且要扣掉镜头把格子居中造成的位移。
 */

import { describe, expect, it } from "bun:test";

import { flowGraph } from "./diagrams";
import { CELL_H_RATIO, LANDSCAPE, PORTRAIT, contentBottom } from "./layout";

const BOX_WIDE = { x: 0, y: 0, w: 1700, h: 500 };
const BOX_TALL = { x: 0, y: 0, w: 900, h: 1400 };

const CHAIN = {
  nodes: [
    { id: "a", text: "估算成本", kind: "step" as const },
    { id: "b", text: "预算够吗", kind: "decision" as const },
    { id: "c", text: "定方案", kind: "step" as const },
    { id: "d", text: "砍范围", kind: "step" as const },
    { id: "e", text: "上线", kind: "terminal" as const },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c", label: "够" },
    { from: "b", to: "d", label: "不够" },
    { from: "c", to: "e" },
    { from: "d", to: "e" },
  ],
};

function finite(pts: ReadonlyArray<readonly [number, number]>): boolean {
  return pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

describe("flowGraph", () => {
  it("空节点集返回空图，不抛错", () => {
    const g = flowGraph({ ...BOX_WIDE, nodes: [], edges: [], size: 50 });
    expect(g.nodeShapes).toHaveLength(0);
    expect(g.height).toBe(0);
  });

  it("绘制顺序是拓扑序：判断先于两条分支，汇合点最后", () => {
    const g = flowGraph({ ...BOX_WIDE, ...CHAIN, size: 50 });
    const pos = new Map(g.order.map((nodeIdx, at) => [nodeIdx, at]));
    expect(pos.get(0)!).toBeLessThan(pos.get(1)!); // 估算成本 → 判断
    expect(pos.get(1)!).toBeLessThan(pos.get(2)!); // 判断 → 定方案
    expect(pos.get(1)!).toBeLessThan(pos.get(3)!); // 判断 → 砍范围
    expect(pos.get(4)!).toBe(g.order.length - 1); // 上线（汇合）最后
  });

  it("两条分支排在同一层的不同位置（汇合前真的并排）", () => {
    const g = flowGraph({ ...BOX_WIDE, ...CHAIN, size: 50 });
    const c = g.nodeSlots[2]!;
    const d = g.nodeSlots[3]!;
    // 横向生长时并排 = y 不同、x 相近；这条断言只要求"不重叠"
    expect(Math.abs(c.y - d.y) + Math.abs(c.x - d.x)).toBeGreaterThan(1);
  });

  it("横条框朝右长，竖框朝下长（生长方向跟着框形状）", () => {
    const wide = flowGraph({ ...BOX_WIDE, ...CHAIN, size: 50 });
    const tall = flowGraph({ ...BOX_TALL, ...CHAIN, size: 50 });
    const spanX = (g: typeof wide): number =>
      Math.max(...g.nodeSlots.map((s) => s.x)) -
      Math.min(...g.nodeSlots.map((s) => s.x));
    const spanY = (g: typeof wide): number =>
      Math.max(...g.nodeSlots.map((s) => s.y)) -
      Math.min(...g.nodeSlots.map((s) => s.y));
    expect(spanX(wide)).toBeGreaterThan(spanY(wide));
    expect(spanY(tall)).toBeGreaterThan(spanX(tall));
  });

  it("带标签的边有标签位，不带标签的没有", () => {
    const g = flowGraph({ ...BOX_WIDE, ...CHAIN, size: 50 });
    expect(g.edgeLabels[0]).toBeNull(); // a→b 无标签
    expect(g.edgeLabels[1]).not.toBeNull(); // 「够」
    expect(g.edgeLabels[2]).not.toBeNull(); // 「不够」
  });

  it("画进给定的框里，坐标全部有限", () => {
    const g = flowGraph({
      x: 100,
      y: 200,
      w: 1200,
      h: 500,
      ...CHAIN,
      size: 50,
    });
    for (const shape of g.nodeShapes) expect(finite(shape)).toBe(true);
    for (const paths of g.edgePaths)
      for (const p of paths) expect(finite(p)).toBe(true);
    expect(g.height).toBeLessThanOrEqual(500 + 1);
  });

  it("回头边（形成环）不死循环，仍然给出全部节点的顺序", () => {
    const g = flowGraph({
      ...BOX_WIDE,
      nodes: [
        { id: "a", text: "发现", kind: "terminal" as const },
        { id: "b", text: "执行", kind: "step" as const },
        { id: "c", text: "验证", kind: "step" as const },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a", label: "没过" },
      ],
      size: 50,
    });
    expect(new Set(g.order).size).toBe(3);
    expect(g.edgeLabels[2]).not.toBeNull();
  });
});

describe("contentBottom", () => {
  for (const L of [LANDSCAPE, PORTRAIT]) {
    const scale = Math.min(L.width, L.height) / 1080;
    const bandTop = L.height * 0.88 - 46 * scale * 2.34;
    const camShift = (L.height * (1 - CELL_H_RATIO)) / 2;

    it(`${L.orientation}：安全底换算到画幅坐标后在字幕带之上`, () => {
      expect(contentBottom(L) + camShift).toBeLessThanOrEqual(bandTop + 1);
    });

    it(`${L.orientation}：安全底在格子之内`, () => {
      expect(contentBottom(L)).toBeLessThan(L.height * CELL_H_RATIO);
      expect(contentBottom(L)).toBeGreaterThan(L.marginTop);
    });
  }
});
