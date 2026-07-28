/**
 * @module cli/main
 *
 * CLI entry (Workflow 1): parse → dispatch → 单一 catch → stderr 可读诊断
 * (redact 过滤) → 可选 --json 信封 (stdout) → process.exit(map).
 *
 * Boundary rules honored here:
 * - BR-U6-1: THIS is the only process.exit call site in the whole project;
 *   core modules never exit (不变式 2: 错误有且仅有一次出口转换).
 * - BR-U6-2: stdout=结果 / stderr=进度诊断; `--json` 时 stdout 只输出
 *   JsonEnvelope. Both streams pass through redact() (BR-U1-7 零凭证泄漏).
 * - Workflow 1: 未知命令 → help + exit 2; 未捕获异常兜底 exit 1.
 */

import { redact } from "@core/config";
import { ValidationError } from "@core/errors";

import { err, ok, type CommandResult, type JsonEnvelope } from "./envelope";
import { runDryRun } from "./dry-run";
import { mapExitCode } from "./exit";
import { helpText, parseCli, type ParsedCommand } from "./parse";

import { runCheckCommand } from "./commands/check";
import { runComposeRun } from "./commands/compose";
import { runInit } from "./commands/init";
import { runMetricsAdd } from "./commands/metrics";
import { runPackageAssemble, runPackageValidate } from "./commands/package";
import { runRegisterAdd } from "./commands/register";
import { runReportBaseline, runReportWeekly } from "./commands/report";
import { runPersonaShow } from "./commands/persona";
import { runSchema } from "./commands/schema";
import { runScriptValidate } from "./commands/script";
import { runTtsRun } from "./commands/tts";
import { runWhiteboardRender } from "./commands/whiteboard";

/** Narrows a parsed flag value to string | undefined. */
function str(
  values: ParsedCommand["values"],
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/** Route → command function dispatch (CommandSpec 委托面). */
async function dispatch(cmd: ParsedCommand): Promise<CommandResult> {
  // 试跑档在真实命令**之前**分流：这里返回之后，任何写盘代码都不会被调到。
  // 放在 dispatch 顶部而不是每条命令里，是为了让"零写入"这条保证只有一个位置
  // 需要成立——每条命令各自实现 --dry-run 时，漏一条就是一次意外落盘。
  if (cmd.dryRun) return runDryRun(cmd);
  const slug = cmd.positionals[0] ?? "";
  const v = cmd.values;
  switch (cmd.route) {
    case "init":
      return runInit({
        slug,
        article: str(v, "article"),
        topic: str(v, "topic"),
        videosRoot: cmd.videosRoot,
      });
    case "script validate":
      return runScriptValidate({ slug, videosRoot: cmd.videosRoot });
    case "tts run":
      return runTtsRun({
        slug,
        backend: str(v, "backend"),
        voice: str(v, "voice"),
        fresh: v["fresh"] === true,
        videosRoot: cmd.videosRoot,
      });
    case "compose run":
      return runComposeRun({
        slug,
        template: str(v, "template"),
        videosRoot: cmd.videosRoot,
      });
    case "package assemble":
      return runPackageAssemble({
        slug,
        cover: str(v, "cover"),
        videosRoot: cmd.videosRoot,
      });
    case "package validate":
      return runPackageValidate({ slug, videosRoot: cmd.videosRoot });
    case "register add":
      return runRegisterAdd({
        platform: str(v, "platform")!,
        url: str(v, "url")!,
        title: str(v, "title")!,
        publishedAt: str(v, "published-at")!,
        package: str(v, "package")!,
        ...(cmd.dataRoot === undefined ? {} : { dataRoot: cmd.dataRoot }),
      });
    case "metrics add":
      return runMetricsAdd({
        platform: str(v, "platform")!,
        week: str(v, "week")!,
        followers: str(v, "followers")!,
        views: str(v, "views")!,
        likes: str(v, "likes")!,
        comments: str(v, "comments")!,
        shares: str(v, "shares")!,
        ...(cmd.dataRoot === undefined ? {} : { dataRoot: cmd.dataRoot }),
      });
    case "report weekly":
      return runReportWeekly(
        cmd.dataRoot === undefined ? {} : { dataRoot: cmd.dataRoot },
      );
    case "report baseline":
      return runReportBaseline(
        cmd.dataRoot === undefined ? {} : { dataRoot: cmd.dataRoot },
      );
    case "check":
      return runCheckCommand();
    case "schema":
      return runSchema();
    case "persona show":
      return runPersonaShow();
    case "whiteboard render":
      return runWhiteboardRender({
        article: slug,
        kind: str(v, "kind"),
        out: str(v, "out"),
        frames: str(v, "frames"),
        stills: str(v, "stills"),
        cache: str(v, "cache"),
        tag: str(v, "tag"),
        persona: str(v, "persona"),
        assets: str(v, "assets"),
        arm: str(v, "arm"),
        background: str(v, "background"),
        cursor: str(v, "cursor"),
        onlyStills: v["only-stills"] === true,
        preview: str(v, "preview"),
        fresh: v["fresh"] === true,
        noBurn: v["no-burn"] === true,
        noCover: v["no-cover"] === true,
        coverHold: str(v, "cover-hold"),
      });
    default:
      // Unreachable: parseCli only returns routes from the table.
      throw new ValidationError(`路由未实现: ${cmd.route}`);
  }
}

/** Human diagnostic for stderr: 类型 + 退出码 + message（建议动作在 message 内）. */
function humanDiagnostic(error: unknown): string {
  const type = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return `✗ ${type}（退出码 ${mapExitCode(error)}）: ${message}\n`;
}

/**
 * The CLI process body. NEVER returns — always terminates via the single
 * process.exit call (BR-U6-1).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<never> {
  // Resolved from raw argv so a parse failure still honors --json (BR-U6-2).
  const jsonRequested = argv.includes("--json");
  let exitCode = 0;

  try {
    const parsed = parseCli(argv);
    if (parsed.route === "help") {
      process.stdout.write(helpText());
    } else {
      const result = await dispatch(parsed);
      exitCode = result.exitCode ?? 0;
      if (parsed.json) {
        const envelope: JsonEnvelope = {
          ...ok(result.data, result.step),
          ok: exitCode === 0,
        };
        process.stdout.write(`${redact(JSON.stringify(envelope))}\n`);
      } else {
        process.stdout.write(redact(result.text));
      }
    }
  } catch (error) {
    process.stderr.write(redact(humanDiagnostic(error)));
    if (jsonRequested) {
      process.stdout.write(`${redact(JSON.stringify(err(error)))}\n`);
    }
    exitCode = mapExitCode(error);
  }

  // BR-U6-1: the ONLY process.exit call site in the project.
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
