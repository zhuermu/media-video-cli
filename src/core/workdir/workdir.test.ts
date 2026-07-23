/**
 * Tests for @core/workdir — initVideo layout/slug/conflict (BR-U1-1/2),
 * stepDone idempotence truth table (FR-5.2), invariant breach -> IoError with
 * --rebuild-state hint (BR-U1-4, Q1=A), rebuildState artifact scan (BR-U1-5),
 * and atomic state writes (BR-U1-3). All tests run in mkdtemp sandboxes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IoError, NotFoundError, ValidationError } from "@core/errors";
import {
  initVideo,
  load,
  markStep,
  rebuildState,
  stepDone,
  verifyState,
  type VideoDir,
} from "@core/workdir";

let videosRoot: string;

beforeEach(async () => {
  videosRoot = await mkdtemp(join(tmpdir(), "workdir-test-"));
});

afterEach(async () => {
  await rm(videosRoot, { recursive: true, force: true });
});

/** Drops the full artifact checklist for a step onto disk. */
async function createArtifacts(
  dir: VideoDir,
  step: "script" | "tts" | "compose" | "package",
) {
  switch (step) {
    case "script":
      await writeFile(join(dir.paths.script, "script.json"), "{}");
      await writeFile(join(dir.paths.script, "script.md"), "# preview");
      break;
    case "tts":
      await writeFile(join(dir.paths.audio, "durations.json"), "{}");
      await writeFile(join(dir.paths.audio, "merged.m4a"), "audio");
      await writeFile(join(dir.paths.audio, "seg-001.mp3"), "seg");
      break;
    case "compose":
      await writeFile(join(dir.paths.video, "video.mp4"), "video");
      break;
    case "package":
      await writeFile(join(dir.paths.pkg, "manifest.json"), "{}");
      await writeFile(join(dir.paths.pkg, "SUMMARY.md"), "# summary");
      break;
  }
}

