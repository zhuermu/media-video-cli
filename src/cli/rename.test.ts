/**
 * 改名守护：旧项目名（media-video- 加 agent）不允许再出现在源码 / 文档 / skills 里。
 *
 * 为什么要一条测试而不是"改完就算了"：旧名散在过 60 个文件（包名、README、五份
 * 文档、两个 SKILL.md、steering、experiments 的注释路径）。人工 grep 一次能清干净，
 * 但下一次从旧文档复制粘贴就会带回来一个死路径——而死路径只在别人照着文档敲命令时
 * 才暴露。
 *
 * 白名单只有两处：README 的改名说明（必须留旧名才说得清），以及 `videos/`（本地
 * 工作数据，gitignored，历史成片的 concat 清单里写着旧的绝对路径）。
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
// 拼出来而不是写成字面量：否则这条守护测试自己就是一处"残留"。
const OLD_NAME = ["media", "video", "agent"].join("-");

/** 不扫的目录：依赖、构建产物、本地工作数据、素材二进制. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "videos",
  "data",
  "coverage",
  "assets",
  "out",
]);

/** 只扫文本源：代码、文档、配置. */
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".json",
  ".md",
  ".toml",
  ".yml",
  ".yaml",
  ".txt",
]);

/** README 的改名说明必须保留旧名，否则说不清迁移. */
const ALLOWED = new Set(["README.md"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

describe("项目改名", () => {
  test("源码与文档里不再出现旧项目名（README 改名说明除外）", () => {
    const offenders = walk(ROOT)
      .filter((f) => !ALLOWED.has(relative(ROOT, f)))
      .filter((f) => readFileSync(f, "utf8").includes(OLD_NAME))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test("package.json 用新名，但命令名仍是 vagent", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toBe("media-video-cli");
    expect(pkg.scripts["vagent"]).toBe("bun run src/cli/main.ts");
  });
});
