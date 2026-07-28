/**
 * Offline tests for the TTS orchestration (no network, no ffmpeg): fake
 * backend injection for the retry policy (BR-U2-1), idempotent skip
 * (BR-U2-2), durations.json shape (BR-U2-3), mergeAudio duration assertion
 * (BR-U2-5), contiguity invariant, clearAudio's blast radius, and the
 * backend registry (incl. the paid backend's fail-fast construction).
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MediaInfo } from "@adapters/ffmpeg";
import { DEFAULT_TTS_VOICES } from "@core/config";
import {
  TTSBackendError,
  TTSNetworkError,
  ValidationError,
} from "@core/errors";
import type { VideoDir } from "@core/workdir";
import {
  EdgeTtsBackend,
  MinimaxTtsBackend,
  clearAudio,
  mergeAudio,
  SayTtsBackend,
  synthesizeScript,
  TTS_BACKENDS,
  createTtsBackend,
  type SegmentAudio,
  type TtsBackend,
  type VoiceOpts,
} from "@core/tts";

// ---- offline test doubles -------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Minimal VideoDir over a temp tree (structural — no workdir I/O needed). */
function makeVideoDir(): VideoDir {
  const root = mkdtempSync(join(tmpdir(), "mva-tts-test-"));
  tempRoots.push(root);
  return {
    slug: "test",
    root,
    paths: {
      input: join(root, "input"),
      script: join(root, "script"),
      audio: join(root, "audio"),
      cards: join(root, "cards"),
      video: join(root, "video"),
      pkg: join(root, "package"),
    },
    state: { slug: "test", createdAt: "2026-07-23T00:00:00Z", steps: {} },
  };
}

type PlanStep = "network" | "backend" | "ok";

/** Fake backend: consumes a per-call plan; "ok" writes a temp audio file. */
class FakeBackend implements TtsBackend {
  readonly id = "fake";
  readonly defaultVoice = "fake-voice";
  readonly calls: Array<{ text: string; voice: VoiceOpts }> = [];

  constructor(private readonly plan: PlanStep[] = []) {}

  async synthesize(text: string, voice: VoiceOpts) {
    this.calls.push({ text, voice });
    const step = this.plan.shift() ?? "ok";
    const ctx = { backend: this.id, segmentIndex: voice.segmentIndex ?? -1 };
    if (step === "network") throw new TTSNetworkError("fake offline", ctx);
    if (step === "backend") throw new TTSBackendError("fake broken", ctx);
    const dir = mkdtempSync(join(tmpdir(), "mva-fake-tts-"));
    tempRoots.push(dir);
    const path = join(dir, "out.mp3");
    writeFileSync(path, `audio:${text}`);
    return { path, durationSec: 0 };
  }
}

/** Fake prober: constant 2s per file (offline, BR-U2-3 seam). */
const fakeProbe = (durationSec: number) => async (): Promise<MediaInfo> => ({
  width: 0,
  height: 0,
  durationSec,
  videoStreams: 0,
  audioStreams: 1,
});

function makeSleepRecorder() {
  const sleeps: number[] = [];
  return { sleeps, sleepFn: async (ms: number) => void sleeps.push(ms) };
}

const zeroJitter = () => 0;

const script = {
  segments: [{ text: "第一段" }, { text: "第二段" }, { text: "第三段" }],
};

// ---- synthesizeScript ------------------------------------------------------

