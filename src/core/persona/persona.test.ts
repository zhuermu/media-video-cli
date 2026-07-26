/**
 * 人设加载器的加载语义单测。
 *
 * 两条语义正好相反，都要锁住：**缺文件是合法的**（人设可选，缺了只是不署名），
 * **缺字段不是**（既然配了就说明要署名，静默补默认值会让成片署上作者没写过的名字）。
 */

import { afterAll, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ValidationError } from "@core/errors";

import {
  DEFAULT_PERSONA_PATH,
  authorBlock,
  loadPersona,
  parsePersona,
} from "./index";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function writeJson(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "persona-"));
  roots.push(root);
  const path = join(root, "p.json");
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

const complete = {
  penName: "二木",
  bio: "简介",
  career: ["后端工程师", "解决方案架构师"],
  topics: ["LLM"],
  tone: ["先给结论"],
  keepEnglish: ["prompt", "agent"],
  avoid: ["财经"],
  cta: ["关注二木 · 聊大模型落地", "第二条"],
  signature: "二木",
  defaultVoice: "narrator-male-steady",
};

describe("loadPersona", () => {
  test("仓库自带的人设文件本身合法（门禁：改坏了当场失败）", () => {
    const persona = loadPersona(DEFAULT_PERSONA_PATH);
    expect(persona).toBeDefined();
    expect(persona!.penName).toBe("二木");
    expect(persona!.keepEnglish.length).toBeGreaterThan(0);
    expect(persona!.cta.length).toBeGreaterThan(0);
    // 术语清单必须含核心 term of art（写作侧靠它决定不译什么）
    expect(persona!.keepEnglish).toContain("prompt");
    expect(persona!.keepEnglish).toContain("agent");
  });

  test("文件不存在 → undefined（人设是可选素材，不阻断流水线）", () => {
    expect(
      loadPersona("/tmp/definitely-not-a-persona-file.json"),
    ).toBeUndefined();
  });

  test("完整文件加载成功", () => {
    const persona = loadPersona(writeJson(complete));
    expect(persona!.defaultVoice).toBe("narrator-male-steady");
    expect(persona!.career).toHaveLength(2);
  });

  test("坏 JSON → ValidationError 点名文件", () => {
    const path = writeJson("{ 这不是 json");
    expect(() => loadPersona(path)).toThrow(ValidationError);
    expect(() => loadPersona(path)).toThrow(/不是合法 JSON/);
  });

  test("缺字段 → ValidationError 一次列全", () => {
    const { penName: _drop, ...missingName } = complete;
    const path = writeJson({ ...missingName, cta: [] });
    try {
      loadPersona(path);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as Error).message;
      expect(message).toContain("penName");
      expect(message).toContain("cta");
      expect(message).toContain("2 处");
    }
  });

  test("空 keepEnglish / 空 cta 都不接受", () => {
    expect(() =>
      loadPersona(writeJson({ ...complete, keepEnglish: [] })),
    ).toThrow(/keepEnglish/);
    expect(() => loadPersona(writeJson({ ...complete, cta: [] }))).toThrow(
      /cta/,
    );
  });

  test("数组里混进非字符串也报错", () => {
    expect(() =>
      loadPersona(writeJson({ ...complete, topics: ["LLM", 42] })),
    ).toThrow(/topics/);
  });

  test("顶层不是对象 → 报错", () => {
    expect(() => parsePersona([1, 2], "x")).toThrow(/不是一个 JSON 对象/);
  });
});

describe("authorBlock", () => {
  test("取第一条 CTA 作为发布包署名的关注引导", () => {
    expect(authorBlock(parsePersona(complete, "x"))).toEqual({
      pen_name: "二木",
      bio: "简介",
      cta: "关注二木 · 聊大模型落地",
    });
  });
});
