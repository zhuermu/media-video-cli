/**
 * @module @core/pkg (assemble)
 *
 * Publish-package assembly (Workflow 1, FR-4.1): pre-flight → probe →
 * cover → atomic .tmp assembly → materials-manifest auto entries →
 * manifest.json + SUMMARY.md → markStep("package").
 *
 * Boundary rules honored here:
 * - BR-U5-12 (pre-flight): the five metadata files AND their frontmatter
 *   (titles exactly 3 / tags >= 1 / description non-empty) are checked in
 *   ONE itemized ValidationError BEFORE anything is written; frontmatter
 *   failures point at the skills copy generation, not at this module.
 * - BR-U5-4 (ADR-004): the package is built inside `package.tmp` and
 *   atomically renamed — a failed assembly leaves no half-written package.
 * - BR-U5-5 (Q1=A): a user-specified cover must be >= 720px wide and is
 *   converted to jpg; the default cover is the first card PNG.
 * - BR-U5-3 (C12): materials-manifest gains pkg-side auto entries (TTS
 *   backend + voice, card template name, FFmpeg version).
 *
 * Injectable seams (offline tests): probeFn, runFn (cover conversion),
 * captureFn (ffmpeg -version), provenance overrides.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { MediaInfo } from "@adapters/ffmpeg";
import { probe, runCaptureStdout, runFfmpeg } from "@adapters/ffmpeg";
import { DEFAULT_TTS_VOICES } from "@core/config";
import { IoError, ValidationError } from "@core/errors";
import { markStep, type VideoDir } from "@core/workdir";

import {
  extractMetadataFields,
  parseFrontmatter,
  type MetadataFields,
} from "./frontmatter";
import { buildUploadChecklist, renderSummary } from "./summary";
import {
  COVER_MIN_WIDTH,
  PKG_FILES,
  type ManifestV1,
  type MetadataFiles,
  type PackageDir,
} from "./types";

/** Pkg-side provenance recorded into materials-manifest (BR-U5-3). */
export interface MaterialsProvenance {
  ttsBackend: string;
  ttsVoice: string;
  cardTemplate: string;
  ffmpegVersion: string;
}

/** Injectable seams for {@link assemble} (offline unit tests). */
export interface AssembleOptions {
  /** Media prober. Default: @adapters/ffmpeg probe. */
  probeFn?: (path: string) => Promise<MediaInfo>;
  /** ffmpeg executor for the cover jpg conversion. Default: runFfmpeg. */
  runFn?: (argv: string[]) => Promise<void>;
  /** stdout-capturing executor for `ffmpeg -version`. Default: runCaptureStdout. */
  captureFn?: (argv: string[]) => Promise<string>;
  /** ffmpeg executable. Default: $FFMPEG_PATH or "ffmpeg". */
  ffmpegPath?: string;
  /** Provenance overrides; unset fields resolve from env/defaults. */
  provenance?: Partial<MaterialsProvenance>;
}

/**
 * Pure function: cover image → single-frame jpg conversion argv.
 * `-q:v 2` keeps near-source jpg quality; `-frames:v 1` guards against
 * animated inputs.
 */
export function buildCoverConvertArgs(
  input: string,
  output: string,
  ffmpegPath = "ffmpeg",
): string[] {
  if (input.length === 0) throw new ValidationError("cover 输入路径为空");
  if (output.length === 0) throw new ValidationError("cover 输出路径为空");
  return [
    ffmpegPath,
    "-y",
    "-v",
    "error",
    "-i",
    input,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ];
}

/** Exists with size > 0 (non-empty file check used across pre-flight). */
function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Counts markdown list entries (`- ` / `* ` lines) — manifest entryCount. */
export function countManifestEntries(content: string): number {
  return content.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line))
    .length;
}

/** Per-platform pre-flight parse result kept for the manifest fill. */
interface ParsedPlatform {
  fields?: MetadataFields;
}

/**
 * Assembles the publish package (Workflow 1). See module header for the
 * step-by-step contract.
 *
 * @throws ValidationError pre-flight violations (itemized, one error),
 *         missing/undersized cover, or no card PNG to fall back to.
 * @throws IoError on assembly file operations failure.
 */
