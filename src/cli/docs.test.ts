/**
 * 文档漂移门禁：`docs/cli.md` 的生成段必须与当前路由表一致。
 *
 * 参数文档腐烂是静默的——加一个 flag、忘了重新生成，文档就开始说谎，而读者（人或
 * 大模型）照着敲会得到"参数解析失败"。把它变成一条会失败的测试，是让"改参数要更新
 * 文档"这件事不依赖记性。
 */

import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import {
  BEGIN,
  END,
  normalizeMd,
  renderCliDocs,
  spliceGenerated,
} from "../../scripts/gen-cli-docs";
import { cliSchema } from "./parse";

const DOC = new URL("../../docs/cli.md", import.meta.url).pathname;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return pkg.version ?? "0.0.0";
}

describe("docs/cli.md", () => {
  const doc = readFileSync(DOC, "utf8");

  test("生成标记还在（手写段与生成段的边界）", () => {
    expect(doc).toContain(BEGIN);
    expect(doc).toContain(END);
  });

  test("生成段与路由表一致（不一致请跑 bun run docs:cli）", () => {
    const expected = spliceGenerated(doc, renderCliDocs(cliSchema(version())));
    // 列宽/分隔行的差异由 prettier 造成，不算漂移（见 normalizeMd 的说明）
    expect(normalizeMd(doc)).toBe(normalizeMd(expected));
  });

  test("每条命令都在文档里露面（生成器没漏分组）", () => {
    for (const spec of cliSchema(version()).commands) {
      expect(doc, `docs/cli.md 里没有 ${spec.route}`).toContain(
        `#### \`${spec.route}\``,
      );
    }
  });
});
