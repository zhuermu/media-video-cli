/**
 * Tests for validateScript — full-violations reporting (BR-U3-1, never
 * fail-fast on the first field), segment-count boundaries 3/20 (FR-1 AC-1),
 * per-field length caps, emphasis-substring rule (BR-U3-10), topic
 * truncate+warn (BR-U3-5), bad JSON, and missing file. mkdtemp sandboxes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotFoundError, ValidationError } from "@core/errors";
import { SCRIPT_CONSTRAINTS, validateScript, type Script } from "@core/script";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "script-validate-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A minimal fully valid script fixture. */
function validScript(): Script {
  return {
    title: "bun 上手三步曲",
    topic: "如何用 bun 快速搭建 TypeScript 项目",
    segments: [
      { text: "第一步，安装 bun。", cardText: "安装 bun" },
      {
        text: "第二步，初始化项目。",
        cardText: "初始化项目",
        emphasis: ["初始化"],
      },
      { text: "第三步，运行测试。", cardText: "运行测试" },
    ],
    source: { kind: "topic", ref: "bun 上手" },
  };
}

/** Writes a fixture as script.json and returns its path. */
async function write(content: unknown): Promise<string> {
  const path = join(dir, "script.json");
  await writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
  return path;
}

/** Runs validateScript expecting a ValidationError; returns its message. */
async function expectViolations(path: string): Promise<string> {
  try {
    await validateScript(path, { warn: () => {} });
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).message;
  }
  throw new Error("expected ValidationError, got none");
}

