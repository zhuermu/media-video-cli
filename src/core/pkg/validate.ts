/**
 * @module @core/pkg (validate)
 *
 * Publish-package contract validation (Workflow 2, FR-4.2 machine gate).
 *
 * Three INDEPENDENT assertion layers — every layer always runs and emits
 * its own violation entries; nothing short-circuits or swallows another
 * layer's findings (domain-entities Manifest v1 rules):
 *
 * 1. File existence: every manifest `path` reference exists inside the
 *    package dir with size > 0 (deleting aigc-declaration.md fails HERE —
 *    the FR-4 AC golden case).
 * 2. Structure: manifest fields complete and correctly typed; titles
 *    exactly 3 / tags >= 1 / description non-empty; manifest redundant
 *    values consistent with the md frontmatter in BOTH directions.
 * 3. Constant: `aigc_declaration.must_declare === true` (C11 红线机器化,
 *    independent of layer 1 — either failing alone makes the package
 *    undeliverable).
 *
 * BR-U5-1: an invalid package is undeliverable — the CLI-facing
 * {@link assertPackageDeliverable} throws ContractViolationError (exit 9).
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ContractViolationError, type ContractViolation } from "@core/errors";

import { extractMetadataFields, parseFrontmatter } from "./frontmatter";
import type { ContractReport, PackageDir } from "./types";

/** Exists with size > 0. */
function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Safe navigation over the untrusted parsed manifest. */
function get(root: unknown, keys: string[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isNonEmptyString(v));
}

/** The seven path-bearing manifest fields (layer-1 checklist). */
const PATH_FIELDS: Array<[field: string, keys: string[]]> = [
  ["video.path", ["video", "path"]],
  ["cover.path", ["cover", "path"]],
  [
    "platform_metadata.shipinhao.path",
    ["platform_metadata", "shipinhao", "path"],
  ],
  ["platform_metadata.douyin.path", ["platform_metadata", "douyin", "path"]],
  ["aigc_declaration.path", ["aigc_declaration", "path"]],
  ["materials_manifest.path", ["materials_manifest", "path"]],
  ["publish_advice.path", ["publish_advice", "path"]],
];

/**
 * Validates the package against the Manifest v1 contract. Never throws for
 * contract violations — returns the itemized {@link ContractReport}; the
 * CLI gate is {@link assertPackageDeliverable}.
 */
export async function validatePackage(
  pkg: PackageDir,
): Promise<ContractReport> {
  const violations: ContractViolation[] = [];

  // Precondition: manifest.json exists and is valid JSON. Without a
  // parseable manifest none of the layers can run — the report carries the
  // single root-cause violation.
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(pkg.manifestPath, "utf8"));
  } catch {
    return {
      valid: false,
      violations: [
        {
          field: "manifest.json",
          problem: `不存在或不是合法 JSON: ${pkg.manifestPath}`,
        },
      ],
    };
  }

  // ---- Layer 1: file existence (独立断言, no short-circuit) ----
  for (const [field, keys] of PATH_FIELDS) {
    const path = get(manifest, keys);
    if (!isNonEmptyString(path)) continue; // structural absence → layer 2
    if (!isNonEmptyFile(join(pkg.path, path))) {
      violations.push({
        field,
        problem: `引用文件不存在或为空: ${path}`,
      });
    }
  }

  // ---- Layer 2: structure (fields, types, frontmatter consistency) ----
  await assertStructure(manifest, pkg, violations);

  // ---- Layer 3: constant (must_declare === true, C11) ----
  const mustDeclare = get(manifest, ["aigc_declaration", "must_declare"]);
  if (mustDeclare !== true) {
    violations.push({
      field: "aigc_declaration.must_declare",
      problem: `必须恒为 true（实际: ${JSON.stringify(mustDeclare)}）`,
    });
  }

  return { valid: violations.length === 0, violations };
}

