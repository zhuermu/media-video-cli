/**
 * @module cli/commands/package
 *
 * `vagent package assemble|validate <slug> [--cover]` — U5 delegation:
 * MetadataFiles resolution from the workdir 文件契约 → assemble →
 * assertPackageDeliverable → 停点 2 提示 (SUMMARY.md).
 *
 * Boundary rules honored here:
 * - MetadataFiles live at <workdir>/input/metadata/ (skills 编排序 step 6
 *   落盘点); missing files → ValidationError listing every missing path
 *   (helpful in one pass, mirroring BR-U5-12 的一次性汇报风格).
 * - BR-U6-4: 停点 2 不阻塞 — SUMMARY.md 路径 + 「核对检查单后人工上传,
 *   然后 register add ...」提示, 然后正常退出.
 * - BR-U6-7 / C13: 全链无自动发布路径 — this command only points at the
 *   checklist; upload is human, registration is a separate command.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { ValidationError } from "@core/errors";
import {
  assemble,
  assertPackageDeliverable,
  PKG_FILES,
  type AssembleOptions,
  type MetadataFiles,
  type PackageDir,
} from "@core/pkg";
import { load, type VideoDir } from "@core/workdir";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `package assemble|validate`. */
export interface PackageArgs {
  slug: string;
  cover?: string;
  videosRoot?: string;
}

/** Injectable seams for offline tests. */
export interface PackageSeams {
  /** Passed through to U5 assemble (probe/run/capture/provenance seams). */
  assembleOptions?: AssembleOptions;
}

/** The five LLM-authored metadata files (skills 编排序 step 6 契约). */
const METADATA_FILES: ReadonlyArray<
  [key: keyof Omit<MetadataFiles, "cover">, fileName: string]
> = [
  ["shipinhao", "metadata-shipinhao.md"],
  ["douyin", "metadata-douyin.md"],
  ["aigcDeclaration", "aigc-declaration.md"],
  ["materialsManifest", "materials-manifest.md"],
  ["publishAdvice", "publish-advice.md"],
];

/**
 * Resolves the MetadataFiles paths under <workdir>/input/metadata/,
 * failing with EVERY missing path in one error (helpful single pass).
 *
 * @throws ValidationError listing all missing metadata files.
 */
export function resolveMetadataFiles(
  dir: VideoDir,
  cover?: string,
): MetadataFiles {
  const metaDir = join(dir.paths.input, "metadata");
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, fileName] of METADATA_FILES) {
    const path = join(metaDir, fileName);
    resolved[key] = path;
    if (!existsSync(path)) missing.push(path);
  }
  if (missing.length > 0) {
    throw new ValidationError(
      `metadata 文件缺失（${missing.length}/5；应由 skills/LLM 生成后放入 ${metaDir}/）:\n` +
        missing.map((path) => `- ${path}`).join("\n"),
    );
  }
  const meta = resolved as unknown as MetadataFiles;
  if (cover !== undefined) meta.cover = cover;
  return meta;
}

/** Stop-point 2 notice (Workflow 2 / BR-U6-4): SUMMARY.md + register 提示. */
function stopPoint2Text(pkg: PackageDir): string {
  return (
    `⏸ 【停点 2 · 人工上传】请核对检查单: ${pkg.summaryPath}\n` +
    "人工上传各平台后登记:\n" +
    "  vagent register add --platform <shipinhao|douyin> --url <链接> " +
    `--title <标题> --published-at <ISO时间> --package ${pkg.path}\n`
  );
}

/**
 * Runs `package assemble`: metadata 契约解析 → U5 assemble → 契约校验门 →
 * 停点 2.
 *
 * @throws ValidationError missing metadata files / pre-flight violations.
 * @throws ContractViolationError when the assembled package fails FR-4.2.
 * @throws IoError / FfmpegError from U5 assembly.
 */
export async function runPackageAssemble(
  args: PackageArgs,
  seams: PackageSeams = {},
): Promise<CommandResult> {
  const dir = await load(args.slug, { videosRoot: args.videosRoot });
  const meta = resolveMetadataFiles(dir, args.cover);

  const pkg = await assemble(dir, meta, seams.assembleOptions);
  await assertPackageDeliverable(pkg);

  return {
    step: "package",
    data: {
      packagePath: pkg.path,
      manifestPath: pkg.manifestPath,
      summaryPath: pkg.summaryPath,
    },
    text: `✅ 发布包组装并通过契约校验: ${pkg.path}\n\n${stopPoint2Text(pkg)}`,
  };
}

/**
 * Runs `package validate`: existing package dir → FR-4.2 machine gate →
 * 停点 2.
 *
 * @throws ContractViolationError itemized violations (exit 9, BR-U5-1).
 */
export async function runPackageValidate(
  args: PackageArgs,
): Promise<CommandResult> {
  const dir = await load(args.slug, { videosRoot: args.videosRoot });
  const pkg: PackageDir = {
    path: dir.paths.pkg,
    manifestPath: join(dir.paths.pkg, PKG_FILES.manifest),
    summaryPath: join(dir.paths.pkg, PKG_FILES.summary),
  };
  const report = await assertPackageDeliverable(pkg);

  return {
    step: "package",
    data: {
      valid: report.valid,
      packagePath: pkg.path,
      summaryPath: pkg.summaryPath,
    },
    text: `✅ 发布包契约校验通过: ${pkg.path}\n\n${stopPoint2Text(pkg)}`,
  };
}