describe("validateScript", () => {
  test("valid script parses and returns every locked field", async () => {
    const script = await validateScript(await write(validScript()));
    expect(script).toEqual(validScript());
  });

  test("missing file → NotFoundError", async () => {
    expect(validateScript(join(dir, "absent.json"))).rejects.toThrow(
      NotFoundError,
    );
  });

  test("bad JSON → ValidationError naming 不是合法 JSON", async () => {
    const path = await write("{ not json !!");
    expect(validateScript(path)).rejects.toThrow(ValidationError);
    expect(validateScript(path)).rejects.toThrow("不是合法 JSON");
  });

  test("all violations are reported in one pass, one per line (BR-U3-1)", async () => {
    const message = await expectViolations(
      await write({
        title: "",
        topic: "",
        segments: [
          { text: "", cardText: "要点" },
          { text: "正文", cardText: "" },
        ],
        source: { kind: "video", ref: "" },
      }),
    );
    // title + topic + segment count + seg0.text + seg1.cardText + kind + ref
    expect(message.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(
      7,
    );
    expect(message).toContain("title:");
    expect(message).toContain("topic:");
    expect(message).toContain("segments: 段数 2 少于下限 3");
    expect(message).toContain("segments[0].text:");
    expect(message).toContain("segments[1].cardText:");
    expect(message).toContain("source.kind:");
    expect(message).toContain("source.ref:");
  });

  test("segment-count boundaries: 3 and 20 pass, 21 fails", async () => {
    const seg = { text: "正文", cardText: "要点" };
    const at20 = { ...validScript(), segments: Array(20).fill(seg) };
    expect((await validateScript(await write(at20))).segments).toHaveLength(20);

    const at21 = { ...validScript(), segments: Array(21).fill(seg) };
    const message = await expectViolations(await write(at21));
    expect(message).toContain("段数 21 超过上限 20");
  });

  test("field over-length: title 61, text 301, cardText 81 all listed", async () => {
    const message = await expectViolations(
      await write({
        ...validScript(),
        title: "长".repeat(SCRIPT_CONSTRAINTS.titleMaxChars + 1),
        segments: [
          {
            text: "字".repeat(SCRIPT_CONSTRAINTS.textMaxChars + 1),
            cardText: "要点",
          },
          {
            text: "正文",
            cardText: "卡".repeat(SCRIPT_CONSTRAINTS.cardTextMaxChars + 1),
          },
          { text: "正文", cardText: "要点" },
        ],
      }),
    );
    expect(message).toContain("title: 超长 61 字符（上限 60）");
    expect(message).toContain("segments[0].text: 超长 301 字符（上限 300/段）");
    expect(message).toContain("segments[1].cardText: 超长 81 字符（上限 80）");
  });

  test("emphasis entry not a substring of cardText → violation (BR-U3-10)", async () => {
    const base = validScript();
    base.segments[0]!.emphasis = ["不存在的词"];
    const message = await expectViolations(await write(base));
    expect(message).toContain(
      'segments[0].emphasis: "不存在的词" 不是 cardText 的子串',
    );
  });

  test("backgroundImage: .jpg/.jpeg/.png（大小写不敏感）通过并保留", async () => {
    const base = validScript();
    base.segments[0]!.backgroundImage = "sunset.jpg";
    base.segments[1]!.backgroundImage = "/abs/path/city.PNG";
    base.segments[2]!.backgroundImage = "photo.jpeg";
    const script = await validateScript(await write(base));
    expect(script.segments[0]!.backgroundImage).toBe("sunset.jpg");
    expect(script.segments[1]!.backgroundImage).toBe("/abs/path/city.PNG");
    expect(script.segments[2]!.backgroundImage).toBe("photo.jpeg");
    // 未设置的段不长出该字段（additive，不污染原有形状）。
    const plain = await validateScript(await write(validScript()));
    expect("backgroundImage" in plain.segments[0]!).toBe(false);
  });

  test("backgroundImage: 非法扩展名与空串被拒（存在性不在此查）", async () => {
    const base = validScript();
    base.segments[0]!.backgroundImage = "photo.gif";
    base.segments[1]!.backgroundImage = "  ";
    const message = await expectViolations(await write(base));
    expect(message).toContain(
      'segments[0].backgroundImage: "photo.gif" 扩展名不支持',
    );
    expect(message).toContain("segments[1].backgroundImage: 必须为非空字符串");
  });

  test("topic >500 chars is truncated to 500 with a warning, not rejected (BR-U3-5)", async () => {
    const warnings: string[] = [];
    const script = await validateScript(
      await write({ ...validScript(), topic: "题".repeat(501) }),
      { warn: (m) => warnings.push(m) },
    );
    expect(script.topic).toHaveLength(SCRIPT_CONSTRAINTS.topicMaxChars);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("已截断至 500");
  });
});

// ---- whiteboard 风格扩展（additive schema） --------------------------------

/** whiteboard 风格的合法脚本 fixture. */
function validWhiteboardScript(): Script {
  const base = validScript();
  return {
    ...base,
    style: "whiteboard",
    theme: "clean",
    segments: base.segments.map((s, i) => ({
      ...s,
      scene: {
        elements:
          i === 0
            ? [
                { type: "title", text: "安装 bun", underline: true },
                { type: "text", text: "一条命令搞定" },
              ]
            : i === 1
              ? [
                  { type: "chart", chart: "bars-up", label: "更快" },
                  { type: "sticker", name: "blob" },
                ]
              : [
                  { type: "icon", name: "check", accent: true, label: "完成" },
                  { type: "bullet", text: "秒级冷启动" },
                ],
      },
    })),
  };
}

describe("validateScript — whiteboard 扩展", () => {
  test("合法 whiteboard 脚本通过并保留 style/theme/scene", async () => {
    const script = await validateScript(await write(validWhiteboardScript()));
    expect(script.style).toBe("whiteboard");
    expect(script.theme).toBe("clean");
    expect(script.segments[0]!.scene!.elements[0]).toEqual({
      type: "title",
      text: "安装 bun",
      underline: true,
    });
  });

  test("style=whiteboard 但缺 scene → 逐段违规", async () => {
    const bad = { ...validScript(), style: "whiteboard" };
    const message = await expectViolations(await write(bad));
    expect(message).toContain("segments[0].scene");
    expect(message).toContain("segments[2].scene");
  });

  test("非法 style / 未知 theme 被拒并列出可用值", async () => {
    const bad = { ...validScript(), style: "3d", theme: "neon" };
    const message = await expectViolations(await write(bad));
    expect(message).toContain("style:");
    expect(message).toContain("theme:");
    expect(message).toContain("clean");
  });

  test("场景元素校验：未知类型/未知图标名/文案超长/坏图表种类一次性报全", async () => {
    const s = validWhiteboardScript();
    s.segments[0]!.scene = {
      elements: [
        { type: "wat" } as never,
        { type: "icon", name: "nope" } as never,
        { type: "title", text: "超长标题超长标题超长标题超长" },
        { type: "chart", chart: "pie" } as never,
      ],
    };
    const message = await expectViolations(await write(s));
    expect(message).toContain("未知元素类型");
    expect(message).toContain("未知线稿元素");
    expect(message).toContain("超长");
    expect(message).toContain('"bars-up"/"line-up"/"steps"');
  });

  test("image.src 扩展名校验 + label 超长", async () => {
    const s = validWhiteboardScript();
    s.segments[1]!.scene = {
      elements: [
        {
          type: "image",
          src: "photo.gif",
          label: "这个标注实在是太长了呀",
        } as never,
      ],
    };
    const message = await expectViolations(await write(s));
    expect(message).toContain("扩展名不支持");
    expect(message).toContain("label");
  });

  test("cards 风格携带 scene → 警告但不拒绝", async () => {
    const s = validScript() as Record<string, unknown>;
    (s["segments"] as Record<string, unknown>[])[0]!["scene"] = {
      elements: [{ type: "text", text: "会被忽略" }],
    };
    const warnings: string[] = [];
    const script = await validateScript(await write(s), {
      warn: (m) => warnings.push(m),
    });
    expect(script.segments[0]!.scene).toBeDefined();
    expect(warnings.some((w) => w.includes("将被忽略"))).toBe(true);
  });

  test("scene.elements 空数组 / 超上限被拒", async () => {
    const s = validWhiteboardScript();
    s.segments[0]!.scene = { elements: [] };
    const message = await expectViolations(await write(s));
    expect(message).toContain("非空数组");

    const s2 = validWhiteboardScript();
    s2.segments[0]!.scene = {
      elements: Array.from({ length: 7 }, () => ({
        type: "text" as const,
        text: "行",
      })),
    };
    const message2 = await expectViolations(await write(s2));
    expect(message2).toContain("超上限");
  });
});
