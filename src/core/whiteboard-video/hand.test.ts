/**
 * @module core/whiteboard-video/hand.test
 *
 * 手臂怎么收尾的回归网。
 *
 * 素材里的手臂是**渐尖收笔**的（画到一半就没了），所以两个画幅各有一套
 * 处理：横版顺着手臂接出画面，竖版在手腕切断加袖口。不设这层保护的话，
 * 手臂会在画面正中间断掉 —— 观众说不出哪里怪，但就是觉得假。
 *
 * 用手搭的贴图数据（不读素材文件）：这里测的是几何与装配规则，不是像素
 * 实测算法。
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_ARM_MODE, handCueSvg } from "./hand";
import type { HandImage, HandTwoState } from "./hand";

/** 一张假贴图：手臂截面在 y=680，手腕在 y=320，都往右下倾. */
function image(overrides: Partial<HandImage> = {}): HandImage {
  return {
    uri: "data:image/png;base64,AA==",
    w: 500,
    h: 788,
    tipX: 40,
    tipY: 77,
    arm: { y: 680, x0: 300, x1: 460, slope: 0.5, fill: "#824a2d" },
    wrist: { cx: 240, cy: 320, halfWidth: 48, slope: 0.48 },
    ...overrides,
  };
}

function kit(armMode: HandTwoState["armMode"], img = image()): HandTwoState {
  const two: HandTwoState = { draw: img, move: img };
  if (armMode !== undefined) two.armMode = armMode;
  return two;
}

describe("默认收尾方式", () => {
  test("默认切断加袖口 —— 放大到手臂自然出画需要占画宽 42%，会盖住内容", () => {
    expect(DEFAULT_ARM_MODE).toBe("cuff");
  });
});

describe("handCueSvg 手臂收尾", () => {
  test("extend：画一条顺斜率的臂带，不裁剪贴图", () => {
    const svg = handCueSvg({ rt: kit("extend"), x: 500, y: 400, lift: 0 });
    expect(svg).toContain("<polygon");
    expect(svg).toContain("#824a2d");
    expect(svg).not.toContain("clip-path");
  });

  test("extend：臂带长度足够走出竖版画幅", () => {
    const img = image();
    const svg = handCueSvg({ rt: kit("extend"), x: 0, y: 0, lift: 0 });
    // 取臂带上最大的 y（局部坐标；画布位置由 translate 决定）
    const pts = /points="([^"]+)"/.exec(svg)![1]!;
    const maxY = Math.max(
      ...pts.split(" ").map((p) => Number(p.split(",")[1])),
    );
    // 从笔尖算起至少要有两个画幅短边那么长，才能在任何书写高度都出画
    expect(maxY).toBeGreaterThan(img.h * 2);
  });

  test("cuff：裁掉手腕以下并画袖口", () => {
    const svg = handCueSvg({ rt: kit("cuff"), x: 500, y: 400, lift: 0 });
    expect(svg).toContain("<clipPath");
    expect(svg).toContain("clip-path=");
    expect(svg).toContain("#4a5560");
    // 竖版不该再有接出画面的臂带
    expect(svg).not.toContain("#824a2d");
  });

  test("cuff：袖口在贴图之后画（要盖住切口那条硬边）", () => {
    const svg = handCueSvg({ rt: kit("cuff"), x: 500, y: 400, lift: 0 });
    expect(svg.indexOf("#4a5560")).toBeGreaterThan(svg.indexOf("<image"));
  });

  test("cuff：clipPath 的 id 稳定（同一只手每帧同一个 id）", () => {
    const a = handCueSvg({ rt: kit("cuff"), x: 100, y: 200, lift: 0 });
    const b = handCueSvg({ rt: kit("cuff"), x: 900, y: 700, lift: 0 });
    const idOf = (s: string): string => /id="([^"]+)"/.exec(s)![1]!;
    expect(idOf(a)).toBe(idOf(b));
  });

  test("量不出手腕时退回接出画面（不在错的地方切一刀）", () => {
    const img = image();
    delete img.wrist;
    const svg = handCueSvg({ rt: kit("cuff", img), x: 500, y: 400, lift: 0 });
    expect(svg).not.toContain("clip-path");
    expect(svg).toContain("#824a2d");
  });

  test("两样都量不出时只画贴图（不画凭空多出来的胳膊）", () => {
    const img = image();
    delete img.wrist;
    delete img.arm;
    const svg = handCueSvg({ rt: kit("cuff", img), x: 500, y: 400, lift: 0 });
    expect(svg).not.toContain("<polygon");
    expect(svg).not.toContain("<path");
    expect(svg).toContain("<image");
  });

  test("锚点对齐到 cue 的位置", () => {
    const svg = handCueSvg({ rt: kit("cuff"), x: 640, y: 360, lift: 0 });
    expect(svg).toContain("translate(640,360)");
  });
});
