/**
 * @adapters/ffmpeg mix 单测：buildSfxMixArgs 纯 argv 构建器——输入编号、
 * filtergraph 结构、时长锚（duration=first）、防御断言。
 */
import { describe, expect, test } from "bun:test";

import { ValidationError } from "@core/errors";

import {
  buildSfxMixArgs,
  hasSfxWork,
  SFX_EVENTS_MAX,
  WHOOSH_VOLUME,
  WRITING_VOLUME,
  type SfxMixJob,
} from "./mix";

const base: SfxMixJob = {
  narration: "/a/merged.m4a",
  writingSpans: [
    { t0: 1, t1: 3.5 },
    { t0: 5, t1: 6 },
  ],
  whooshTimes: [4.2],
  output: "/a/merged-sfx.m4a",
};

describe("hasSfxWork", () => {
  test("无文件或无事件 → false", () => {
    expect(hasSfxWork(base)).toBe(false); // 无文件
    expect(
      hasSfxWork({ ...base, writingFile: "/w.wav", writingSpans: [] }),
    ).toBe(false);
    expect(hasSfxWork({ ...base, whooshFile: "/x.wav" })).toBe(true);
  });
});

describe("buildSfxMixArgs", () => {
  test("双音效：输入编号 1=writing(循环) 2=whoosh，graph 结构完整", () => {
    const argv = buildSfxMixArgs({
      ...base,
      writingFile: "/w.wav",
      whooshFile: "/x.wav",
    });
    expect(argv[0]).toBe("ffmpeg");
    // writing 输入带 -stream_loop -1
    const loopIdx = argv.indexOf("-stream_loop");
    expect(loopIdx).toBeGreaterThan(0);
    expect(argv[loopIdx + 1]).toBe("-1");
    expect(argv[loopIdx + 3]).toBe("/w.wav");
    const graph = argv[argv.indexOf("-filter_complex") + 1]!;
    // 2 段 writing：asplit=2 + 各自 atrim/adelay/volume
    expect(graph).toContain("[1:a]asplit=2[w0][w1]");
    expect(graph).toContain(
      `atrim=0:2.500,adelay=1000|1000,volume=${WRITING_VOLUME}`,
    );
    expect(graph).toContain(`adelay=5000|5000`);
    // whoosh：输入 2、adelay 4200
    expect(graph).toContain("[2:a]asplit=1[x0]");
    expect(graph).toContain(`adelay=4200|4200,volume=${WHOOSH_VOLUME}`);
    // 时长锚：口播为 first，normalize=0
    expect(graph).toContain("amix=inputs=4:duration=first:normalize=0[mix]");
    // 输出映射与编码
    expect(argv).toContain("[mix]");
    expect(argv[argv.length - 1]).toBe("/a/merged-sfx.m4a");
  });

  test("仅 whoosh：输入编号 1，无 stream_loop", () => {
    const argv = buildSfxMixArgs({ ...base, whooshFile: "/x.wav" });
    expect(argv).not.toContain("-stream_loop");
    const graph = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[1:a]asplit=1[x0]");
    expect(graph).toContain("amix=inputs=2:duration=first:normalize=0[mix]");
  });

  test("ffmpegPath override 生效", () => {
    const argv = buildSfxMixArgs(
      { ...base, whooshFile: "/x.wav" },
      { ffmpegPath: "/opt/ffmpeg" },
    );
    expect(argv[0]).toBe("/opt/ffmpeg");
  });

  test("防御断言：无事件/超上限/非法区间被拒", () => {
    expect(() => buildSfxMixArgs(base)).toThrow(ValidationError);
    expect(() =>
      buildSfxMixArgs({
        ...base,
        writingFile: "/w.wav",
        writingSpans: Array.from({ length: SFX_EVENTS_MAX + 1 }, (_, i) => ({
          t0: i,
          t1: i + 0.5,
        })),
      }),
    ).toThrow("超上限");
    expect(() =>
      buildSfxMixArgs({
        ...base,
        writingFile: "/w.wav",
        writingSpans: [{ t0: 2, t1: 1 }],
      }),
    ).toThrow("区间非法");
  });
});
