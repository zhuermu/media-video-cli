/**
 * @core/whiteboard hanzi 单测：字形加载回退、度量、手写元素的确定性
 * 与笔尖轨迹、XML 转义。
 */
import { describe, expect, test } from "bun:test";

import {
  escapeXmlText,
  hanziTextEl,
  loadGlyph,
  measureHanziText,
} from "./hanzi";

describe("loadGlyph", () => {
  test("常用字有笔顺数据", () => {
    const g = loadGlyph("白");
    expect(g).not.toBeNull();
    expect(g!.strokes.length).toBe(g!.medians.length);
    expect(g!.strokes.length).toBeGreaterThan(0);
  });

  test("非 CJK 字符返回 null（回退扫掠）", () => {
    expect(loadGlyph("A")).toBeNull();
    expect(loadGlyph("7")).toBeNull();
  });
});

describe("measureHanziText", () => {
  test("CJK 取手写字体步进、ASCII 窄于全宽、空串为 0", () => {
    expect(measureHanziText("", 100, 10)).toBe(0);
    // CJK 宽度 = 手写字体的步进宽度（站酷快乐体 0.92 em），不再假定全宽。
    // 只断言"落在全宽附近的合理区间"，不写死某支字体的具体数值——换字体
    // 不该弄红这条测试，但字宽跑到全宽的一半或超出全宽都是真的坏了。
    const cjk = measureHanziText("白", 100, 10);
    expect(cjk).toBeGreaterThan(80);
    expect(cjk).toBeLessThanOrEqual(100);
    const mixed = measureHanziText("白A", 100, 10);
    // A 的宽度：opentype 实测步进或因子回退，均应窄于全宽且为正
    expect(mixed).toBeGreaterThan(cjk + 10 + 20);
    expect(mixed).toBeLessThan(cjk + 10 + 100);
  });
});

function makeEl(text: string) {
  return hanziTextEl(text, {
    x: 100,
    y: 200,
    size: 200,
    gap: 16,
    t0: 1,
    perChar: 0.5,
    color: "#222222",
    fontFamily: "PingFang SC",
    idp: "t",
  });
}

describe("hanziTextEl", () => {
  test("t<t0 不可见，t>t1 定格完整（轮廓填充）", () => {
    const el = makeEl("白板");
    expect(el.svg(0.5)).toBe("");
    const done = el.svg(el.t1 + 1);
    expect(done).toContain("<path d=");
    expect(done).toContain('fill="#222222"');
    expect(done).not.toContain("clipPath"); // 完成态无揭示 clip
  });

  test("同 t 输出确定（快照锚点）", () => {
    const el = makeEl("白");
    const mid = el.t0 + (el.t1 - el.t0) / 2;
    expect(el.svg(mid)).toBe(el.svg(mid));
  });

  test("书写过程中出现笔画揭示（手写体=mask / 回退=clipPath，多点采样）", () => {
    const el = makeEl("白");
    let revealed = 0;
    for (let i = 1; i < 20; i++) {
      const svg = el.svg(el.t0 + ((el.t1 - el.t0) * i) / 20);
      if (
        svg.includes("stroke-dasharray") &&
        (svg.includes("<mask") || svg.includes("clipPath"))
      ) {
        revealed++;
      }
    }
    expect(revealed).toBeGreaterThan(5);
  });

  test("手写字体在位时：书写中用 mask 揭示，完成态为无遮罩字形", async () => {
    const { handwritingFont } = await import("./glyphs");
    if (handwritingFont() === null) return; // 无手写字体环境跳过
    const el = makeEl("白板");
    const mid = el.t0 + (el.t1 - el.t0) * 0.2;
    const midSvg = el.svg(mid);
    expect(midSvg).toContain("<mask");
    expect(midSvg).toContain("stroke-dasharray");
    const done = el.svg(el.t1 + 1);
    expect(done).not.toContain("<mask");
    expect(done).toContain("<path d=");
  });

  test("禁用手写字体：回退楷体笔画轮廓（clipPath 揭示）", async () => {
    const { setHandwritingFontPath } = await import("./glyphs");
    setHandwritingFontPath(null);
    try {
      const el = makeEl("白");
      let sawClip = false;
      for (let i = 1; i < 20; i++) {
        const svg = el.svg(el.t0 + ((el.t1 - el.t0) * i) / 20);
        if (svg.includes("clipPath") && svg.includes("stroke-dasharray")) {
          sawClip = true;
          break;
        }
      }
      expect(sawClip).toBe(true);
    } finally {
      setHandwritingFontPath(undefined);
    }
  });

  test("笔尖在字框范围内且区间外为 null", () => {
    const el = makeEl("白板");
    expect(el.pen!(0)).toBeNull();
    expect(el.pen!(el.t1 + 1)).toBeNull();
    for (const p of [0.1, 0.5, 0.9]) {
      const t = el.t0 + (el.t1 - el.t0) * p;
      const pen = el.pen!(t);
      expect(pen).not.toBeNull();
      const [x, y] = pen!;
      expect(x).toBeGreaterThanOrEqual(90);
      expect(x).toBeLessThanOrEqual(100 + 200 * 2 + 16 + 10);
      expect(y).toBeGreaterThanOrEqual(190);
      expect(y).toBeLessThanOrEqual(200 + 200 + 10);
    }
  });

  test("混排：非 CJK 字符走扫掠揭示（clip 矩形 + 字形轮廓或 text 回退）", () => {
    const el = makeEl("A白");
    const done = el.svg(el.t1 + 1);
    expect(done).toContain("clipPath"); // 扫掠揭示的 clip 矩形
    expect(done).toContain("<path d="); // 白的轮廓（及矢量化的 A）
  });

  test("t1 > t0 且时长随字数增长", () => {
    const one = makeEl("白");
    const three = makeEl("白板画");
    expect(one.t1).toBeGreaterThan(one.t0);
    expect(three.t1 - three.t0).toBeGreaterThan(one.t1 - one.t0);
  });
});

