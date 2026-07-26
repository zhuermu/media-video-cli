/**
 * mux 的封装参数与字幕偏移测试。
 *
 * 这两件事错了都不会报错，只会让成片"看起来不对"：封面没拼进去（片头缺了）
 * 或者字幕比画面早一个封面的时长（全片字幕对不上口型）。所以 argv 与偏移都
 * 做成纯函数来断言。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMuxArgs, writeSrt } from "./mux";
import type { Storyboard } from "./compose";

const BASE = {
  framePattern: "/frames/p-%05d.png",
  fps: 30,
  audioTrack: "/out/a.m4a",
  output: "/out/v.mp4",
};

describe("buildMuxArgs", () => {
  test("没有封面时是帧序列 + 音轨的直接封装", () => {
    const argv = buildMuxArgs(BASE);
    expect(argv).toContain("-shortest");
    expect(argv).not.toContain("-filter_complex");
    expect(argv[argv.length - 1]).toBe("/out/v.mp4");
  });

  test("有封面时 concat 拼在前面，音轨整体后移同样的秒数", () => {
    const argv = buildMuxArgs({
      ...BASE,
      cover: { png: "/out/cover.png", holdSec: 2.5 },
    });
    const joined = argv.join(" ");
    // 封面是第一个输入，定格 2.5s
    expect(argv.indexOf("/out/cover.png")).toBeLessThan(
      argv.indexOf("/frames/p-%05d.png"),
    );
    expect(joined).toContain("-loop 1 -t 2.500");
    // 音轨后移，且拼接顺序是 封面 → 正片
    expect(joined).toContain("-itsoffset 2.500");
    expect(joined).toContain("concat=n=2:v=1:a=0");
    expect(joined).toContain("-map [v] -map 2:a");
    // -shortest 会按最短流截断，拼了封面之后会把片尾切掉
    expect(argv).not.toContain("-shortest");
  });

  test("两条路径用同一套编码参数（否则封面段和正片画质不一致）", () => {
    const plain = buildMuxArgs(BASE).join(" ");
    const withCover = buildMuxArgs({
      ...BASE,
      cover: { png: "/c.png", holdSec: 1 },
    }).join(" ");
    for (const flag of [
      "-c:v libx264",
      "-crf 18",
      "-pix_fmt yuv420p",
      "-b:a 192k",
    ]) {
      expect(plain).toContain(flag);
      expect(withCover).toContain(flag);
    }
  });
});

describe("writeSrt", () => {
  const storyboard = {
    subtitles: [
      { t0: 0, t1: 1.5, text: "第一句" },
      { t0: 1.5, t1: 3, text: "第二句" },
    ],
  } as unknown as Storyboard;

  test("没有封面时时间戳原样写出", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "srt-")), "a.srt");
    await writeSrt(storyboard, path);
    expect(readFileSync(path, "utf8")).toContain(
      "00:00:00,000 --> 00:00:01,500",
    );
  });

  test("有封面时整体后移（画面前面多了一个封面）", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "srt-")), "b.srt");
    await writeSrt(storyboard, path, 2.5);
    const out = readFileSync(path, "utf8");
    expect(out).toContain("00:00:02,500 --> 00:00:04,000");
    expect(out).toContain("00:00:04,000 --> 00:00:05,500");
  });
});
