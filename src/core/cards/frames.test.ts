/**
 * Tests for renderCards (Workflow 3): frame duration allocation with the
 * remainder-to-last-page rule (BR-U4-5), idempotent skip (BR-U4-10),
 * frames.json persistence (ADR-004), input validation — plus the single
 * REAL resvg rasterization smoke test (PNG magic + size).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocatePageDurations,
  loadTemplate,
  rasterize,
  renderCards,
} from "@core/cards";
import type { CardLayout, PngFile } from "@core/cards";
import { RenderError, ValidationError } from "@core/errors";
import type { Script } from "@core/script";
import type { VideoDir } from "@core/workdir";

const { template } = loadTemplate();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "u4-frames-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeDir(base: string): VideoDir {
  return {
    slug: "t",
    root: base,
    paths: {
      input: join(base, "input"),
      script: join(base, "script"),
      audio: join(base, "audio"),
      cards: join(base, "cards"),
      video: join(base, "video"),
      pkg: join(base, "package"),
    },
    state: { slug: "t", createdAt: "2026-01-01T00:00:00Z", steps: {} },
  };
}

/** 2 段脚本: 段 0 单页、段 1 三页（150 字 → 66/66/18 字的页）. */
const script: Script = {
  title: "测试",
  topic: "测试",
  segments: [
    { text: "本期讲三个要点", cardText: "要点一" },
    { text: "水".repeat(150), cardText: "要点二" },
  ],
  source: { kind: "topic", ref: "测试" },
};

function fakeRasterizer(): {
  calls: string[];
  fn: (svg: string, outPath: string) => Promise<PngFile>;
} {
  const calls: string[] = [];
  return {
    calls,
    fn: async (svg, outPath) => {
      calls.push(outPath);
      await Bun.write(outPath, `stub:${svg.length}`);
      return { path: outPath, width: 1080, height: 1920 };
    },
  };
}

describe("renderCards (Workflow 3)", () => {
  test("帧时长分配: 页字数占比 0.01 取整、余数并入末页、Σ=段实测", async () => {
    const dir = fakeDir(root);
    const raster = fakeRasterizer();
    const frames = await renderCards(script, [4, 9], template, dir, {
      rasterizeFn: raster.fn,
    });
    expect(frames).toEqual([
      { path: join(dir.paths.cards, "card-00-0.png"), displaySec: 4 },
      { path: join(dir.paths.cards, "card-01-0.png"), displaySec: 3.96 },
      { path: join(dir.paths.cards, "card-01-1.png"), displaySec: 3.96 },
      { path: join(dir.paths.cards, "card-01-2.png"), displaySec: 1.08 },
    ]);
    expect(raster.calls.length).toBe(4);
    // frames.json 与返回值同内容落盘（ADR-004 审核可视）。
    const persisted = JSON.parse(
      readFileSync(join(dir.paths.cards, "frames.json"), "utf8"),
    );
    expect(persisted).toEqual(frames);
  });

  test("幂等: 全部产物已存在 → 零次栅格化，帧表一致重建", async () => {
    const dir = fakeDir(root);
    const first = fakeRasterizer();
    const framesA = await renderCards(script, [4, 9], template, dir, {
      rasterizeFn: first.fn,
    });
    const second = fakeRasterizer();
    const framesB = await renderCards(script, [4, 9], template, dir, {
      rasterizeFn: second.fn,
    });
    expect(second.calls).toEqual([]);
    expect(framesB).toEqual(framesA);
  });

  test("部分缺失: 只补渲染缺的那一帧（card-<seg>-<page>.png 稳定命名）", async () => {
    const dir = fakeDir(root);
    await renderCards(script, [4, 9], template, dir, {
      rasterizeFn: fakeRasterizer().fn,
    });
    const missing = join(dir.paths.cards, "card-01-1.png");
    unlinkSync(missing);
    const rerun = fakeRasterizer();
    await renderCards(script, [4, 9], template, dir, {
      rasterizeFn: rerun.fn,
    });
    expect(rerun.calls).toEqual([missing]);
    expect(existsSync(missing)).toBe(true);
  });

  test("输入校验: durations 长度不符 / 非正值 → ValidationError (BR-U4-6 形状)", async () => {
    const dir = fakeDir(root);
    const raster = fakeRasterizer();
    expect(
      renderCards(script, [4], template, dir, { rasterizeFn: raster.fn }),
    ).rejects.toThrow(ValidationError);
    expect(
      renderCards(script, [4, 0], template, dir, { rasterizeFn: raster.fn }),
    ).rejects.toThrow(ValidationError);
    expect(raster.calls).toEqual([]);
  });
});

describe("allocatePageDurations (决策树: 帧时长分配)", () => {
  function pagesLayout(pages: string[][]): CardLayout {
    return { titleLines: ["x"], subtitlePages: pages, emphasisRanges: [] };
  }

  test("n=1 → 全段时长; n>1 → 占比取整 + 末页余数（奇数除不尽）", () => {
    expect(allocatePageDurations(pagesLayout([[]]), 7.37, 0)).toEqual([7.37]);
    // 3 页等字数，10s / 3: 3.33 + 3.33 + 余数 3.34 = 10（±0.05 不变式内）。
    const equalPages = pagesLayout([
      ["水".repeat(22)],
      ["水".repeat(22)],
      ["水".repeat(22)],
    ]);
    expect(allocatePageDurations(equalPages, 10, 1)).toEqual([
      3.33, 3.33, 3.34,
    ]);
  });

  test("非正页时长（段时长过短被取整挤占）→ RenderError 守护", () => {
    const skewed = pagesLayout([["水".repeat(66)], ["水"]]);
    // 0.01s 段: 首页 round(0.01×66/67)=0.01, 末页 0 → 非正守护触发。
    expect(() => allocatePageDurations(skewed, 0.01, 0)).toThrow(RenderError);
  });
});

describe("rasterize（唯一真实 resvg 烟雾用例）", () => {
  test("tiny SVG → PNG: 魔数 + 尺寸 + 文件落盘（bun/macOS-arm64 绑定可用）", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#e63946"/></svg>';
    const out = join(root, "smoke.png");
    const png = await rasterize(svg, out);
    expect(png).toEqual({ path: out, width: 64, height: 64 });
    const bytes = readFileSync(out);
    expect([...bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]); // PNG magic
    expect(bytes.length).toBeGreaterThan(8);
    expect(existsSync(`${out}.tmp`)).toBe(false); // 原子写完成后无残留
  });

  test("非法 SVG → RenderError（带 svg 长度与页标识）", async () => {
    expect(rasterize("not an svg", join(root, "bad.png"))).rejects.toThrow(
      RenderError,
    );
  });
});
