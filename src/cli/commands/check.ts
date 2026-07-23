/**
 * @module cli/commands/check
 *
 * `vagent check` — 门禁组合 (Workflow 4, Q4=A): prettier --check → bun
 * test，串行执行全部（前项失败不中断后项）→ 失败汇总表 → 任一失败非零退出.
 *
 * Boundary rules honored here:
 * - BR-U6-9: serial, NO short-circuit, aggregated failure table, any
 *   failure → exit code 1 (via CommandResult.exitCode; main 是唯一 exit 点).
 * - Child process stdio is inherited: the gate's own output streams live
 *   (进度 → 终端), the aggregate table is this command's stdout 结果.
 */

import type { CommandResult } from "../envelope";

/** One gate step's outcome. */
export interface CheckStepResult {
  name: string;
  argv: string[];
  exitCode: number;
  ok: boolean;
}

/** Aggregated gate outcome (BR-U6-9 汇总). */
export interface CheckSummary {
  ok: boolean;
  results: CheckStepResult[];
}

/** Spawn seam: argv → exit code (tests inject a fake; default is real). */
export type SpawnFn = (argv: string[]) => { exitCode: number };

/** The gate pipeline (Q4=A; lint 由 prettier+tsc 阶段方案覆盖, 见 plan). */
export const CHECK_STEPS: ReadonlyArray<{ name: string; argv: string[] }> = [
  { name: "format", argv: ["bunx", "prettier", "--check", "."] },
  { name: "test", argv: ["bun", "test"] },
];

/** Real spawn: inherited stdio; unspawnable command → exit 127 (记录不吞). */
export function defaultSpawn(argv: string[]): { exitCode: number } {
  try {
    const proc = Bun.spawnSync({
      cmd: argv,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    return { exitCode: proc.exitCode ?? 1 };
  } catch {
    return { exitCode: 127 };
  }
}

/**
 * Runs every gate step serially without short-circuiting (BR-U6-9) and
 * returns the aggregate.
 */
export function runCheck(spawnFn: SpawnFn = defaultSpawn): CheckSummary {
  const results: CheckStepResult[] = [];
  for (const step of CHECK_STEPS) {
    const { exitCode } = spawnFn(step.argv);
    results.push({ ...step, exitCode, ok: exitCode === 0 });
  }
  return { ok: results.every((result) => result.ok), results };
}

/** Renders the aggregate table (失败汇总表, Workflow 4). */
export function renderCheckTable(summary: CheckSummary): string {
  const lines: string[] = ["| 检查 | 命令 | 结果 |", "|------|------|------|"];
  for (const result of summary.results) {
    const outcome = result.ok ? "✅ 通过" : `✗ 失败（exit ${result.exitCode}）`;
    lines.push(`| ${result.name} | ${result.argv.join(" ")} | ${outcome} |`);
  }
  const failed = summary.results.filter((result) => !result.ok).length;
  lines.push(
    "",
    summary.ok
      ? `✅ 门禁通过（${summary.results.length} 项检查全部通过）`
      : `✗ 门禁未通过: ${failed}/${summary.results.length} 项失败（BR-U6-9: 串行执行全部后汇总）`,
    "",
  );
  return lines.join("\n");
}

/** Runs `check` and maps the aggregate to a CommandResult (exit 1 on fail). */
export function runCheckCommand(spawnFn?: SpawnFn): CommandResult {
  const summary = runCheck(spawnFn);
  return {
    data: summary,
    text: renderCheckTable(summary),
    exitCode: summary.ok ? 0 : 1,
  };
}
