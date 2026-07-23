/**
 * Offline tests for publish-package assembly and contract validation (no
 * network, no ffmpeg): fake probe + fake conversion executor injection.
 *
 * Covers: pre-flight itemized violations (BR-U5-12), cover rule + fallback
 * (BR-U5-5), atomic assembly (BR-U5-4), materials-manifest auto entries
 * (BR-U5-3), the FR-4 AC GOLDEN CASE (delete aigc-declaration.md → layer-1
 * violation on aigc_declaration.path), three-layer independence (no
 * short-circuit), frontmatter bidirectional consistency, and the
 * ContractViolationError CLI gate (BR-U5-1).
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
import { ContractViolationError, ValidationError } from "@core/errors";
import type { VideoDir } from "@core/workdir";
import {
  assemble,
  assertPackageDeliverable,
  countManifestEntries,
  validatePackage,
  type AssembleOptions,
  type ManifestV1,
  type MetadataFiles,
} from "@core/pkg";

// ---- offline fixtures -------------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Minimal VideoDir over a temp tree (structural — no workdir I/O needed). */
function makeVideoDir(): VideoDir {
  const root = mkdtempSync(join(tmpdir(), "mva-pkg-test-"));
  tempRoots.push(root);
  const dir: VideoDir = {
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
  for (const path of Object.values(dir.paths)) {
    mkdirSync(path, { recursive: true });
  }
  return dir;
}

const FRONTMATTER = `---
titles:
  - 标题一
  - 标题二
  - 标题三
tags: ["科技", "AI"]
description: 一段测试描述
---

正文文案……
`;

/** Full valid fixture: composed video, first card PNG, 5 metadata files. */
function makeFixture(): { dir: VideoDir; meta: MetadataFiles } {
  const dir = makeVideoDir();
  writeFileSync(join(dir.paths.video, "video.mp4"), "fake-mp4-bytes");
  writeFileSync(join(dir.paths.cards, "card-00-0.png"), "fake-png-bytes");
  writeFileSync(join(dir.paths.cards, "card-01-0.png"), "fake-png-bytes-2");

  const metaDir = join(dir.root, "meta");
  mkdirSync(metaDir);
  const meta: MetadataFiles = {
    shipinhao: join(metaDir, "metadata-shipinhao.md"),
    douyin: join(metaDir, "metadata-douyin.md"),
    aigcDeclaration: join(metaDir, "aigc-declaration.md"),
    materialsManifest: join(metaDir, "materials-manifest.md"),
    publishAdvice: join(metaDir, "publish-advice.md"),
  };
  writeFileSync(meta.shipinhao, FRONTMATTER);
  writeFileSync(meta.douyin, FRONTMATTER);
  writeFileSync(meta.aigcDeclaration, "# AIGC 声明\n本视频为 AI 生成内容。\n");
  writeFileSync(
    meta.materialsManifest,
    "# 素材清单\n\n- 文章素材: notes/article.md\n- 背景音乐: 无\n",
  );
  writeFileSync(meta.publishAdvice, "# 发布建议\n工作日晚 8 点。\n");
  return { dir, meta };
}

/** Fake prober: 1080x1920 12.3s for the video; per-path override for covers. */
function fakeProbe(
  overrides: Record<string, Partial<MediaInfo>> = {},
): (path: string) => Promise<MediaInfo> {
  return async (path) => ({
    width: 1080,
    height: 1920,
    durationSec: 12.3,
    videoStreams: 1,
    audioStreams: 1,
    ...overrides[path],
  });
}

/** Fake converter: records argv, writes a stub jpg at the output path. */
function fakeConvert() {
  const calls: string[][] = [];
  return {
    calls,
    runFn: async (argv: string[]) => {
      calls.push(argv);
      writeFileSync(argv.at(-1)!, "fake-jpg-bytes");
    },
  };
}

const PROVENANCE = {
  ttsBackend: "edge",
  ttsVoice: "zh-CN-XiaoxiaoNeural",
  cardTemplate: "default",
  ffmpegVersion: "7.1.1",
};

function offlineOptions(extra: Partial<AssembleOptions> = {}): AssembleOptions {
  return {
    probeFn: fakeProbe(),
    runFn: fakeConvert().runFn,
    provenance: PROVENANCE,
    ...extra,
  };
}

// ---- assemble ---------------------------------------------------------------

describe("assemble", () => {
  test("happy path: 9-file package, manifest v1 shape, auto entries, state marked", async () => {
    const { dir, meta } = makeFixture();
    const pkg = await assemble(dir, meta, offlineOptions());

    expect(pkg.path).toBe(dir.paths.pkg);
    // The FR-4.1 eight-piece set + manifest.json, all present.
    for (const name of [
      "video.mp4",
      "cover.jpg",
      "metadata-shipinhao.md",
      "metadata-douyin.md",
      "aigc-declaration.md",
      "materials-manifest.md",
      "publish-advice.md",
      "manifest.json",
      "SUMMARY.md",
    ]) {
      expect(existsSync(join(pkg.path, name))).toBe(true);
    }
    // .tmp assembly dir is gone (BR-U5-4 atomic swap).
    expect(existsSync(`${dir.paths.pkg}.tmp`)).toBe(false);

    // Manifest v1 shape with probe-measured video facts + redundant titles.
    const manifest = JSON.parse(
      readFileSync(pkg.manifestPath, "utf8"),
    ) as ManifestV1;
    expect(manifest.schema_version).toBe("1");
    expect(manifest.video).toEqual({
      path: "video.mp4",
      durationSec: 12.3,
      width: 1080,
      height: 1920,
    });
    expect(manifest.platform_metadata.shipinhao.titles).toEqual([
      "标题一",
      "标题二",
      "标题三",
    ]);
    expect(manifest.platform_metadata.douyin.tags).toEqual(["科技", "AI"]);
    expect(manifest.aigc_declaration.must_declare).toBe(true);

    // materials-manifest auto entries (BR-U5-3): TTS + template + ffmpeg.
    const materials = readFileSync(
      join(pkg.path, "materials-manifest.md"),
      "utf8",
    );
    expect(materials).toContain("TTS: edge（音色: zh-CN-XiaoxiaoNeural）");
    expect(materials).toContain("卡片模板: default");
    expect(materials).toContain("FFmpeg: 7.1.1");
    // entryCount counts every list entry (2 original + 3 auto).
    expect(manifest.materials_manifest.entryCount).toBe(5);
    expect(countManifestEntries(materials)).toBe(5);

    // markStep("package") recorded into state.json.
    const state = JSON.parse(
      readFileSync(join(dir.root, "state.json"), "utf8"),
    );
    expect(state.steps.package.meta.durationSec).toBe(12.3);
  });

  test("pre-flight: missing video + missing file + bad frontmatter in ONE itemized error pointing at skills (BR-U5-12)", async () => {
    const { dir, meta } = makeFixture();
    rmSync(join(dir.paths.video, "video.mp4"));
    rmSync(meta.publishAdvice);
    writeFileSync(
      meta.shipinhao,
      "---\ntitles:\n  - 只有一条\ntags: [x]\ndescription: d\n---\n",
    );

    expect.assertions(5);
    try {
      await assemble(dir, meta, offlineOptions());
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("compose 步未完成");
      expect(message).toContain("publish-advice.md");
      expect(message).toContain("恰好 3 条");
      expect(message).toContain("skills 文案"); // failure points at skills
    }
  });

  test("specified cover >= 720px wide is converted to jpg (BR-U5-5)", async () => {
    const { dir, meta } = makeFixture();
    const coverPng = join(dir.root, "custom-cover.png");
    writeFileSync(coverPng, "custom-cover-bytes");
    const converter = fakeConvert();

    await assemble(
      dir,
      { ...meta, cover: coverPng },
      offlineOptions({
        probeFn: fakeProbe({ [coverPng]: { width: 800, height: 800 } }),
        runFn: converter.runFn,
      }),
    );

    expect(converter.calls).toHaveLength(1);
    expect(converter.calls[0]).toContain(coverPng);
    expect(existsSync(join(dir.paths.pkg, "cover.jpg"))).toBe(true);
  });

  test("specified cover narrower than 720px → ValidationError (BR-U5-5)", async () => {
    const { dir, meta } = makeFixture();
    const coverPng = join(dir.root, "small-cover.png");
    writeFileSync(coverPng, "small-cover-bytes");

    await expect(
      assemble(
        dir,
        { ...meta, cover: coverPng },
        offlineOptions({
          probeFn: fakeProbe({ [coverPng]: { width: 600, height: 600 } }),
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("no cover specified → first card PNG fallback (Q1=A)", async () => {
    const { dir, meta } = makeFixture();
    const converter = fakeConvert();

    await assemble(dir, meta, offlineOptions({ runFn: converter.runFn }));

    // Lexicographically first card wins (card-00-0.png before card-01-0.png).
    expect(converter.calls[0]).toContain(
      join(dir.paths.cards, "card-00-0.png"),
    );
  });

  test("mid-assembly failure leaves no half-written package (BR-U5-4)", async () => {
    const { dir, meta } = makeFixture();

    await expect(
      assemble(
        dir,
        meta,
        offlineOptions({
          runFn: async () => {
            throw new ValidationError("conversion blew up");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // tmp dir cleaned up; pre-existing package dir untouched (no manifest).
    expect(existsSync(`${dir.paths.pkg}.tmp`)).toBe(false);
    expect(existsSync(join(dir.paths.pkg, "manifest.json"))).toBe(false);
  });
});

// ---- validatePackage --------------------------------------------------------

/** Assembles a valid package for the validation tests. */
async function assembleValid() {
  const { dir, meta } = makeFixture();
  const pkg = await assemble(dir, meta, offlineOptions());
  return { dir, meta, pkg };
}

describe("validatePackage", () => {
  test("GOLDEN CASE (FR-4 AC): valid package passes; deleting aigc-declaration.md fails at layer 1 on aigc_declaration.path", async () => {
    const { pkg } = await assembleValid();

    const before = await validatePackage(pkg);
    expect(before).toEqual({ valid: true, violations: [] });

    rmSync(join(pkg.path, "aigc-declaration.md"));

    const after = await validatePackage(pkg);
    expect(after.valid).toBe(false);
    // Layer 1 names the exact field; layer 3 (must_declare===true) still
    // passes independently — exactly one violation.
    expect(after.violations).toEqual([
      {
        field: "aigc_declaration.path",
        problem: expect.stringContaining("不存在或为空"),
      },
    ]);
  });

  test("three layers report independently without short-circuit", async () => {
    const { pkg } = await assembleValid();

    // Layer 1: delete a referenced file.
    rmSync(join(pkg.path, "publish-advice.md"));
    // Layers 2+3: corrupt structure (douyin titles count) + the constant.
    const manifest = JSON.parse(
      readFileSync(pkg.manifestPath, "utf8"),
    ) as ManifestV1;
    manifest.platform_metadata.douyin.titles = ["只有一条"];
    (manifest.aigc_declaration as { must_declare: boolean }).must_declare =
      false;
    writeFileSync(pkg.manifestPath, JSON.stringify(manifest));

    const report = await validatePackage(pkg);
    expect(report.valid).toBe(false);
    const fields = report.violations.map((v) => v.field);
    expect(fields).toContain("publish_advice.path"); // layer 1
    expect(fields).toContain("platform_metadata.douyin.titles"); // layer 2
    expect(fields).toContain("aigc_declaration.must_declare"); // layer 3
  });

  test("manifest ↔ md frontmatter bidirectional consistency (layer 2)", async () => {
    const { pkg } = await assembleValid();
    // Change a title in the packaged md — manifest redundant copy now stale.
    writeFileSync(
      join(pkg.path, "metadata-shipinhao.md"),
      FRONTMATTER.replace("标题一", "被改掉的标题"),
    );

    const report = await validatePackage(pkg);
    expect(report.valid).toBe(false);
    expect(report.violations).toContainEqual({
      field: "platform_metadata.shipinhao.titles",
      problem: expect.stringContaining("不一致"),
    });
  });

  test("missing/unparseable manifest.json → single root-cause violation", async () => {
    const { pkg } = await assembleValid();
    writeFileSync(pkg.manifestPath, "not json {{{");

    const report = await validatePackage(pkg);
    expect(report.valid).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.field).toBe("manifest.json");
  });

  test("assertPackageDeliverable: throws ContractViolationError exit 9 when invalid, returns report when valid (BR-U5-1)", async () => {
    const { pkg } = await assembleValid();

    const report = await assertPackageDeliverable(pkg);
    expect(report.valid).toBe(true);

    rmSync(join(pkg.path, "aigc-declaration.md"));
    expect.assertions(4);
    try {
      await assertPackageDeliverable(pkg);
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolationError);
      expect((error as ContractViolationError).exitCode).toBe(9);
      expect((error as ContractViolationError).violations[0]!.field).toBe(
        "aigc_declaration.path",
      );
    }
  });
});
