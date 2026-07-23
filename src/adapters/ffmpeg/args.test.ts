/**
 * Tests for the pure argv builder family (FR-3.3 AC-1): full-argv snapshots,
 * repeat-call determinism, the no-shell-string ban (BR-U2-6/7), concat-list
 * content derived from the frame duration table, and validation failures.
 */
import { describe, expect, test } from "bun:test";

import {
  buildComposeArgs,
  buildComposeConcatList,
  buildConcatArgs,
  buildNormalizeArgs,
  buildProbeArgs,
  composeConcatListPath,
  DEFAULT_ENCODE_OPTIONS,
  type ComposeJob,
} from "@adapters/ffmpeg";
import { ValidationError } from "@core/errors";

const job: ComposeJob = {
  frames: [
    { path: "/v/demo/cards/card-00.png", displaySec: 3.2 },
    { path: "/v/demo/cards/card-01.png", displaySec: 2.8 },
    { path: "/v/demo/cards/card-02.png", displaySec: 4 },
  ],
  audioTrack: "/v/demo/audio/merged.m4a",
  segmentDurations: [3.2, 2.8, 4],
  output: {
    path: "/v/demo/video/video.mp4",
    width: 1080,
    height: 1920,
    fps: 30,
  },
};

describe("buildComposeArgs", () => {
  test("full argv snapshot (concat demuxer stills + audio mux + encode params)", () => {
    expect(buildComposeArgs(job)).toEqual([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "/v/demo/video/video.mp4.concat.txt",
      "-i",
      "/v/demo/audio/merged.m4a",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      "scale=1080:1920",
      "-r",
      "30",
      "-vsync",
      "cfr",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      "/v/demo/video/video.mp4",
    ]);
  });

  test("encode options are injected from config, not the job", () => {
    const argv = buildComposeArgs(job, {
      ...DEFAULT_ENCODE_OPTIONS,
      crf: 18,
      preset: "slow",
    });
    expect(argv).toContain("18");
    expect(argv).toContain("slow");
    expect(argv).not.toContain("23");
  });

  test("concat list path derives deterministically from output.path", () => {
    expect(composeConcatListPath(job)).toBe(
      "/v/demo/video/video.mp4.concat.txt",
    );
  });

  test("rejects empty frames, bad displaySec, bad fps, empty audio track", () => {
    expect(() => buildComposeArgs({ ...job, frames: [] })).toThrow(
      ValidationError,
    );
    expect(() =>
      buildComposeArgs({
        ...job,
        frames: [{ path: "/f.png", displaySec: 0 }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildComposeArgs({
        ...job,
        frames: [{ path: "/f.png", displaySec: Number.NaN }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildComposeArgs({ ...job, output: { ...job.output, fps: 0 } }),
    ).toThrow(ValidationError);
    expect(() => buildComposeArgs({ ...job, audioTrack: "" })).toThrow(
      ValidationError,
    );
  });
});

describe("buildComposeConcatList", () => {
  test("frame duration table → concat list content (last frame repeated)", () => {
    expect(buildComposeConcatList(job.frames)).toBe(
      [
        "ffconcat version 1.0",
        "file '/v/demo/cards/card-00.png'",
        "duration 3.200",
        "file '/v/demo/cards/card-01.png'",
        "duration 2.800",
        "file '/v/demo/cards/card-02.png'",
        "duration 4.000",
        "file '/v/demo/cards/card-02.png'",
        "",
      ].join("\n"),
    );
  });

  test("escapes single quotes in frame paths", () => {
    const list = buildComposeConcatList([
      { path: "/v/it's/card.png", displaySec: 1 },
    ]);
    expect(list).toContain("file '/v/it'\\''s/card.png'");
  });

  test("rejects an empty frame table", () => {
    expect(() => buildComposeConcatList([])).toThrow(ValidationError);
  });
});

describe("buildConcatArgs", () => {
  test("full argv snapshot (concat filter, locked AudioSpec output)", () => {
    expect(
      buildConcatArgs(
        ["/a/seg-00.norm.m4a", "/a/seg-01.norm.m4a"],
        "/a/merged.m4a",
      ),
    ).toEqual([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-i",
      "/a/seg-00.norm.m4a",
      "-i",
      "/a/seg-01.norm.m4a",
      "-filter_complex",
      "[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]",
      "-map",
      "[a]",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "/a/merged.m4a",
    ]);
  });

  test("rejects empty inputs and empty output", () => {
    expect(() => buildConcatArgs([], "/a/out.m4a")).toThrow(ValidationError);
    expect(() => buildConcatArgs(["/a/x.m4a"], "")).toThrow(ValidationError);
    expect(() => buildConcatArgs(["", "/a/x.m4a"], "/a/out.m4a")).toThrow(
      ValidationError,
    );
  });
});

describe("buildNormalizeArgs / buildProbeArgs", () => {
  test("normalize argv snapshot (aac 48kHz stereo, BR-U2-4)", () => {
    expect(buildNormalizeArgs("/a/seg-00.mp3", "/a/seg-00.norm.m4a")).toEqual([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-i",
      "/a/seg-00.mp3",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "/a/seg-00.norm.m4a",
    ]);
  });

  test("probe argv snapshot (JSON structural probe)", () => {
    expect(buildProbeArgs("/v/demo/video/video.mp4")).toEqual([
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      "/v/demo/video/video.mp4",
    ]);
  });

  test("executable overrides land at argv[0] only", () => {
    expect(
      buildProbeArgs("/x.mp4", { ffprobePath: "/opt/bin/ffprobe" })[0],
    ).toBe("/opt/bin/ffprobe");
    expect(
      buildNormalizeArgs("/a.mp3", "/b.m4a", {
        ffmpegPath: "/opt/bin/ffmpeg",
      })[0],
    ).toBe("/opt/bin/ffmpeg");
  });

  test("rejects empty paths", () => {
    expect(() => buildProbeArgs("")).toThrow(ValidationError);
    expect(() => buildNormalizeArgs("", "/b.m4a")).toThrow(ValidationError);
    expect(() => buildNormalizeArgs("/a.mp3", "")).toThrow(ValidationError);
  });
});

describe("purity discipline (BR-U2-6/7, FR-3.3 AC-1)", () => {
  const builds: Array<[string, () => string[]]> = [
    ["compose", () => buildComposeArgs(job)],
    ["concat", () => buildConcatArgs(["/a/x.m4a", "/a/y.m4a"], "/a/out.m4a")],
    ["normalize", () => buildNormalizeArgs("/a/x.mp3", "/a/x.norm.m4a")],
    ["probe", () => buildProbeArgs("/a/out.m4a")],
  ];

  test("repeat calls with the same input are element-wise identical", () => {
    for (const [, build] of builds) {
      expect(build()).toEqual(build());
    }
  });

  test("argv arrays contain no shell strings (no whitespace-joined commands)", () => {
    for (const [name, build] of builds) {
      const argv = build();
      expect(Array.isArray(argv)).toBe(true);
      for (const element of argv) {
        // A joined command like "ffmpeg -i in" would contain whitespace;
        // every element here is a single token (fixture paths are space-free).
        expect(/\s/.test(element), `${name}: "${element}"`).toBe(false);
      }
    }
  });
});
