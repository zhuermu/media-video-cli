/**
 * 文章片级指令的解析（`> signature:` 与 `> cast:` 的默认值语义）。
 *
 * 这两条都有"默认值 vs 显式值"的分歧，测试锁的正是那个分歧：signature 默认 on，
 * castAuthored 用来区分"没写 cast"和"写了 solo 预设"——后者不该被人设的默认音色覆盖。
 */

import { afterAll, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ValidationError } from "@core/errors";

import { parseArticle } from "./article";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "article-"));
  roots.push(root);
  const path = join(root, "a.md");
  writeFileSync(path, body, "utf8");
  return path;
}

const MINIMAL = "# 标题\n\n## 一段\n\n这是口播。\n";

describe("parseArticle 片级指令", () => {
  test("signature 默认 on（署名是常态，不署名才是例外）", () => {
    expect(parseArticle(write(MINIMAL)).signature).toBe(true);
  });

  test("> signature: off 关掉署名", () => {
    const a = parseArticle(write(`# 标题\n\n> signature: off\n\n${MINIMAL}`));
    expect(a.signature).toBe(false);
  });

  test("signature 写错值当场报错，不静默不署名", () => {
    expect(() =>
      parseArticle(write(`# 标题\n\n> signature: yes\n\n## 一段\n\n口播。\n`)),
    ).toThrow(ValidationError);
    expect(() =>
      parseArticle(write(`# 标题\n\n> signature: yes\n\n## 一段\n\n口播。\n`)),
    ).toThrow(/on \| off/);
  });

  test("castAuthored 区分「没写 cast」与「显式写了 cast」", () => {
    expect(parseArticle(write(MINIMAL)).castAuthored).toBe(false);
    const explicit = parseArticle(
      write(
        `# 标题\n\n> cast: 主讲=news-male-formal\n\n## 一段\n\n主讲：口播。\n`,
      ),
    );
    expect(explicit.castAuthored).toBe(true);
    expect(explicit.cast["主讲"]).toBe("news-male-formal");
  });
});