describe("@core/workdir", () => {
  test("initVideo creates the six-directory layout, input file, and state.json", async () => {
    const dir = await initVideo(
      "my-first-video",
      { kind: "topic", ref: "bun 上手" },
      { videosRoot },
    );

    for (const p of Object.values(dir.paths)) expect(existsSync(p)).toBe(true);
    expect(dir.paths.pkg.endsWith("package")).toBe(true);
    expect(await readFile(join(dir.paths.input, "topic.txt"), "utf8")).toBe(
      "bun 上手\n",
    );

    const state = JSON.parse(
      await readFile(join(dir.root, "state.json"), "utf8"),
    );
    expect(state.slug).toBe("my-first-video");
    expect(state.steps).toEqual({});
    expect(new Date(state.createdAt).toString()).not.toBe("Invalid Date");
  });

  test("initVideo with article input copies the .md preserving its file name", async () => {
    const articlePath = join(videosRoot, "source-article.md");
    await writeFile(articlePath, "# article body");
    const dir = await initVideo(
      "from-article",
      { kind: "article", ref: articlePath },
      { videosRoot },
    );
    expect(
      await readFile(join(dir.paths.input, "source-article.md"), "utf8"),
    ).toBe("# article body");
  });

  test("initVideo rejects invalid slugs and bad input refs without residue (BR-U1-1)", async () => {
    // Invalid slugs: uppercase, leading hyphen, too short, too long.
    for (const slug of ["Bad-Slug", "-bad", "a", `a${"x".repeat(64)}`]) {
      expect(
        initVideo(slug, { kind: "topic", ref: "t" }, { videosRoot }),
      ).rejects.toThrow(ValidationError);
    }
    // Bad input refs, valid slug: no directory must be left behind.
    expect(
      initVideo(
        "no-md",
        { kind: "article", ref: "/tmp/x.txt" },
        { videosRoot },
      ),
    ).rejects.toThrow(ValidationError);
    expect(
      initVideo(
        "gone-md",
        { kind: "article", ref: join(videosRoot, "missing.md") },
        { videosRoot },
      ),
    ).rejects.toThrow(NotFoundError);
    expect(
      initVideo("empty-topic", { kind: "topic", ref: "   " }, { videosRoot }),
    ).rejects.toThrow(ValidationError);
    for (const slug of ["no-md", "gone-md", "empty-topic"]) {
      expect(existsSync(join(videosRoot, slug))).toBe(false);
    }
  });

  test("initVideo rejects an existing directory, no auto-rename (BR-U1-2, Q2=A)", async () => {
    await initVideo("taken-slug", { kind: "topic", ref: "t" }, { videosRoot });
    expect(
      initVideo("taken-slug", { kind: "topic", ref: "t" }, { videosRoot }),
    ).rejects.toThrow(ValidationError);
    try {
      await initVideo(
        "taken-slug",
        { kind: "topic", ref: "t" },
        { videosRoot },
      );
    } catch (err) {
      expect((err as Error).message).toContain("load");
    }
  });

  test("stepDone truth table: unmarked -> false; marked + artifacts -> true (FR-5.2)", async () => {
    const dir = await initVideo(
      "truth-table",
      { kind: "topic", ref: "t" },
      { videosRoot },
    );
    expect(stepDone(dir, "script")).toBe(false); // not recorded

    await createArtifacts(dir, "script");
    await markStep(dir, "script", { source: "test" });
    expect(stepDone(dir, "script")).toBe(true); // recorded + complete checklist

    const reloaded = await load("truth-table", { videosRoot });
    expect(stepDone(reloaded, "script")).toBe(true); // persisted across load
    expect(reloaded.state.steps.script?.meta).toEqual({ source: "test" });
  });

  test("invariant breach: state claims done but artifacts missing -> IoError with --rebuild-state (BR-U1-4)", async () => {
    const dir = await initVideo(
      "broken-state",
      { kind: "topic", ref: "t" },
      { videosRoot },
    );
    await markStep(dir, "compose", {}); // no video.mp4 on disk -> state over-records

    expect(() => stepDone(dir, "compose")).toThrow(IoError);
    try {
      stepDone(dir, "compose");
    } catch (err) {
      expect((err as Error).message).toContain("--rebuild-state");
      expect((err as Error).message).toContain("video.mp4");
    }
    expect(() => verifyState(dir)).toThrow(IoError);

    // A clean state passes verifyState.
    const clean = await initVideo(
      "clean-state",
      { kind: "topic", ref: "t" },
      { videosRoot },
    );
    expect(() => verifyState(clean)).not.toThrow();
  });

  test("rebuildState rebuilds steps from artifact existence only (BR-U1-5, Q1=A)", async () => {
    const dir = await initVideo(
      "rebuild-me",
      { kind: "topic", ref: "t" },
      { videosRoot },
    );
    await createArtifacts(dir, "script");
    await createArtifacts(dir, "tts");
    // compose/package artifacts intentionally absent.

    const { state, rebuiltSteps } = await rebuildState(dir);
    expect(rebuiltSteps).toEqual(["script", "tts"]);
    expect(state.steps.script?.meta).toEqual({ rebuilt: true });
    expect(state.steps.tts?.meta).toEqual({ rebuilt: true });
    expect(state.steps.compose).toBeUndefined();
    expect(state.steps.package).toBeUndefined();
    expect(new Date(state.steps.script!.completedAt).toString()).not.toBe(
      "Invalid Date",
    );

    // Rebuilt state satisfies the invariant and persists to disk.
    expect(() => verifyState(dir)).not.toThrow();
    const reloaded = await load("rebuild-me", { videosRoot });
    expect(stepDone(reloaded, "script")).toBe(true);
    expect(stepDone(reloaded, "compose")).toBe(false);
  });

  test("state writes are atomic: no .tmp residue, valid JSON after markStep (BR-U1-3)", async () => {
    const dir = await initVideo(
      "atomic-write",
      { kind: "topic", ref: "t" },
      { videosRoot },
    );
    await createArtifacts(dir, "script");
    await markStep(dir, "script", { attempt: 1 });

    expect(existsSync(join(dir.root, "state.json.tmp"))).toBe(false);
    const state = JSON.parse(
      await readFile(join(dir.root, "state.json"), "utf8"),
    );
    expect(state.steps.script.meta).toEqual({ attempt: 1 });
  });

  test("load: missing dir -> NotFoundError; corrupt state.json -> IoError with rebuild hint", async () => {
    expect(load("never-created", { videosRoot })).rejects.toThrow(
      NotFoundError,
    );

    const root = join(videosRoot, "corrupt-state");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "state.json"), "{ not json !!");
    expect(load("corrupt-state", { videosRoot })).rejects.toThrow(IoError);
    try {
      await load("corrupt-state", { videosRoot });
    } catch (err) {
      expect((err as Error).message).toContain("--rebuild-state");
    }
  });
});
