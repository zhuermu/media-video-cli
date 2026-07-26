/**
 * @module cli/commands/schema
 *
 * `vagent schema` — 把整张命令表吐成 JSON。
 *
 * 为什么要有这条命令：这条 CLI 的主要调用方是大模型（skills 编排它），而模型
 * 看不到源码。没有 schema 时，skill 里只能把参数抄一遍——抄的那一份会漂移，
 * 而漂移的表现是模型传了一个不存在的 flag，跑到 parse 层才失败。有了 schema，
 * skill 只写"先读 schema"，命令改了模型自动跟上。
 *
 * 输出**永远是 JSON**，不管有没有 `--json`：它唯一的消费者是程序。
 *
 * Boundary rules honored here:
 * - BR-U6-2: 结果走 stdout；本命令不写任何文件。
 */

import { readFileSync } from "node:fs";

import { cliSchema } from "../parse";
import type { CommandResult } from "../envelope";

/** 读包版本（schema 的 version 字段；缺失时退化为 0.0.0）. */
function packageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Runs `schema`（纯读，零写入）. */
export function runSchema(): CommandResult {
  const schema = cliSchema(packageVersion());
  return {
    data: schema as unknown as Record<string, unknown>,
    // --json 时 main 会用 data 组信封；不带 --json 时也给 JSON 原文。
    text: `${JSON.stringify(schema, null, 2)}\n`,
  };
}
