/**
 * @core/whiteboard scene/camera/frames 单测：规划校验、时间轴不变式、
 * 运镜表、帧序列音画对齐（Σ displaySec === totalSec）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ValidationError } from "@core/errors";

import { cameraAt } from "./camera";
import { frameSvg, renderWhiteboardFrames } from "./frames";
import { overviewPose, planWhiteboard } from "./scene";
import type { WhiteboardScene } from "./types";
import { CELL, THEMES } from "./types";

const scenes: WhiteboardScene[] = [
  {
    elements: [
      { type: "title", text: "手绘白板" },
      { type: "text", text: "真笔顺书写" },
    ],
  },
  {
    elements: [
      { type: "chart", chart: "bars-up", label: "增长" },
      { type: "sticker", name: "blob" },
    ],
  },
  {
    elements: [
      { type: "icon", name: "lightbulb", accent: true, label: "灵感" },
      { type: "bullet", text: "要点一" },
    ],
  },
];
const durations = [6, 7, 8];

describe("planWhiteboard 校验", () => {
  test("空场景/长度不匹配/非法时长被拒", () => {
    expect(() => planWhiteboard([], [])).toThrow(ValidationError);
    expect(() => planWhiteboard(scenes, [5, 5])).toThrow(ValidationError);
    expect(() => planWhiteboard(scenes, [5, 5, -1])).toThrow(ValidationError);
  });

  test("未知 icon/sticker 名被拒且报可用清单", () => {
    const bad: WhiteboardScene[] = [
      { elements: [{ type: "icon", name: "nope" }] },
    ];
    expect(() => planWhiteboard(bad, [5])).toThrow(/未知线稿元素/);
    const badSticker: WhiteboardScene[] = [
      { elements: [{ type: "sticker", name: "nope" }] },
    ];
    expect(() => planWhiteboard(badSticker, [5])).toThrow(/未知装饰件/);
  });

  test("image 缺预读 data URI 被拒", () => {
    const withImage: WhiteboardScene[] = [
      { elements: [{ type: "image", src: "photo.jpg" }] },
    ];
    expect(() => planWhiteboard(withImage, [5])).toThrow(/data URI/);
  });

  test("元素数超上限被拒", () => {
    const crowded: WhiteboardScene[] = [
      {
        elements: Array.from({ length: 7 }, () => ({
          type: "text" as const,
          text: "行",
        })),
      },
    ];
    expect(() => planWhiteboard(crowded, [5])).toThrow(/超上限/);
  });
});

describe("planWhiteboard 不变式", () => {
  const plan = planWhiteboard(scenes, durations);

  test("totalSec = Σ实测段时长", () => {
    expect(plan.totalSec).toBeCloseTo(21, 6);
  });

  test("画布为 2 列网格", () => {
    expect(plan.canvasW).toBe(CELL.width * 2);
    expect(plan.canvasH).toBe(CELL.height * 2);
  });

  test("元素时间窗合法且笔活跃区间升序", () => {
    for (const el of plan.els) {
      expect(el.t1).toBeGreaterThan(el.t0);
    }
    for (let i = 1; i < plan.penActive.length; i++) {
      expect(plan.penActive[i]!.t0).toBeGreaterThanOrEqual(
        plan.penActive[i - 1]!.t0,
      );
    }
    expect(plan.penActive.length).toBeGreaterThan(0);
  });

  test("运镜表升序不重叠，含段间平移与收尾 zoom-out", () => {
    expect(plan.camMoves.length).toBe(3); // 2 次段间 + 1 次 overview
    for (let i = 1; i < plan.camMoves.length; i++) {
      expect(plan.camMoves[i]!.t0).toBeGreaterThanOrEqual(
        plan.camMoves[i - 1]!.t1,
      );
    }
    const last = plan.camMoves[plan.camMoves.length - 1]!;
    expect(last.to[2]).toBeGreaterThan(CELL.width); // 视野拉宽 = zoom-out
    expect(last.t1).toBeLessThanOrEqual(plan.totalSec + 1e-6);
  });

  test("笔退场时刻在最后描画之后、总时长附近", () => {
    expect(plan.penExitAt).toBeGreaterThan(0);
    expect(plan.penExitAt).toBeLessThan(plan.totalSec);
  });

  test("主题注入生效", () => {
    const ocean = planWhiteboard(scenes, durations, {
      theme: THEMES["ocean"]!,
    });
    expect(ocean.theme.accent).toBe("#2563eb");
  });

  test("单场景不生成 overview 运镜", () => {
    const single = planWhiteboard([scenes[0]!], [6]);
    expect(single.camMoves.length).toBe(0);
  });
});

describe("cameraAt / overviewPose", () => {
  const plan = planWhiteboard(scenes, durations);

  test("移动前取 from、移动后取 to、途中插值", () => {
    const m = plan.camMoves[0]!;
    expect(cameraAt(m.t0 - 10, plan.camMoves)[0]).toBeCloseTo(m.from[0], 0);
    const midPose = cameraAt((m.t0 + m.t1) / 2, plan.camMoves);
    expect(midPose[0]).toBeGreaterThan(Math.min(m.from[0], m.to[0]));
    expect(midPose[0]).toBeLessThan(Math.max(m.from[0], m.to[0]));
  });

  test("空运镜表返回默认位", () => {
    expect(cameraAt(3, [])).toEqual([540, 960, 1080]);
  });

  test("overviewPose 视野覆盖画布且按 9:16 适配", () => {
    const [cx, cy, w] = overviewPose(2160, 3840);
    expect(cx).toBe(1080);
    expect(cy).toBe(1920);
    expect(w).toBeGreaterThanOrEqual(2160);
  });
});

describe("frameSvg", () => {
  const plan = planWhiteboard(scenes, durations);

  test("同 t 输出确定且为合法 SVG 骨架", () => {
    const svg = frameSvg(plan, 2.5);
    expect(svg).toBe(frameSvg(plan, 2.5));
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain(plan.theme.paper);
  });

  test("书写期含笔贴图，退场后不含", () => {
    const active = frameSvg(plan, plan.penActive[0]!.t0 + 0.1);
    expect(active).toContain("wbPenBody");
    // penExitAt 之后
    const after = frameSvg(plan, plan.penExitAt + 0.1);
    expect(after).not.toContain(
      "rotate(".concat(String(plan.theme.penTiltDeg)),
    );
  });
});

describe("renderWhiteboardFrames 音画对齐", () => {
  test("帧数 = round(total×fps)，Σ displaySec 精确等于 totalSec，幂等跳过", async () => {
    const plan = planWhiteboard([scenes[0]!], [2.37]);
    const dir = mkdtempSync(join(tmpdir(), "wb-frames-"));
    try {
      let calls = 0;
      const fake = async (_svg: string, outPath: string) => {
        calls++;
        await Bun.write(outPath, "png");
        return { path: outPath, width: 1080, height: 1920 };
      };
      const fps = 30;
      const frames = await renderWhiteboardFrames(plan, dir, {
        fps,
        rasterizeFn: fake,
      });
      expect(frames.length).toBe(Math.round(2.37 * fps));
      const sum = frames.reduce((a, f) => a + f.displaySec, 0);
      expect(sum).toBeCloseTo(2.37, 9);
      expect(calls).toBe(frames.length);

      // 幂等：第二次全部跳过
      calls = 0;
      await renderWhiteboardFrames(plan, dir, { fps, rasterizeFn: fake });
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fps 越界被拒", async () => {
    const plan = planWhiteboard([scenes[0]!], [2]);
    expect(
      renderWhiteboardFrames(plan, tmpdir(), { fps: 200 }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("image/chart 变体与笔姿态", () => {
  const px =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const withImage: WhiteboardScene[] = [
    {
      elements: [
        { type: "image", src: "photo.jpg", circle: true, label: "成片" },
      ],
    },
    { elements: [{ type: "chart", chart: "line-up" }] },
    { elements: [{ type: "chart", chart: "steps" }] },
  ];

  test("image 预读注入后可规划，帧内出现 image 节点", () => {
    const plan = planWhiteboard(withImage, [6, 5, 5], {
      imageDataUris: new Map([["photo.jpg", px]]),
    });
    // 图片滑入中段
    const svg = frameSvg(plan, 1.2);
    expect(svg).toContain("<image");
    expect(plan.els.length).toBeGreaterThan(3);
  });

  test("line-up/steps 图表期笔尖有位置（penPoseAt 书写态）", async () => {
    const { penPoseAt, PEN_ENTER_SEC, LONG_GAP_SEC } = await import("./pen");
    const plan = planWhiteboard(withImage, [6, 5, 5], {
      imageDataUris: new Map([["photo.jpg", px]]),
    });
    const penEls = plan.els.filter((e) => e.pen !== undefined);
    expect(penEls.length).toBeGreaterThan(0);
    const first = penEls[0]!;
    // 书写中：lift = 0
    const mid = penPoseAt((first.t0 + first.t1) / 2, penEls, 33);
    expect(mid).not.toBeNull();
    expect(mid!.lift).toBe(0);
    // 开画前很早：手不在画面（不再"驻留"悬在第一笔上等着 —— 那会让观众
    // 盯着一只僵住的手看好几秒）
    expect(penPoseAt(first.t0 - 1, penEls, 33)).toBeNull();
    // 入场窗内：从画外滑进来，lift > 0
    const entering = penPoseAt(first.t0 - PEN_ENTER_SEC * 0.5, penEls, 33);
    expect(entering).not.toBeNull();
    expect(entering!.lift).toBeGreaterThan(0);
    // 元素间隙：提笔 lift > 0
    if (penEls.length > 1) {
      const a = penEls[0]!;
      let b: (typeof penEls)[number] | undefined;
      for (const cand of penEls) {
        if (cand.t0 > a.t1 + 0.02) {
          b = cand;
          break;
        }
      }
      if (b !== undefined) {
        const gapPose = penPoseAt((a.t1 + b.t0) / 2, penEls, 33);
        // 短空档手留在板面上方挪过去；长空档会出画（null），两者都合法
        if (gapPose !== null) expect(gapPose.lift).toBeGreaterThan(0);
        else expect(b.t0 - a.t1).toBeGreaterThan(LONG_GAP_SEC);
      }
    }
    // 全部画完 + 退场窗之后：null
    const last = penEls[penEls.length - 1]!;
    expect(penPoseAt(last.t1 + 10, penEls, 33)).toBeNull();
    // 空表：null
    expect(penPoseAt(1, [], 33)).toBeNull();
  });
});

describe("gridDefs 主题分支与真实栅格化", () => {
  test("ruled 主题出网格线，none 主题无网格引用", () => {
    const ruled = planWhiteboard([scenes[0]!], [6], {
      theme: THEMES["forest"]!,
    });
    expect(frameSvg(ruled, 1)).toContain("<line");
    const none = planWhiteboard([scenes[0]!], [6], {
      theme: { ...THEMES["clean"]!, grid: "none" },
    });
    const svg = frameSvg(none, 1);
    expect(svg).not.toContain("wbGrid");
  });

  test("rasterizeVectorFrame：真实 resvg 出 PNG（原子写），坏 SVG → RenderError", async () => {
    const { rasterizeVectorFrame } = await import("./frames");
    const { RenderError } = await import("@core/errors");
    const dir = mkdtempSync(join(tmpdir(), "wb-raster-"));
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ffffff"/></svg>`;
      const out = join(dir, "t.png");
      const png = await rasterizeVectorFrame(svg, out);
      expect(png.width).toBe(8);
      expect(png.height).toBe(8);
      expect(png.path).toBe(out);
      expect(
        rasterizeVectorFrame("<not-valid-svg", join(dir, "bad.png")),
      ).rejects.toThrow(RenderError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("单笔不变式（防笔在写 A 时 B 已开画）", () => {
  test("同场景笔描元素时间窗严格顺序、互不重叠", () => {
    const plan = planWhiteboard(
      [
        {
          elements: [
            { type: "title", text: "AI 减负测试" },
            { type: "bullet", text: "自动映射与体检" },
            { type: "bullet", text: "异常清单与初稿" },
          ],
        },
        {
          elements: [
            { type: "icon", name: "lightbulb", label: "AI 减负" },
            { type: "bullet", text: "第二场景要点行" },
          ],
        },
      ],
      [16, 16],
    );
    const penEls = plan.els
      .filter((e) => e.pen !== undefined)
      .sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < penEls.length; i++) {
      // 后一个笔描元素必须在前一个真实结束后才开始
      expect(penEls[i]!.t0).toBeGreaterThanOrEqual(penEls[i - 1]!.t1 - 1e-9);
    }
  });
});