export async function assemble(
  dir: VideoDir,
  meta: MetadataFiles,
  options: AssembleOptions = {},
): Promise<PackageDir> {
  const probeFn = options.probeFn ?? probe;
  const runFn = options.runFn ?? runFfmpeg;
  const captureFn = options.captureFn ?? runCaptureStdout;
  const ffmpegPath =
    options.ffmpegPath ?? process.env["FFMPEG_PATH"] ?? "ffmpeg";

  // ---- Step 1: pre-flight (one itemized ValidationError, BR-U5-12) ----
  const violations: string[] = [];
  const videoPath = join(dir.paths.video, "video.mp4");
  if (!isNonEmptyFile(videoPath)) {
    violations.push(
      `compose 步未完成: ${videoPath} 不存在或为空（先运行 compose）`,
    );
  }

  const requiredFiles: Array<[label: string, path: string]> = [
    ["metadata-shipinhao.md", meta.shipinhao],
    ["metadata-douyin.md", meta.douyin],
    ["aigc-declaration.md", meta.aigcDeclaration],
    ["materials-manifest.md", meta.materialsManifest],
    ["publish-advice.md", meta.publishAdvice],
  ];
  for (const [label, path] of requiredFiles) {
    if (!isNonEmptyFile(path)) {
      violations.push(`${label}: 文件不存在或为空（${path}）`);
    }
  }

  // Frontmatter pre-check (failures point at the skills copy, BR-U5-12).
  const platforms: Record<"shipinhao" | "douyin", ParsedPlatform> = {
    shipinhao: {},
    douyin: {},
  };
  for (const key of ["shipinhao", "douyin"] as const) {
    const path = meta[key];
    if (!isNonEmptyFile(path)) continue; // already reported above
    const { fields, problems } = extractMetadataFields(
      parseFrontmatter(await readFile(path, "utf8")),
    );
    for (const problem of problems) {
      violations.push(
        `metadata-${key}.md frontmatter ${problem}（请修正 skills 文案生成物后重试）`,
      );
    }
    platforms[key].fields = fields;
  }

  if (violations.length > 0) {
    throw new ValidationError(
      `发布包组装前置检查失败（${violations.length} 处问题，请一并修正后重跑）:\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
  }

  // ---- Step 2: probe the composed video (manifest.video facts) ----
  const videoInfo = await probeFn(videoPath);

  // ---- Step 3: cover source resolution (BR-U5-5, Q1=A) ----
  let coverSource: string;
  if (meta.cover !== undefined) {
    if (!isNonEmptyFile(meta.cover)) {
      throw new ValidationError(`指定封面不存在或为空: ${meta.cover}`);
    }
    const coverInfo = await probeFn(meta.cover);
    if (coverInfo.width < COVER_MIN_WIDTH) {
      throw new ValidationError(
        `指定封面宽度 ${coverInfo.width}px 低于下限 ${COVER_MIN_WIDTH}px（BR-U5-5）`,
      );
    }
    coverSource = meta.cover;
  } else {
    coverSource = firstCardPng(dir);
  }

  // ---- Provenance for materials-manifest auto entries (BR-U5-3) ----
  const provenance = await resolveProvenance(
    options.provenance ?? {},
    captureFn,
    ffmpegPath,
  );

  // ---- Steps 4-6: build inside package.tmp, then atomic swap (BR-U5-4) ----
  const pkgPath = dir.paths.pkg;
  const tmpPath = `${pkgPath}.tmp`;
  try {
    await rm(tmpPath, { recursive: true, force: true }); // stale leftovers
    await mkdir(tmpPath, { recursive: true });

    await copyFile(videoPath, join(tmpPath, PKG_FILES.video));
    await copyFile(meta.shipinhao, join(tmpPath, PKG_FILES.shipinhao));
    await copyFile(meta.douyin, join(tmpPath, PKG_FILES.douyin));
    await copyFile(
      meta.aigcDeclaration,
      join(tmpPath, PKG_FILES.aigcDeclaration),
    );
    await copyFile(meta.publishAdvice, join(tmpPath, PKG_FILES.publishAdvice));

    // Cover conversion into the tmp dir (executor injectable).
    await runFn(
      buildCoverConvertArgs(
        coverSource,
        join(tmpPath, PKG_FILES.cover),
        ffmpegPath,
      ),
    );

    // materials-manifest + pkg auto entries (BR-U5-3 / C12).
    const materialsContent =
      `${(await readFile(meta.materialsManifest, "utf8")).trimEnd()}\n\n` +
      `## pkg 组装自动条目（C12 素材可追溯）\n\n` +
      `- TTS: ${provenance.ttsBackend}（音色: ${provenance.ttsVoice}）\n` +
      `- 卡片模板: ${provenance.cardTemplate}\n` +
      `- FFmpeg: ${provenance.ffmpegVersion}\n`;
    await writeFile(
      join(tmpPath, PKG_FILES.materialsManifest),
      materialsContent,
      "utf8",
    );

    // manifest.json (v1) — platform metadata redundantly from frontmatter.
    const manifest: ManifestV1 = {
      schema_version: "1",
      generated_at: new Date().toISOString(),
      video: {
        path: PKG_FILES.video,
        durationSec: videoInfo.durationSec,
        width: videoInfo.width,
        height: videoInfo.height,
      },
      cover: { path: PKG_FILES.cover },
      platform_metadata: {
        shipinhao: {
          path: PKG_FILES.shipinhao,
          ...platforms.shipinhao.fields!,
        },
        douyin: { path: PKG_FILES.douyin, ...platforms.douyin.fields! },
      },
      aigc_declaration: {
        path: PKG_FILES.aigcDeclaration,
        must_declare: true,
      },
      materials_manifest: {
        path: PKG_FILES.materialsManifest,
        entryCount: countManifestEntries(materialsContent),
      },
      publish_advice: { path: PKG_FILES.publishAdvice },
    };
    await writeFile(
      join(tmpPath, PKG_FILES.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    // SUMMARY.md (UploadChecklist, Q2=A / BR-U5-6).
    await writeFile(
      join(tmpPath, PKG_FILES.summary),
      renderSummary(buildUploadChecklist(pkgPath), manifest),
      "utf8",
    );

    // Atomic swap: remove the (empty or stale) target, rename tmp in.
    await rm(pkgPath, { recursive: true, force: true });
    await rename(tmpPath, pkgPath);
  } catch (cause) {
    // No half-written package may survive (BR-U5-4).
    await rm(tmpPath, { recursive: true, force: true });
    if (cause instanceof ValidationError) throw cause;
    throw cause instanceof IoError
      ? cause
      : new IoError(`发布包组装失败: ${pkgPath}`, { cause });
  }

  // ---- Step 7: record completion ----
  await markStep(dir, "package", {
    durationSec: videoInfo.durationSec,
    width: videoInfo.width,
    height: videoInfo.height,
  });

  return {
    path: pkgPath,
    manifestPath: join(pkgPath, PKG_FILES.manifest),
    summaryPath: join(pkgPath, PKG_FILES.summary),
  };
}

/**
 * Default cover: the lexicographically first card PNG (首卡片, Q1=A). Sorted
 * pick keeps the choice deterministic across card naming schemes
 * (card-00-0.png / card-01.png).
 */
function firstCardPng(dir: VideoDir): string {
  const cards = existsSync(dir.paths.cards)
    ? readdirSync(dir.paths.cards)
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort()
    : [];
  if (cards.length === 0) {
    throw new ValidationError(
      `无可用封面: 未指定 cover 且 ${dir.paths.cards} 下没有卡片 PNG（先运行 compose，或用 --cover 指定封面）`,
    );
  }
  return join(dir.paths.cards, cards[0]!);
}

/** Fills provenance gaps from env/defaults; captures ffmpeg -version once. */
async function resolveProvenance(
  overrides: Partial<MaterialsProvenance>,
  captureFn: (argv: string[]) => Promise<string>,
  ffmpegPath: string,
): Promise<MaterialsProvenance> {
  const ttsBackend =
    overrides.ttsBackend ?? process.env["TTS_BACKEND"] ?? "edge";
  const defaultVoice =
    ttsBackend === "edge" || ttsBackend === "say"
      ? DEFAULT_TTS_VOICES[ttsBackend]
      : "未知";
  const ttsVoice =
    overrides.ttsVoice ?? process.env["TTS_VOICE"] ?? defaultVoice;
  const cardTemplate =
    overrides.cardTemplate ?? process.env["CARD_TEMPLATE"] ?? "default";

  let ffmpegVersion = overrides.ffmpegVersion;
  if (ffmpegVersion === undefined) {
    const stdout = await captureFn([ffmpegPath, "-version"]);
    const firstLine = stdout.split(/\r?\n/)[0] ?? "";
    ffmpegVersion = firstLine.match(/ffmpeg version (\S+)/)?.[1] ?? firstLine;
  }

  return { ttsBackend, ttsVoice, cardTemplate, ffmpegVersion };
}
