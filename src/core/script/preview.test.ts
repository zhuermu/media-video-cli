/**
 * Tests for renderPreview — full markdown snapshot of the Q3=A structure
 * (H1 + meta block + segment table + review footer), the prominent
 * target-window marker for both verdicts (BR-U3-9, warn-not-block BR-U3-7),
 * table-cell escaping, and determinism. Pure function — fully offline.
 */
import { describe, expect, test } from "bun:test";

import {
  estimateDuration,
  renderPreview,
  type DurationEstimate,
  type Script,
} from "@core/script";

const script: Script = {
  title: "bun 上手三步曲",
  topic: "如何用 bun 快速搭建 TypeScript 项目",
  segments: [
    { text: "第一步，安装 bun。", cardText: "安装 bun" },
    { text: "第二步，初始化项目。", cardText: "初始化项目" },
    { text: "第三步，运行测试。", cardText: "运行测试" },
  ],
  source: { kind: "topic", ref: "bun 上手" },
};

const inTarget: DurationEstimate = {
  total: 75.5,
  perSegment: [25.3, 25.3, 24.9],
  withinTarget: true,
};

describe("renderPreview", () => {
  test("full markdown snapshot (Q3=A: H1 + meta + table + footer)", () => {
    expect(renderPreview(script, inTarget)).toBe(
      [
        "# 脚本审核 — bun 上手三步曲",
        "",
        "- 主题: 如何用 bun 快速搭建 TypeScript 项目",
        "- 来源: topic（bun 上手）",
        "- 总时长估算: 75.5s — **✓ 落在 60-180s 目标区间内**",
        "",
        "| # | 口播文字 | 卡片文案 | 估算秒数 |",
        "|---|----------|----------|----------|",
        "| 1 | 第一步，安装 bun。 | 安装 bun | 25.3 |",
        "| 2 | 第二步，初始化项目。 | 初始化项目 | 25.3 |",
        "| 3 | 第三步，运行测试。 | 运行测试 | 24.9 |",
        "",
        "---",
        "",
        "审核指引: 确认无误 → 运行 `tts run <slug>` 继续；需修改 → 编辑 " +
          "`script/script.json` 后重跑 `script validate <slug>`。",
        "",
      ].join("\n"),
    );
  });

  test("out-of-window total renders the ✗ warning marker + footer (BR-U3-7/9)", () => {
    const markdown = renderPreview(script, {
      total: 7.2,
      perSegment: [2.4, 2.4, 2.4],
      withinTarget: false,
    });
    expect(markdown).toContain("**✗ 不在 60-180s 目标区间");
    expect(markdown).toContain("仅警告，不阻断");
    expect(markdown).toContain("审核指引:");
  });

  test("estimate defaults to estimateDuration(script) (locked 1-arg signature)", () => {
    expect(renderPreview(script)).toBe(
      renderPreview(script, estimateDuration(script)),
    );
  });

  test("pipe and newline characters in cells are escaped", () => {
    const tricky: Script = {
      ...script,
      segments: [
        { text: "有竖线|的口播\n换行", cardText: "卡片|文案" },
        ...script.segments.slice(1),
      ],
    };
    const markdown = renderPreview(tricky, inTarget);
    expect(markdown).toContain(
      "| 1 | 有竖线\\|的口播 换行 | 卡片\\|文案 | 25.3 |",
    );
  });

  test("determinism: repeat calls produce byte-identical markdown", () => {
    expect(renderPreview(script, inTarget)).toBe(
      renderPreview(script, inTarget),
    );
  });
});
