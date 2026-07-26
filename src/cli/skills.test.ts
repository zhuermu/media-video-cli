/**
 * skills 守护测试：SKILL.md 里出现的每条 `vagent …` 示例命令都必须在路由表里存在。
 *
 * 这是"参数别抄进 skill"那条纪律的兜底。skill 面向大模型，写错一个 flag 的后果不是
 * 报错信息难看，而是模型照着一份不存在的接口去调用——而这种错在人读 skill 时看不出来
 * （文字读着完全合理）。所以让测试去读那些示例，按 schema 逐个核对。
 */

import { describe, expect, test } from "bun:test";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { GLOBAL_OPTIONS, ROUTES } from "./parse";

const SKILLS_DIR = new URL("../../skills/", import.meta.url).pathname;

function skillFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) skillFiles(full, out);
    else if (name === "SKILL.md") out.push(full);
  }
  return out;
}

/**
 * 抠出示例命令：**只看代码块里以 `vagent ` 开头的行**。
 *
 * 不扫正文是必须的——正文里会出现「编排 vagent CLI 全流程（init → script → …）」这样的
 * 叙述，那不是一条命令。判据放在"代码块 + 行首"上，作者写文档时不需要为测试让路。
 */
function extractCommands(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const body = line.replace(/^\$\s*/, "");
    if (!body.startsWith("vagent ")) continue;
    // 去掉行尾注释与管道
    const cmd = body
      .slice("vagent ".length)
      .split(/\s+#|\s*\|/)[0]!
      .trim();
    if (cmd.length > 0) out.push(cmd);
  }
  return out;
}

const files = skillFiles(SKILLS_DIR);

describe("skills 示例命令", () => {
  test("仓库里至少有两个 skill（video-agent + whiteboard-video）", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of files) {
    const rel = relative(SKILLS_DIR, file);
    const commands = extractCommands(readFileSync(file, "utf8"));

    test(`${rel}: 每条示例的 route 与 flag 都在路由表里`, () => {
      expect(commands.length).toBeGreaterThan(0);
      for (const cmd of commands) {
        const words = cmd.split(/\s+/).filter((w) => w.length > 0);
        // 帮助与花括号函数定义那类行不是真命令
        if (words.length === 0) continue;
        if (words[0]!.startsWith("-") || words[0]!.startsWith('"')) continue;

        const spec =
          ROUTES.find(
            (r) =>
              r.tokens.length === 2 &&
              r.tokens[0] === words[0] &&
              r.tokens[1] === words[1],
          ) ??
          ROUTES.find((r) => r.tokens.length === 1 && r.tokens[0] === words[0]);
        expect(
          spec,
          `${rel} 里的 "vagent ${cmd}" 不是已注册命令`,
        ).toBeDefined();

        for (const word of words) {
          if (!word.startsWith("--")) continue;
          const name = word.replace(/^--/, "").split("=")[0]!;
          const known =
            name in spec!.options || name in GLOBAL_OPTIONS || name === "help";
          expect(
            known,
            `${rel} 里 "vagent ${cmd}" 用了未注册的 --${name}`,
          ).toBe(true);
        }
      }
    });
  }
});
