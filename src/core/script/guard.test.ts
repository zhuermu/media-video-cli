/**
 * Tests for guardDomain — hits per category over the shipped table, the
 * full scan surface topic/text/cardText (BR-U3-3), case-insensitive
 * matching, silent pass on clean content, and fail-closed IoError when the
 * table file is missing or corrupt. mkdtemp sandboxes for custom tables.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainGuardError, IoError } from "@core/errors";
import { guardDomain, loadGuardTable, type Script } from "@core/script";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "script-guard-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A clean (general-domain) script fixture. */
function cleanScript(): Script {
  return {
    title: "bun 上手",
    topic: "TypeScript 工具链效率提升",
    segments: [
      { text: "第一步，安装 bun。", cardText: "安装 bun" },
      { text: "第二步，初始化项目。", cardText: "初始化项目" },
      { text: "第三步，运行测试。", cardText: "运行测试" },
    ],
    source: { kind: "topic", ref: "bun 上手" },
  };
}

describe("guardDomain", () => {
  test("finance keyword in topic → DomainGuardError naming category + terms", () => {
    const script = { ...cleanScript(), topic: "教你炒股三个月翻倍" };
    expect(() => guardDomain(script)).toThrow(DomainGuardError);
    expect(() => guardDomain(script)).toThrow(/finance/);
    expect(() => guardDomain(script)).toThrow(/炒股/);
  });

  test("medical keyword inside segments[].text is caught (scan surface)", () => {
    const script = cleanScript();
    script.segments[1] = { text: "这个偏方三天见效。", cardText: "小技巧" };
    expect(() => guardDomain(script)).toThrow(DomainGuardError);
    expect(() => guardDomain(script)).toThrow(/medical/);
  });

  test("gambling keyword inside cardText is caught (BR-U3-3 covers cardText)", () => {
    const script = cleanScript();
    script.segments[2] = {
      text: "第三步，运行测试。",
      cardText: "彩票预测技巧",
    };
    expect(() => guardDomain(script)).toThrow(DomainGuardError);
    expect(() => guardDomain(script)).toThrow(/gambling/);
  });

  test("matching is case-insensitive substring (custom table)", async () => {
    const tablePath = join(dir, "guard.json");
    await writeFile(
      tablePath,
      JSON.stringify({
        categories: [{ name: "gambling", keywords: ["Casino"] }],
      }),
      "utf8",
    );
    expect(() =>
      guardDomain("welcome to the CASINO tonight", { tablePath }),
    ).toThrow(DomainGuardError);
  });

  test("clean content passes silently (Script and bare-topic string)", () => {
    expect(() => guardDomain(cleanScript())).not.toThrow();
    expect(() => guardDomain("职场效率与个人成长")).not.toThrow();
  });

  test("missing table file → IoError (fail closed, never silent pass)", () => {
    expect(() =>
      guardDomain("任何内容", { tablePath: join(dir, "absent.json") }),
    ).toThrow(IoError);
  });

  test("corrupt or malformed table → IoError (fail closed)", async () => {
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{ not json", "utf8");
    expect(() => guardDomain("任何内容", { tablePath: corrupt })).toThrow(
      IoError,
    );

    const badShape = join(dir, "bad-shape.json");
    await writeFile(badShape, JSON.stringify({ categories: [{}] }), "utf8");
    expect(() => guardDomain("任何内容", { tablePath: badShape })).toThrow(
      IoError,
    );
  });

  test("table is cached per path (one load, same reference)", () => {
    expect(loadGuardTable()).toBe(loadGuardTable());
  });
});
