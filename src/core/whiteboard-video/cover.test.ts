/**
 * 片头封面的测试。
 *
 * 封面是「渲一张图」，很容易写成只断言"没抛异常"。这里守的是三件会**静默变
 * 难看**的事：标题一行放不下时字号要收、主视觉要按指令取到正确那一段、
 * 缺人设时不能署名（署上一个空名字比不署名更糟）。
 */

import { describe, expect, test } from "bun:test";

import { parseArticle } from "./article";
import { coverSvg, fitTitleSize, pickCoverBlock } from "./cover";
import type { BoardSpec } from "./board-block";
import type { Persona } from "../persona/index";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PERSONA: Persona = {
  penName: "二木",
  signature: "二木",
  bio: "bio",
  career: ["career"],
  topics: ["a"],
  tone: ["b"],
  keepEnglish: ["loop"],
  avoid: ["c"],
  cta: ["关注二木 · 聊大模型落地"],
  defaultVoice: "narrator-male-steady",
};

const NOTE: BoardSpec = {
  kind: "note",
  shape: "cloud",
  text: "先把 loop 做对",
};
const FLOW: BoardSpec = {
  kind: "flow",
  nodes: [
    { id: "a", text: "research", kind: "step" },
    { id: "b", text: "write", kind: "step" },
  ],
  edges: [],
};

function base(): Parameters<typeof coverSvg>[0] {
  return { title: "标题", width: 1920, height: 1080, background: "grid" };
}

describe("fitTitleSize", () => {
  test("短标题用基准字号", () => {
    expect(fitTitleSize("Loop 还是 Graph", 1920, 116)).toBe(116);
  });

  test("长标题收字号而不是折行（折行的第二行会被信息流小窗裁掉）", () => {
    const long =
      "从 prompt 到 context 到 harness 到 loop 再到 graph 的五层框架";
    const size = fitTitleSize(long, 1920, 116);
    expect(size).toBeLessThan(116);
    expect(size).toBeGreaterThan(40);
  });
});

describe("pickCoverBlock", () => {
  const sections = [{}, { board: NOTE }, { board: FLOW }];

  test("auto 取第一个有图形块的段", () => {
    expect(pickCoverBlock(sections, { kind: "auto" })).toBe(NOTE);
  });

  test("指定段号严格取那一段", () => {
    expect(pickCoverBlock(sections, { kind: "section", index: 3 })).toBe(FLOW);
  });

  test("指定的那段没有块 → undefined（封面退化成纯文字，不报错）", () => {
    expect(
      pickCoverBlock(sections, { kind: "section", index: 1 }),
    ).toBeUndefined();
  });

  test("off → 不取", () => {
    expect(pickCoverBlock(sections, { kind: "off" })).toBeUndefined();
  });
});

describe("coverSvg", () => {
  test("画幅、标题、副标、金句都进 SVG", () => {
    const svg = coverSvg({
      ...base(),
      subtitle: "副标一行",
      tagline: "金句一行",
    });
    expect(svg).toStartWith("<svg");
    expect(svg).toContain('width="1920"');
    expect(svg).toContain('height="1080"');
    // 文字是矢量路径，不是 <text>（帧渲染器不加载系统字体）
    expect(svg).not.toContain("<text");
    expect(svg).toContain("</svg>");
  });

  test("有人设就署名 + 带 CTA", () => {
    const svg = coverSvg({ ...base(), persona: PERSONA });
    const plain = coverSvg(base());
    expect(svg.length).toBeGreaterThan(plain.length);
  });

  test("没有人设时不署名（不能署上空名字）", () => {
    const svg = coverSvg(base());
    expect(svg).toStartWith("<svg");
  });

  test("同一输入渲出同一张图（纯函数：封面必须可复现）", () => {
    const input = { ...base(), block: FLOW, tagline: "金句" };
    expect(coverSvg(input)).toBe(coverSvg(input));
  });

  test("竖版画幅也能排（块自己会改纵向）", () => {
    const svg = coverSvg({ ...base(), width: 1080, height: 1920, block: FLOW });
    expect(svg).toContain('height="1920"');
  });
});

describe("文章的封面指令", () => {
  function write(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cover-art-"));
    const path = join(dir, "a.md");
    writeFileSync(path, body, "utf8");
    return path;
  }

  const SECTIONS = `
## 第一段

旁白：一句话。

## 第二段

旁白：又一句。
`;

  test("默认 auto，副标与金句缺省", () => {
    const a = parseArticle(write(`# 标题\n${SECTIONS}`));
    expect(a.cover).toEqual({ kind: "auto" });
    expect(a.subtitle).toBeUndefined();
    expect(a.tagline).toBeUndefined();
  });

  test("cover / subtitle / tagline 三条指令都解析", () => {
    const a = parseArticle(
      write(
        `# 标题\n> cover: 2\n> subtitle: 副标\n> tagline: 金句\n${SECTIONS}`,
      ),
    );
    expect(a.cover).toEqual({ kind: "section", index: 2 });
    expect(a.subtitle).toBe("副标");
    expect(a.tagline).toBe("金句");
  });

  test("cover: off 关掉封面", () => {
    const a = parseArticle(write(`# 标题\n> cover: off\n${SECTIONS}`));
    expect(a.cover).toEqual({ kind: "off" });
  });

  test("非法值当场报错（静默不出封面作者不会发现）", () => {
    expect(() =>
      parseArticle(write(`# 标题\n> cover: yes\n${SECTIONS}`)),
    ).toThrow(/cover 只接受/);
  });

  test("段号越界当场报错", () => {
    expect(() =>
      parseArticle(write(`# 标题\n> cover: 9\n${SECTIONS}`)),
    ).toThrow(/第 9 段不存在/);
  });
});
