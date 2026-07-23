/**
 * probe/run coverage: offline unit tests for the pure parseProbeJson, plus
 * integration smoke against a real ffmpeg/ffprobe when installed (Step 6:
 * generate a 1s silent audio fixture programmatically, probe it, assert
 * MediaInfo; skipped with a note when ffmpeg is absent).
 */
import { afterAll, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProbeArgs,
  parseProbeJson,
  probe,
  runFfmpeg,
} from "@adapters/ffmpeg";
import { FfmpegError } from "@core/errors";

// ---- pure parsing (offline) -------------------------------------------------

const argv = buildProbeArgs("/x.mp4");

describe("parseProbeJson", () => {
  test("parses streams, resolution and format duration", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [
          { codec_type: "video", width: 1080, height: 1920 },
          { codec_type: "audio" },
        ],
        format: { duration: "12.500000" },
      }),
      argv,
    );
    expect(info).toEqual({
      width: 1080,
      height: 1920,
      durationSec: 12.5,
      videoStreams: 1,
      audioStreams: 1,
    });
  });

  test("falls back to the max stream duration when format has none", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [
          { codec_type: "audio", duration: "3.2" },
          { codec_type: "audio", duration: "4.1" },
        ],
        format: {},
      }),
      argv,
    );
    expect(info.durationSec).toBe(4.1);
    expect(info.audioStreams).toBe(2);
    expect(info.width).toBe(0);
  });

  test("no duration anywhere yields 0 (stills; consumers assert loudly)", () => {
    const info = parseProbeJson(
      JSON.stringify({
        streams: [{ codec_type: "video", width: 100, height: 200 }],
        format: {},
      }),
      argv,
    );
    expect(info.durationSec).toBe(0);
  });

  test("malformed JSON → FfmpegError carrying the probe argv", () => {
    try {
      parseProbeJson("not-json{", argv);
      expect.unreachable("parseProbeJson should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).argv).toEqual(argv);
    }
  });
});

// ---- integration smoke (needs real ffmpeg/ffprobe) ---------------------------

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
// Note: when ffmpeg/ffprobe are not on PATH these smoke tests are skipped —
// they re-run automatically on machines with the prerequisite installed.

const smokeDirs: string[] = [];
afterAll(() => {
  for (const dir of smokeDirs) rmSync(dir, { recursive: true, force: true });
});

describe("integration smoke (ffmpeg required)", () => {
  test.skipIf(!hasFfmpeg)(
    "generates 1s silent audio, probes it, asserts MediaInfo",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mva-smoke-"));
      smokeDirs.push(dir);
      const out = join(dir, "silence.m4a");
      await runFfmpeg(
        [
          "ffmpeg",
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          "-t",
          "1",
          "-c:a",
          "aac",
          out,
        ],
        { timeoutSec: 60 },
      );

      const info = await probe(out);
      expect(info.audioStreams).toBe(1);
      expect(info.videoStreams).toBe(0);
      expect(info.durationSec).toBeGreaterThan(0.8);
      expect(info.durationSec).toBeLessThan(1.5);
    },
  );

  test.skipIf(!hasFfmpeg)(
    "failed ffmpeg run → FfmpegError with argv + stderr tail",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mva-smoke-"));
      smokeDirs.push(dir);
      const badArgv = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        join(dir, "does-not-exist.wav"),
        join(dir, "out.m4a"),
      ];
      try {
        await runFfmpeg(badArgv, { timeoutSec: 30 });
        expect.unreachable("runFfmpeg should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FfmpegError);
        const ffmpegErr = err as FfmpegError;
        expect(ffmpegErr.argv).toEqual(badArgv);
        expect(ffmpegErr.stderr.length).toBeGreaterThan(0);
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "timeout kills the process and reports it (BR-U2-8)",
    async () => {
      // -re throttles lavfi reading to realtime: 10s of source vs 1s budget.
      const slowArgv = [
        "ffmpeg",
        "-v",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "10",
        "-f",
        "null",
        "-",
      ];
      try {
        await runFfmpeg(slowArgv, { timeoutSec: 1 });
        expect.unreachable("runFfmpeg should have timed out");
      } catch (err) {
        expect(err).toBeInstanceOf(FfmpegError);
        expect((err as FfmpegError).message).toContain("超时");
      }
    },
  );
});
