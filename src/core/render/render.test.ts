/**
 * Tests for FfmpegComposeBackend (Workflow 4): pre-compose alignment
 * assertion (±0.1s), concat-list persistence (U2 caller contract), probe
 * self-check with output deletion (BR-U4-9 / FR-3 AC-2). All offline —
 * runFn/probeFn injected fakes, no ffmpeg spawned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildComposeConcatList, type MediaInfo } from "@adapters/ffmpeg";
import { ValidationError } from "@core/errors";
import { FfmpegComposeBackend, type RenderJob } from "@core/render";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "u4-render-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeJob(): RenderJob {
  return {
    frames: [
      { path: join(root, "card-00-0.png"), displaySec: 4 },
      { path: join(root, "card-01-0.png"), displaySec: 3.96 },
      { path: join(root, "card-01-1.png"), displaySec: 3.96 },
      { path: join(root, "card-01-2.png"), displaySec: 1.08 },
    ],
    audioTrack: join(root, "merged.m4a"),
    segmentDurations: [4, 9],
    output: {
      path: join(root, "video.mp4"),
      width: 1080,
      height: 1920,
      fps: 30,
    },
  };
}

const goodVideo: MediaInfo = {
  width: 1080,
  height: 1920,
  durationSec: 13.1,
  videoStreams: 1,
  audioStreams: 1,
};
const audioInfo: MediaInfo = {
  width: 0,
  height: 0,
  durationSec: 13.0,
  videoStreams: 0,
  audioStreams: 1,
};

interface Fakes {
  argvCalls: string[][];
  backend: FfmpegComposeBackend;
}

function makeBackend(videoInfo: MediaInfo): Fakes {
  const argvCalls: string[][] = [];
  const backend = new FfmpegComposeBackend({
    runFn: async (argv) => {
      argvCalls.push(argv);
      await Bun.write(argv[argv.length - 1]!, "fake mp4"); // 产出落盘
    },
    probeFn: async (path) => (path.endsWith(".mp4") ? videoInfo : audioInfo),
  });
  return { argvCalls, backend };
}

describe("FfmpegComposeBackend.compose (Workflow 4)", () => {
  test("happy path: concat 列表落盘（U2 纯函数内容）→ runFfmpeg → VideoResult", async () => {
    const job = makeJob();
    const { argvCalls, backend } = makeBackend(goodVideo);
    const result = await backend.compose(job);

    expect(result).toEqual({
      path: job.output.path,
      durationSec: 13.1,
      probe: goodVideo,
    });
    // Concat list: caller-written, content from the pure builder.
    const listPath = `${job.output.path}.concat.txt`;
    expect(readFileSync(listPath, "utf8")).toBe(
      buildComposeConcatList(job.frames),
    );
    expect(argvCalls.length).toBe(1);
    expect(argvCalls[0]).toContain(listPath);
    expect(argvCalls[0]![argvCalls[0]!.length - 1]).toBe(job.output.path);
  });

  test("前置断言: Σframes ≠ Σsegments（±0.1s 外）→ ValidationError，不触发执行", async () => {
    const job = makeJob();
    job.segmentDurations = [4, 9.5]; // Σ=13.5 vs frames Σ=13.0
    const { argvCalls, backend } = makeBackend(goodVideo);
    expect(backend.compose(job)).rejects.toThrow(ValidationError);
    expect(argvCalls).toEqual([]);
    expect(existsSync(`${job.output.path}.concat.txt`)).toBe(false);
  });

  test("防御断言: frames 空 / displaySec 非正 / audioTrack 空 → ValidationError", async () => {
    const { backend } = makeBackend(goodVideo);
    expect(backend.compose({ ...makeJob(), frames: [] })).rejects.toThrow(
      ValidationError,
    );
    const badFrame = makeJob();
    badFrame.frames[0] = { path: badFrame.frames[0]!.path, displaySec: 0 };
    expect(backend.compose(badFrame)).rejects.toThrow(ValidationError);
    expect(backend.compose({ ...makeJob(), audioTrack: "" })).rejects.toThrow(
      ValidationError,
    );
  });

  test("probe 自检: 分辨率不符 → 删除产物 + ValidationError（不留半成品）", async () => {
    const job = makeJob();
    const { backend } = makeBackend({ ...goodVideo, height: 1080 });
    expect(backend.compose(job)).rejects.toThrow(ValidationError);
    await Bun.sleep(0); // 让删除完成后再断言
    expect(existsSync(job.output.path)).toBe(false);
  });

  test("probe 自检: 时长偏离音轨 >2s / 流数不符 → 删除产物 + ValidationError", async () => {
    const jobA = makeJob();
    const { backend: driftBackend } = makeBackend({
      ...goodVideo,
      durationSec: 16.0, // 音轨 13.0 → 偏差 3s > ±2s
    });
    expect(driftBackend.compose(jobA)).rejects.toThrow(ValidationError);

    const jobB = makeJob();
    jobB.output = { ...jobB.output, path: join(root, "video-b.mp4") };
    const { backend: streamBackend } = makeBackend({
      ...goodVideo,
      audioStreams: 0,
    });
    expect(streamBackend.compose(jobB)).rejects.toThrow(ValidationError);
    await Bun.sleep(0);
    expect(existsSync(jobA.output.path)).toBe(false);
    expect(existsSync(jobB.output.path)).toBe(false);
  });
});