/** Layer-2 structural assertions — every problem is its own violation. */
async function assertStructure(
  manifest: unknown,
  pkg: PackageDir,
  violations: ContractViolation[],
): Promise<void> {
  const push = (field: string, problem: string): void => {
    violations.push({ field, problem });
  };

  const schemaVersion = get(manifest, ["schema_version"]);
  if (schemaVersion !== "1") {
    push(
      "schema_version",
      `必须为 "1"（实际: ${JSON.stringify(schemaVersion)}）`,
    );
  }
  if (!isNonEmptyString(get(manifest, ["generated_at"]))) {
    push("generated_at", "必须为非空 ISO 8601 字符串");
  }

  // video: path + probe-measured numbers.
  if (!isNonEmptyString(get(manifest, ["video", "path"]))) {
    push("video.path", "必须为非空字符串");
  }
  for (const key of ["durationSec", "width", "height"] as const) {
    const value = get(manifest, ["video", key]);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      push(`video.${key}`, `必须为有限数字（实际: ${JSON.stringify(value)}）`);
    }
  }

  if (!isNonEmptyString(get(manifest, ["cover", "path"]))) {
    push("cover.path", "必须为非空字符串");
  }

  // platform_metadata: per-platform structure + frontmatter consistency.
  for (const platform of ["shipinhao", "douyin"] as const) {
    const base = `platform_metadata.${platform}`;
    const path = get(manifest, ["platform_metadata", platform, "path"]);
    if (!isNonEmptyString(path)) {
      push(`${base}.path`, "必须为非空字符串");
    }

    const titles = get(manifest, ["platform_metadata", platform, "titles"]);
    if (!isStringArray(titles)) {
      push(`${base}.titles`, "必须为非空字符串数组");
    } else if (titles.length !== 3) {
      push(
        `${base}.titles`,
        `需恰好 3 条候选标题（实际 ${titles.length} 条，BR-U5-12）`,
      );
    }

    const tags = get(manifest, ["platform_metadata", platform, "tags"]);
    if (!isStringArray(tags) || tags.length < 1) {
      push(`${base}.tags`, "必须为至少 1 条的非空字符串数组");
    }

    const description = get(manifest, [
      "platform_metadata",
      platform,
      "description",
    ]);
    if (!isNonEmptyString(description)) {
      push(`${base}.description`, "必须为非空字符串");
    }

    // Bidirectional consistency: manifest redundant values ⇔ md frontmatter.
    // Only checkable when the md file is present (its absence is a layer-1
    // finding — layers stay independent, neither masks the other).
    if (isNonEmptyString(path) && isNonEmptyFile(join(pkg.path, path))) {
      const { fields, problems } = extractMetadataFields(
        parseFrontmatter(await readFile(join(pkg.path, path), "utf8")),
      );
      if (problems.length > 0) {
        push(
          `${base}.frontmatter`,
          `md frontmatter 不合规: ${problems.join("；")}`,
        );
      } else if (fields !== undefined) {
        if (
          isStringArray(titles) &&
          JSON.stringify(titles) !== JSON.stringify(fields.titles)
        ) {
          push(`${base}.titles`, "manifest 冗余值与 md frontmatter 不一致");
        }
        if (
          isStringArray(tags) &&
          JSON.stringify(tags) !== JSON.stringify(fields.tags)
        ) {
          push(`${base}.tags`, "manifest 冗余值与 md frontmatter 不一致");
        }
        if (
          isNonEmptyString(description) &&
          description !== fields.description
        ) {
          push(
            `${base}.description`,
            "manifest 冗余值与 md frontmatter 不一致",
          );
        }
      }
    }
  }

  if (!isNonEmptyString(get(manifest, ["aigc_declaration", "path"]))) {
    push("aigc_declaration.path", "必须为非空字符串");
  }

  if (!isNonEmptyString(get(manifest, ["materials_manifest", "path"]))) {
    push("materials_manifest.path", "必须为非空字符串");
  }
  const entryCount = get(manifest, ["materials_manifest", "entryCount"]);
  if (
    typeof entryCount !== "number" ||
    !Number.isInteger(entryCount) ||
    entryCount < 0
  ) {
    push(
      "materials_manifest.entryCount",
      `必须为非负整数（实际: ${JSON.stringify(entryCount)}）`,
    );
  }

  if (!isNonEmptyString(get(manifest, ["publish_advice", "path"]))) {
    push("publish_advice.path", "必须为非空字符串");
  }
}

/**
 * CLI-facing gate (BR-U5-1): validates and THROWS when the package is not
 * deliverable, so the U6 command maps straight to exit code 9.
 *
 * @throws ContractViolationError with the itemized violations list.
 */
export async function assertPackageDeliverable(
  pkg: PackageDir,
): Promise<ContractReport> {
  const report = await validatePackage(pkg);
  if (!report.valid) {
    throw new ContractViolationError(
      `发布包契约校验失败（${report.violations.length} 处违反），包不可交付:\n` +
        report.violations.map((v) => `- ${v.field}: ${v.problem}`).join("\n"),
      { violations: report.violations },
    );
  }
  return report;
}