describe("synthesizeScript", () => {
  test("happy path: seg-NN.mp3 files, measured durations.json, ordered result", async () => {
    const dir = makeVideoDir();
    const backend = new FakeBackend();
    const result = await synthesizeScript(script, backend, dir, {
      probeFn: fakeProbe(2),
      sleepFn: makeSleepRecorder().sleepFn,
      jitterFn: zeroJitter,
    });

    expect(result).toHaveLength(3);
    for (const [i, seg] of result.entries()) {
      expect(seg.index).toBe(i);
      expect(seg.audio.durationSec).toBe(2);
      expect(seg.audio.path).toBe(join(dir.paths.audio, `seg-0${i}.mp3`));
      expect(existsSync(seg.audio.path)).toBe(true);
    }
    // backend temp files were moved, contents intact
    expect(readFileSync(join(dir.paths.audio, "seg-01.mp3"), "utf8")).toBe(
      "audio:第二段",
    );
    // durations.json shape (BR-U2-3: measured values only)
    const durations = JSON.parse(
      readFileSync(join(dir.paths.audio, "durations.json"), "utf8"),
    );
    expect(durations).toEqual({ perSegment: [2, 2, 2], total: 6 });
  });

  test("idempotent skip: existing segments are never re-synthesized (BR-U2-2)", async () => {
    const dir = makeVideoDir();
    mkdirSync(dir.paths.audio, { recursive: true });
    writeFileSync(join(dir.paths.audio, "seg-00.mp3"), "pre-existing");

    const backend = new FakeBackend();
    await synthesizeScript(script, backend, dir, {
      probeFn: fakeProbe(2),
      jitterFn: zeroJitter,
    });

    // backend called only for segments 1 and 2
    expect(backend.calls.map((c) => c.voice.segmentIndex)).toEqual([1, 2]);
    // the pre-existing segment is untouched
    expect(readFileSync(join(dir.paths.audio, "seg-00.mp3"), "utf8")).toBe(
      "pre-existing",
    );
  });

  test("network errors retry with backoff 500/1000 then succeed (BR-U2-1)", async () => {
    const dir = makeVideoDir();
    const backend = new FakeBackend(["network", "network", "ok", "ok", "ok"]);
    const { sleeps, sleepFn } = makeSleepRecorder();

    const result = await synthesizeScript(script, backend, dir, {
      probeFn: fakeProbe(2),
      sleepFn,
      jitterFn: zeroJitter,
    });

    expect(result).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(backend.calls).toHaveLength(5); // 3 attempts for seg 0 + 1 each
  });

  test("network retries exhaust after 3 backoffs and rethrow (BR-U2-1)", async () => {
    const dir = makeVideoDir();
    const backend = new FakeBackend([
      "network",
      "network",
      "network",
      "network",
    ]);
    const { sleeps, sleepFn } = makeSleepRecorder();

    await expect(
      synthesizeScript(script, backend, dir, {
        probeFn: fakeProbe(2),
        sleepFn,
        jitterFn: zeroJitter,
      }),
    ).rejects.toBeInstanceOf(TTSNetworkError);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(backend.calls).toHaveLength(4); // initial + 3 retries
  });

  test("non-network TTS errors throw immediately without retry (BR-U2-1)", async () => {
    const dir = makeVideoDir();
    const backend = new FakeBackend(["backend"]);
    const { sleeps, sleepFn } = makeSleepRecorder();

    await expect(
      synthesizeScript(script, backend, dir, {
        probeFn: fakeProbe(2),
        sleepFn,
        jitterFn: zeroJitter,
      }),
    ).rejects.toBeInstanceOf(TTSBackendError);
    expect(sleeps).toEqual([]);
    expect(backend.calls).toHaveLength(1);
  });

  test("jitter is added on top of the base backoff", async () => {
    const dir = makeVideoDir();
    const backend = new FakeBackend(["network", "network", "ok", "ok", "ok"]);
    const { sleeps, sleepFn } = makeSleepRecorder();

    await synthesizeScript(script, backend, dir, {
      probeFn: fakeProbe(2),
      sleepFn,
      jitterFn: () => 1, // max jitter: +250ms (JITTER_MAX_MS)
    });
    expect(sleeps).toEqual([750, 1250]);
  });

  test("empty segments are rejected defensively", async () => {
    const dir = makeVideoDir();
    await expect(
      synthesizeScript({ segments: [] }, new FakeBackend(), dir, {
        probeFn: fakeProbe(2),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---- mergeAudio -------------------------------------------------------------

function makeSegments(dir: VideoDir, durations: number[]): SegmentAudio[] {
  return durations.map((durationSec, index) => ({
    index,
    audio: {
      path: join(dir.paths.audio, `seg-0${index}.mp3`),
      durationSec,
    },
  }));
}

describe("mergeAudio", () => {
  test("normalize → concat → offsets: argv sequence and durations.json update", async () => {
    const dir = makeVideoDir();
    mkdirSync(dir.paths.audio, { recursive: true });
    const segments = makeSegments(dir, [2, 3, 1.5]);
    const ran: string[][] = [];

    const track = await mergeAudio(segments, dir, {
      probeFn: fakeProbe(6.5),
      runFn: async (argv) => void ran.push(argv),
    });

    // 3 normalizations + 1 concat, all argv arrays
    expect(ran).toHaveLength(4);
    expect(ran[0]).toContain(join(dir.paths.audio, "seg-00.norm.m4a"));
    expect(ran[3]!.at(-1)).toBe(join(dir.paths.audio, "merged.m4a"));

    // prefix-sum offsets (monotonic, U4 timing source)
    expect(track.segmentOffsets).toEqual([0, 2, 5]);
    expect(track.durationSec).toBe(6.5);
    expect(track.path).toBe(join(dir.paths.audio, "merged.m4a"));

    const durations = JSON.parse(
      readFileSync(join(dir.paths.audio, "durations.json"), "utf8"),
    );
    expect(durations).toEqual({
      perSegment: [2, 3, 1.5],
      total: 6.5,
      segmentOffsets: [0, 2, 5],
    });
  });

  test("duration assertion violation → ValidationError (BR-U2-5)", async () => {
    const dir = makeVideoDir();
    mkdirSync(dir.paths.audio, { recursive: true });
    const segments = makeSegments(dir, [2, 3]);

    await expect(
      mergeAudio(segments, dir, {
        probeFn: fakeProbe(10), // Σ = 5, merged claims 10 → > ±1s
        runFn: async () => {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("non-contiguous segment indexes → ValidationError (invariant 1)", async () => {
    const dir = makeVideoDir();
    const segments = makeSegments(dir, [2, 3]);
    segments[1]!.index = 2; // hole at index 1

    await expect(
      mergeAudio(segments, dir, {
        probeFn: fakeProbe(5),
        runFn: async () => {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("empty segments → ValidationError", async () => {
    const dir = makeVideoDir();
    await expect(
      mergeAudio([], dir, { probeFn: fakeProbe(0), runFn: async () => {} }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---- registry ----------------------------------------------------------------

describe("TTS backend registry", () => {
  test("registry holds edge and say factories with config default voices", () => {
    const edge = TTS_BACKENDS.edge();
    const say = TTS_BACKENDS.say();
    expect(edge).toBeInstanceOf(EdgeTtsBackend);
    expect(say).toBeInstanceOf(SayTtsBackend);
    expect(edge.id).toBe("edge");
    expect(say.id).toBe("say");
    expect(edge.defaultVoice).toBe(DEFAULT_TTS_VOICES.edge);
    expect(say.defaultVoice).toBe(DEFAULT_TTS_VOICES.say);
  });

  test("createTtsBackend selects by AppConfig.ttsBackend name", () => {
    expect(createTtsBackend("edge")).toBeInstanceOf(EdgeTtsBackend);
    expect(createTtsBackend("say")).toBeInstanceOf(SayTtsBackend);
  });

  test("免费后端不带 usage 计数（只有收费后端记账单口径）", () => {
    expect(TTS_BACKENDS.edge().usage).toBeUndefined();
    expect(TTS_BACKENDS.say().usage).toBeUndefined();
  });

  test("minimax 在注册表里，且缺凭据时构造即失败（不会花钱到一半才报）", () => {
    const saved = process.env["MINIMAX_API_KEY"];
    delete process.env["MINIMAX_API_KEY"];
    try {
      expect(() => createTtsBackend("minimax")).toThrow(/MINIMAX_API_KEY/);
      process.env["MINIMAX_API_KEY"] = "test-key-not-real";
      const backend = createTtsBackend("minimax");
      expect(backend).toBeInstanceOf(MinimaxTtsBackend);
      expect(backend.id).toBe("minimax");
      expect(backend.defaultVoice).toBe(DEFAULT_TTS_VOICES.minimax);
      expect(backend.usage).toEqual({ characters: 0, requests: 0 });
    } finally {
      if (saved === undefined) delete process.env["MINIMAX_API_KEY"];
      else process.env["MINIMAX_API_KEY"] = saved;
    }
  });
});

// ---- clearAudio (BR-U2-2 的显式逃生口) ---------------------------------------

describe("clearAudio", () => {
  test("只清 audio/ 下的音频产物，其他文件不动", () => {
    const dir = makeVideoDir();
    mkdirSync(dir.paths.audio, { recursive: true });
    const write = (name: string): string => {
      const path = join(dir.paths.audio, name);
      writeFileSync(path, "x");
      return path;
    };
    const seg = write("seg-00.mp3");
    const norm = write("seg-00.norm.m4a");
    const merged = write("merged.m4a");
    const durations = write("durations.json");
    const leftover = write("durations.json.tmp");
    const keep = write("notes.txt");

    const removed = clearAudio(dir);

    expect(removed).toEqual([
      "durations.json",
      "durations.json.tmp",
      "merged.m4a",
      "seg-00.mp3",
      "seg-00.norm.m4a",
    ]);
    for (const path of [seg, norm, merged, durations, leftover]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(keep)).toBe(true);
  });

  test("audio/ 不存在时是空操作（不建目录、不报错）", () => {
    const dir = makeVideoDir();
    expect(clearAudio(dir)).toEqual([]);
    expect(existsSync(dir.paths.audio)).toBe(false);
  });
});
