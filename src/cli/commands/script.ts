/**
 * @module cli/commands/script
 *
 * `vagent script validate <slug>` — U3 delegation: load → validateScript →
 * guardDomain → estimateDuration → renderPreview → script/script.md 落盘 →
 * markStep("script") → 停点 1 提示.
 *
 * Boundary rules honored here:
 * - BR-U3-2: a domain-guard hit throws BEFORE anything is written — zero
 *   artifacts on rejection (DomainGuardError propagates, exit 4).
 * - BR-U6-4: 停点不阻塞 — the stop-point notice goes to stdout and the
 *   process exits 0; waiting happens outside the process (services.md).
 * - Workflow 2: notice = 审核物路径 (script/script.md) + 「确认后运行
 *   tts run <slug>」提示.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { IoError } from "@core/errors";
import {
  estimateDuration,
  guardDomain,
  renderPreview,
  validateScript,
} from "@core/script";
import { load, markStep } from "@core/workdir";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `script validate`. */
export interface ScriptValidateArgs {
  slug: string;
  videosRoot?: string;
}

/** Injectable seams for offline tests. */
export interface ScriptValidateSeams {
  /** Domain-guard keyword table path. Default: the shipped asset. */
  guardTablePath?: string;
  /** Warning sink (topic truncation etc.). Default: stderr. */
  warn?: (message: string) => void;
}

/**
 * Runs `script validate` (workflows 1-4 of U3, assembled).
 *
 * @throws NotFoundError workdir or script.json missing.
 * @throws ValidationError schema violations (itemized, BR-U3-1).
 * @throws DomainGuardError restricted-domain hit (C7, zero artifacts).
 * @throws IoError guard-table load or script.md/state write failure.
 */
export async function runScriptValidate(
  args: ScriptValidateArgs,
  seams: ScriptValidateSeams = {},
): Promise<CommandResult> {
  const dir = await load(args.slug, { videosRoot: args.videosRoot });

  const scriptPath = join(dir.paths.script, "script.json");
  const script = await validateScript(scriptPath, { warn: seams.warn });

  // Hard line (C7): throws before any artifact is written (BR-U3-2).
  guardDomain(script, { tablePath: seams.guardTablePath });

  const estimate = estimateDuration(script);
  const preview = renderPreview(script, estimate);

  const previewPath = join(dir.paths.script, "script.md");
  try {
    await writeFile(previewPath, preview, "utf8");
  } catch (cause) {
    throw new IoError(`script.md 写入失败: ${previewPath}`, { cause });
  }

  await markStep(dir, "script", {
    segments: script.segments.length,
    estimatedSec: estimate.total,
    withinTarget: estimate.withinTarget,
  });

  const window = estimate.withinTarget
    ? "落在 60-180s 目标区间"
    : "不在 60-180s 目标区间（仅警告，不阻断）";

  return {
    step: "script",
    data: { previewPath, estimate, segments: script.segments.length },
    text:
      `✅ 脚本校验通过（${script.segments.length} 段，估算 ` +
      `${estimate.total.toFixed(1)}s，${window}）\n\n` +
      `⏸ 【停点 1 · 人工审核】请审阅: ${previewPath}\n` +
      `确认后运行: vagent tts run ${args.slug}\n`,
  };
}