describe("escapeXmlText", () => {
  test("五字符全转义", () => {
    expect(escapeXmlText(`<a & "b" 'c'>`)).toBe(
      "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;",
    );
  });
});

describe("glyphs 矢量化回退", () => {
  test("有系统回退字体时非 CJK 输出矢量路径而非 <text>", async () => {
    const { glyphFont, glyphVector } = await import("./glyphs");
    if (glyphFont() === null) return; // 无候选字体的环境跳过
    const gv = glyphVector("A", 100);
    expect(gv).not.toBeNull();
    expect(gv!.d.length).toBeGreaterThan(10);
    expect(gv!.advance).toBeGreaterThan(20);
    // 同 key 缓存命中（引用相等）
    expect(glyphVector("A", 100)).toBe(gv!);
    const el = makeEl("A白");
    const done = el.svg(el.t1 + 1);
    expect(done).not.toContain("<text");
  });

  test("手写体+系统字体均不可用时回退 null 与 <text>", async () => {
    const { setGlyphFontPath, setHandwritingFontPath, glyphVector } =
      await import("./glyphs");
    setGlyphFontPath("/nonexistent/font.ttf");
    setHandwritingFontPath(null);
    try {
      expect(glyphVector("Z", 77)).toBeNull();
      const el = makeEl("Z白");
      expect(el.svg(el.t1 + 1)).toContain("<text");
    } finally {
      setGlyphFontPath(undefined);
      setHandwritingFontPath(undefined);
    }
  });
});

describe("遮罩揭示单调性（防书写闪烁回归）", () => {
  test("笔画完成后遮罩含轮廓+完整中线（书写中扫过的区域不回缩）", async () => {
    const { handwritingFont } = await import("./glyphs");
    if (handwritingFont() === null) return; // 无手写字体环境跳过
    const el = makeEl("白"); // 5 笔
    // 找一个"第 1 笔已完成、后续笔在写"的时刻：扫描中段帧
    let checked = 0;
    for (let i = 4; i < 19; i++) {
      const svg = el.svg(el.t0 + ((el.t1 - el.t0) * i) / 20);
      if (!svg.includes("<mask")) continue;
      // 完成笔画的遮罩段：轮廓 path 与相邻的无 dasharray 完整中线成对出现
      const donePairs = svg.match(
        /<path d="[^"]+" fill="#fff" stroke="#fff" stroke-width="\d+"\/><polyline points="[^"]+" fill="none" stroke="#fff" stroke-width="\d+" stroke-linecap="round" stroke-linejoin="round"\/>/g,
      );
      if (donePairs !== null && donePairs.length > 0) checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });
});

describe("拉丁字形像素级回归（resvg clip+transform 同元素坐标错位 bug）", () => {
  test("sweep 完成态的英文字母确实落墨（非隐形）", async () => {
    const { glyphVector } = await import("./glyphs");
    if (glyphVector("A", 100) === null) return; // 无任何矢量字体时跳过
    const { Resvg } = await import("@resvg/resvg-js");
    const el = hanziTextEl("AI", {
      x: 40,
      y: 40,
      size: 100,
      gap: 8,
      t0: 0,
      perChar: 0.4,
      color: "#000000",
      fontFamily: "PingFang SC",
      idp: "px",
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#ffffff"/>${el.svg(99)}</svg>`;
    const rendered = new Resvg(svg, {
      font: { loadSystemFonts: false },
    }).render();
    const rgba = rendered.pixels;
    let dark = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i]! < 128) dark++;
    }
    expect(dark).toBeGreaterThan(200); // 两个字母的墨迹像素
  });
});
