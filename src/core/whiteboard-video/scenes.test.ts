/**
 * 设计稿 2.0 §10 场景化组件 + §4 笔触效果 的单测。
 *
 * 场景是**组合件**，所以测的是组合契约：每个场景都产出可画的分组、每组的颜色都
 * 来自八色板、所有笔画都落在给定矩形附近（场景不该画到别的段落头上）。
 */

import { describe, expect, it } from "bun:test";

import { PALETTE } from "./palette";
import {
  SCENE_LABELS,
  SCENE_NAMES,
  discussionScene,
  isSceneName,
  lectureScene,
  partColor,
  presentationScene,
  scene,
  successScene,
  thinkingScene,
} from "./scenes";
import {
  BRUSH_KINDS,
  brushStrokesEl,
  chalkStrokesEl,
  gradientStrokeSvg,
  isBrushKind,
  watercolorSvg,
} from "./strokes";

const box = { x: 100, y: 100, w: 300, h: 200 };

describe("§10 场景化组件", () => {
  it("五个场景齐全，守卫与中文名都对得上", () => {
    expect(SCENE_NAMES).toHaveLength(5);
    for (const n of SCENE_NAMES) {
      expect(isSceneName(n)).toBe(true);
      expect(SCENE_LABELS[n]).toBeTruthy();
    }
    expect(isSceneName("meeting")).toBe(false);
  });

  it("每个场景都产出至少两组可画的笔画", () => {
    for (const n of SCENE_NAMES) {
      const d = scene(n, box);
      expect(d.parts.length).toBeGreaterThanOrEqual(2);
      for (const part of d.parts) {
        expect(part.paths.length).toBeGreaterThan(0);
        for (const p of part.paths) expect(p.length).toBeGreaterThan(1);
      }
    }
  });

  it("每组的颜色都取自八色板（场景不引入自定义色）", () => {
    const values = Object.values(PALETTE);
    for (const n of SCENE_NAMES) {
      for (const part of scene(n, box).parts) {
        expect(values).toContain(partColor(part));
      }
    }
  });

  it("所有笔画坐标有限，且不跑出给定矩形太远", () => {
    for (const n of SCENE_NAMES) {
      const pts = scene(n, box).parts.flatMap((p) => p.paths.flat());
      for (const [x, y] of pts) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
      const xs = pts.map((p) => p[0]!);
      const ys = pts.map((p) => p[1]!);
      // 允许 12% 的外溢（手臂/气泡尾巴会略微出框），但不能翻倍
      expect(Math.min(...xs)).toBeGreaterThan(box.x - box.w * 0.12);
      expect(Math.max(...xs)).toBeLessThan(box.x + box.w * 1.12);
      expect(Math.min(...ys)).toBeGreaterThan(box.y - box.h * 0.12);
      expect(Math.max(...ys)).toBeLessThan(box.y + box.h * 1.12);
    }
  });

  it("场景随矩形缩放（换画幅不会写死尺寸）", () => {
    const small = lectureScene({ x: 0, y: 0, w: 100, h: 80 });
    const big = lectureScene({ x: 0, y: 0, w: 400, h: 320 });
    const span = (d: ReturnType<typeof lectureScene>): number => {
      const xs = d.parts.flatMap((p) => p.paths.flat()).map((q) => q[0]!);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(big)).toBeGreaterThan(span(small) * 3);
  });

  it("小组讨论只给两个人对话框（三个都说话读起来是吵架）", () => {
    const d = discussionScene(box);
    // 第一组是气泡：两个
    expect(d.parts[0]!.paths).toHaveLength(2);
  });

  it("思考状态的气泡在人的右侧（符合从左到右的阅读顺序）", () => {
    const d = thinkingScene(box);
    const bubbleXs = d.parts[0]!.paths.flat().map((p) => p[0]!);
    const personXs = d.parts[2]!.paths.flat().map((p) => p[0]!);
    const bubbleCx = (Math.min(...bubbleXs) + Math.max(...bubbleXs)) / 2;
    const personCx = (Math.min(...personXs) + Math.max(...personXs)) / 2;
    expect(bubbleCx).toBeGreaterThan(personCx);
  });

  it("演示场景的屏幕里是折线（与人物讲解的文字线区分）", () => {
    const pres = presentationScene(box);
    const lect = lectureScene(box);
    // 演示场景里有一组用主强调色画的折线
    expect(pres.parts.some((p) => p.role === "primary")).toBe(true);
    // 人物讲解的板上内容是弱化色的文字线
    expect(lect.parts.some((p) => p.role === "muted")).toBe(true);
  });

  it("完成/成功用暖色（奖杯与放射线），不是主强调蓝", () => {
    const d = successScene(box);
    expect(
      d.parts.filter((p) => p.role === "warn").length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("§4 手绘笔触效果", () => {
  it("六种笔触齐全，守卫可用", () => {
    expect(BRUSH_KINDS).toHaveLength(6);
    for (const k of BRUSH_KINDS) expect(isBrushKind(k)).toBe(true);
    expect(isBrushKind("crayon")).toBe(false);
  });

  it("毛笔笔触画得出图元且不留起笔积墨点", () => {
    const el = brushStrokesEl(
      [
        [
          [0, 0],
          [100, 20],
        ],
      ],
      { t0: 0, dur: 1, color: "#222", width: 16, seed: "b" },
    );
    const svg = el.svg(9999);
    expect(svg).toContain("<path");
    // 积墨点是 <circle>，毛笔不该有
    expect(svg).not.toContain("<circle");
  });

  it("粉笔笔触是断续的（段数明显多于一条实线）", () => {
    const solid = brushStrokesEl(
      [
        [
          [0, 0],
          [300, 0],
        ],
      ],
      { t0: 0, dur: 1, color: "#222", width: 10, seed: "s" },
    ).svg(9999);
    const chalk = chalkStrokesEl(
      [
        [
          [0, 0],
          [300, 0],
        ],
      ],
      { t0: 0, dur: 1, color: "#222", width: 10, seed: "s" },
    ).svg(9999);
    const count = (s: string): number => (s.match(/<path/g) ?? []).length;
    expect(count(chalk)).toBeGreaterThan(count(solid) * 3);
  });

  it("粉笔是半透明的（粉笔灰不会完全盖住底色）", () => {
    const svg = chalkStrokesEl(
      [
        [
          [0, 0],
          [100, 0],
        ],
      ],
      { t0: 0, dur: 1, color: "#222", width: 10, seed: "s" },
    ).svg(9999);
    const m = svg.match(/fill-opacity="([\d.]+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(0.8);
  });

  it("水彩是两层叠加（外层更淡，模拟水痕）", () => {
    const svg = watercolorSvg(0, 0, 100, 50, { color: "#EF4444", seed: "w" });
    const ops = [...svg.matchAll(/fill-opacity="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(ops).toHaveLength(2);
    expect(Math.min(...ops)).toBeLessThan(Math.max(...ops));
  });

  it("水彩同 seed 逐帧稳定（帧渲染必须可重复）", () => {
    const a = watercolorSvg(0, 0, 100, 50, { color: "#EF4444", seed: "w" });
    const b = watercolorSvg(0, 0, 100, 50, { color: "#EF4444", seed: "w" });
    expect(a).toBe(b);
  });

  it("渐变笔触的渐变方向与笔画同向", () => {
    const svg = gradientStrokeSvg("g1", [0, 0], [100, 0], 12, [
      "#7C3AED",
      "#06B6D4",
    ]);
    expect(svg).toContain('id="g1"');
    expect(svg).toContain('x1="0"');
    expect(svg).toContain('x2="100"');
    expect(svg).toContain("url(#g1)");
    expect(svg).toContain("userSpaceOnUse");
  });
});
