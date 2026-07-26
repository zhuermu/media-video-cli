/**
 * @module core/whiteboard-video/compose.test
 *
 * 排片与版式的回归网。
 *
 * 为什么值得写：整片渲染要近一小时，而版式/排片的回归**只有渲完才看得见**。
 * 这里用假的配音数据（不联网、不碰 TTS）把时间轴算出来，断言那几条实测踩过
 * 坑的规则；再对关键帧的 SVG 取哈希 —— 几何是确定性的（无 `Math.random`），
 * 所以哈希变了就意味着画面变了，改动是否有意就要当场说清楚。
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { Article, Section } from "./article";
import {
  AFTER_WIPE,
  FINAL_TAIL,
  HOLD_BEFORE_WIPE,
  AFTER_PAN,
  OVERVIEW_HOLD,
  PAN_SEC,
  ZOOM_OUT_SEC,
  beatTargets,
  composeStoryboard,
  shiftEl,
} from "./compose";
import type { SpokenSection } from "./compose";
import { resolveFormat } from "./format";
import type { GestureEl, HandKit } from "./gestures";
import type { Narration, SpokenLine } from "./narrate";
import { frameSvgFactory } from "./render";

/** 不带手势素材的空四件套：排片逻辑不依赖手的像素，测试也就不该依赖磁盘. */
const NO_HANDS: HandKit = {
  persona: "test",
  write: null,
  erase: null,
  carry: null,
  point: null,
};

function narration(text: string, durationSec: number): Narration {
  return { text, path: `/tmp/${text}.mp3`, durationSec, words: [] };
}

function line(text: string, offset: number, durationSec: number): SpokenLine {
  return {
    speaker: "旁白",
    voiceId: "narrator-male-lively",
    narration: narration(text, durationSec),
    offset,
  };
}

/** 一段配音：句子等长顺排. */
function spoken(count: number, each: number): SpokenSection {
  const lines: SpokenLine[] = [];
  for (let i = 0; i < count; i++) lines.push(line(`句${i}`, i * each, each));
  return { lines, durationSec: count * each };
}

function section(title: string, bullets: string[]): Section {
  return {
    title,
    bullets,
    cues: bullets.map((b) => ({ speaker: "旁白", text: b })),
  };
}

function article(sections: Section[]): Article {
  return {
    title: "测试文章",
    sections,
    cast: { 旁白: "narrator-male-lively" },
    kind: "short",
    castAuthored: false,
    signature: true,
  };
}

/** 一个最小可平移元素（只关心时间语义，不关心画什么）. */
function stubEl(t0: number, t1: number): GestureEl {
  return {
    t0,
    t1,
    bbox: [0, 0, 10, 10],
    svg: (t) => `<g data-t="${t.toFixed(3)}"/>`,
    pen: (t) => [t, 0] as const,
    penSpan: [t0, t0 + (t1 - t0) / 2],
  };
}

describe("beatTargets", () => {
  test("只用旁白前 82%：最后一拍不会顶到旁白末尾", () => {
    const s = spoken(4, 5); // 20s
    const targets = beatTargets(s.lines, 4, s.durationSec);
    for (const t of targets) expect(t).toBeLessThanOrEqual(20 * 0.82);
  });

  test("每一拍贴到最近的句首，而不是均匀摊开", () => {
    const s = spoken(4, 5); // 句首在 0 / 5 / 10 / 15
    const targets = beatTargets(s.lines, 3, s.durationSec);
    // 均匀目标是 0 / 5.47 / 10.93，吸附后应落在真实句首上
    for (const t of targets) {
      expect([0, 5, 10, 15]).toContain(t);
    }
  });

  test("句子不足两句时退回均匀分布", () => {
    const one: SpokenLine[] = [line("独句", 0, 12)];
    const targets = beatTargets(one, 3, 12);
    expect(targets).toEqual([0, (1 / 3) * 12 * 0.82, (2 / 3) * 12 * 0.82]);
  });

  test("句首全部落在窗口之外时也退回均匀分布（不会返回空）", () => {
    const late: SpokenLine[] = [line("a", 9, 1), line("b", 9.5, 1)];
    const targets = beatTargets(late, 2, 10);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toBe(0);
  });
});

describe("shiftEl", () => {
  test("平移前返回空画面、笔为空", () => {
    const el = shiftEl(stubEl(0, 2), 10);
    expect(el.svg(5)).toBe("");
    expect(el.pen!(5)).toBeNull();
    expect(el.t0).toBe(10);
    expect(el.t1).toBe(12);
  });

  test("右端点必须给出笔位姿——即使 (t1+shift)-shift 浮点上大于 t1", () => {
    // 真实场景：penPoseAt 拿元素自己宣称的 t1 去问位姿，并对结果强制解包。
    // 0.1 + 0.2 = 0.30000000000000004，减回 0.2 得 0.10000000000000003 > 0.1
    // —— 只按"局部时间是否越界"判空的写法会在这里返回 null，然后崩。
    const shift = 0.2;
    const el = shiftEl(stubEl(0, 0.1), shift);
    expect(el.t1 - shift).toBeGreaterThan(0.1); // 前提成立：确实溢出了
    expect(el.pen!(el.t1)).not.toBeNull();
  });

  test("区间之外仍然返回空（元素只为自己宣称的区间负责）", () => {
    const el = shiftEl(stubEl(0, 2), 10);
    expect(el.pen!(9.9)).toBeNull();
    expect(el.pen!(12.5)).toBeNull();
  });

  test("penSpan 一起平移", () => {
    const el = shiftEl(stubEl(0, 4), 7);
    expect(el.penSpan).toEqual([7, 9]);
  });

  test("跨过右端点之后笔离开", () => {
    const el = shiftEl(stubEl(0, 2), 10);
    expect(el.pen!(12.5)).toBeNull();
  });
});

describe("composeStoryboard 排片", () => {
  const format = resolveFormat("short", 30);
  const base = {
    format,
    kit: NO_HANDS,
    ink: "#222",
    accent: "#c00",
    illustrationsDir: "/nonexistent",
  };

  test("旁白比板面长时，段时长听旁白的", () => {
    const a = article([section("一段", ["短"]), section("二段", ["短"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(6, 8), spoken(6, 8)], // 每段 48s，板面远短于此
    });
    const first = sb.placed[0]!;
    expect(first.start).toBe(0);
    // 段时长 = 配音 + 收板停顿 + 段间平移 + 平移后间隔（无限画布不再擦板）
    expect(first.end).toBeCloseTo(
      48 + HOLD_BEFORE_WIPE + PAN_SEC + AFTER_PAN,
      5,
    );
  });

  test("板面比旁白长时，段尾补静音（不压缩笔速）", () => {
    const many = section("要点很多", ["一", "二", "三", "四", "五", "六"]);
    const sb = composeStoryboard({
      ...base,
      article: article([many, section("尾", ["短"])]),
      spoken: [spoken(1, 2), spoken(1, 2)], // 只有 2s 旁白
    });
    const first = sb.placed[0]!;
    expect(first.end).toBeGreaterThan(2 + HOLD_BEFORE_WIPE + PAN_SEC);
  });

  test("无限画布：任何一段都不擦板，末段之后接拉远全景", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    const last = sb.placed[1]!;
    // 讲过的内容留在板上，所以没有任何一段带擦板元素
    for (const p of sb.placed) expect(p.wipe).toBeNull();
    expect(last.end - last.start).toBeCloseTo(20 + FINAL_TAIL, 5);
    // 全片在末段之后还要留出拉远 + 全景停留
    expect(sb.totalSec).toBeCloseTo(last.end + ZOOM_OUT_SEC + OVERVIEW_HOLD, 5);
  });

  test("段间平移落在板面收完之后，而不是段末", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    // 第一次平移（camMoves[0]）应当从"板面收完 + 停顿"起算，且落在第一段内
    const pan = sb.camMoves[0]!;
    expect(pan.t0).toBeCloseTo(20 + HOLD_BEFORE_WIPE, 5);
    expect(pan.t0).toBeLessThan(sb.placed[0]!.end);
    expect(pan.t1 - pan.t0).toBeCloseTo(PAN_SEC, 5);
  });

  test("每段在画布上各占一格，格子互不重叠", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    expect(sb.cells).toHaveLength(2);
    const [c0, c1] = sb.cells as [(typeof sb.cells)[0], (typeof sb.cells)[0]];
    const overlap =
      c0.x < c1.x + c1.w &&
      c0.x + c0.w > c1.x &&
      c0.y < c1.y + c1.h &&
      c0.y + c0.h > c1.y;
    expect(overlap).toBe(false);
  });

  test("收尾一定有一次拉远（视野变大）", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    const zoom = sb.camMoves[sb.camMoves.length - 1]!;
    expect(zoom.to[2]).toBeGreaterThan(zoom.from[2]);
  });

  test("每段的元素都被平移到该段起点之后", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    const second = sb.placed[1]!;
    for (const el of second.els) {
      expect(el.t0).toBeGreaterThanOrEqual(second.start);
    }
  });

  test("板书摊到旁白上，不是开头一口气画完", () => {
    // 这是"拍式排版"要挡住的回归：早先一段旁白 30s、板面 14s 就画完了，
    // 剩下 16s 观众盯着一块不动的板子（全片 7 分钟里有 5 分钟静止画面）。
    const a = article([section("一", ["甲", "乙", "丙"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(6, 5)],
    });
    const starts = sb.placed[0]!.els.map((e) => e.t0);
    const lastBeat = Math.max(...starts);
    expect(lastBeat).toBeGreaterThan(30 * 0.4);
    // 也不该越过留白窗口顶到旁白末尾
    expect(lastBeat).toBeLessThanOrEqual(30 * 0.82);
  });

  test("插画库路径不存在时退化成纯文字，而不是抛异常", () => {
    const s = section("有插画", ["要点"]);
    s.illustration = ["nonexistent", "query"];
    const sb = composeStoryboard({
      ...base,
      article: article([s]),
      spoken: [spoken(2, 3)],
    });
    expect(sb.illustrations).toHaveLength(0);
    expect(sb.placed).toHaveLength(1);
  });
});

describe("收尾署名", () => {
  const format = resolveFormat("short", 30);
  const base = {
    format,
    kit: NO_HANDS,
    ink: "#222",
    accent: "#c00",
    illustrationsDir: "/nonexistent",
  };
  const persona = {
    penName: "二木",
    bio: "简介",
    career: ["c"],
    topics: ["LLM"],
    tone: ["t"],
    keepEnglish: ["prompt"],
    avoid: ["财经"],
    cta: ["关注二木 · 聊大模型落地"],
    signature: "二木",
    defaultVoice: "narrator-male-steady",
  };
  const two = [section("一", ["x"]), section("二", ["y"])];

  test("给了人设：拉远之后写签名 + CTA，并落一个 sparkle 点位", () => {
    const withSig = composeStoryboard({
      ...base,
      article: article(two),
      spoken: [spoken(2, 3), spoken(2, 3)],
      persona,
    });
    const withoutSig = composeStoryboard({
      ...base,
      article: article(two),
      spoken: [spoken(2, 3), spoken(2, 3)],
    });
    // 签名挂在 links（画布空间、不参与按格剔除），所以比不署名时多两件
    expect(withSig.links.length).toBe(withoutSig.links.length + 2);
    expect(withSig.sfxCues.sparkle.length).toBe(
      withoutSig.sfxCues.sparkle.length + 1,
    );
  });

  test("落笔在拉远窗口之内，写完之前不结束成片", () => {
    const sb = composeStoryboard({
      ...base,
      article: article(two),
      spoken: [spoken(2, 3), spoken(2, 3)],
      persona,
    });
    const zoomOut = sb.camMoves[sb.camMoves.length - 1]!;
    const startAt = sb.sfxCues.sparkle[sb.sfxCues.sparkle.length - 1]!;
    expect(startAt).toBeGreaterThanOrEqual(zoomOut.t0);
    expect(startAt).toBeLessThanOrEqual(zoomOut.t1);
    // 成片结尾必须晚于最后一笔（早先按全景停留时长收尾，CTA 被截掉半句）
    const lastInk = Math.max(...sb.links.map((el) => el.t1));
    expect(sb.totalSec).toBeGreaterThan(lastInk);
  });

  test("> signature: off 时不画；没人设时也不画", () => {
    const off = composeStoryboard({
      ...base,
      article: { ...article(two), signature: false },
      spoken: [spoken(2, 3), spoken(2, 3)],
      persona,
    });
    const noPersona = composeStoryboard({
      ...base,
      article: article(two),
      spoken: [spoken(2, 3), spoken(2, 3)],
    });
    expect(off.links.length).toBe(noPersona.links.length);
    expect(off.sfxCues.sparkle.length).toBe(noPersona.sfxCues.sparkle.length);
  });
});

describe("关键帧快照", () => {
  /**
   * 帧的 SVG 哈希。
   *
   * 断言的是"画面没有意外变化"，不是"画面正确"——正确性靠目视复核关键帧。
   * 哈希变了要么是有意改版式（更新期望值），要么是回归（去查）。
   */
  function frameHash(svg: string): string {
    return createHash("sha256").update(svg).digest("hex").slice(0, 16);
  }

  const a = article([section("第一段标题", ["要点甲", "要点乙"])]);
  const sb = composeStoryboard({
    article: a,
    spoken: [spoken(3, 4)],
    format: resolveFormat("short", 12),
    kit: NO_HANDS,
    ink: "#22262b",
    accent: "#c8483a",
    illustrationsDir: "/nonexistent",
  });
  const frameSvg = frameSvgFactory({
    storyboard: sb,
    format: resolveFormat("short", 12),
    kit: NO_HANDS,
    title: a.title,
    ink: "#22262b",
    accent: "#c8483a",
    burnSubtitles: false,
  });

  test("同一时刻两次渲染完全一致（确定性）", () => {
    expect(frameHash(frameSvg(3))).toBe(frameHash(frameSvg(3)));
  });

  test("时间推进画面就变（板书是逐步长出来的）", () => {
    const hashes = [0.5, 3, 6, 9].map((t) => frameHash(frameSvg(t)));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("每帧都是完整闭合的 SVG 文档", () => {
    for (const t of [0, 1.5, 5, sb.totalSec - 0.1]) {
      const svg = frameSvg(t);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    }
  });

  test("竖版短片是 1080×1920，且没有页眉", () => {
    const svg = frameSvg(1);
    expect(svg).toContain('width="1080" height="1920"');
    expect(resolveFormat("short", 12).chrome).toBe(false);
  });

  test("横版帧是 1920×1080，画布层带镜头变换，且不再有翻页式页眉", () => {
    const long = resolveFormat("long", 400);
    const twoSec = article([section("甲", ["1"]), section("乙", ["2"])]);
    const lsb = composeStoryboard({
      article: twoSec,
      spoken: [spoken(2, 3), spoken(2, 3)],
      format: long,
      kit: NO_HANDS,
      ink: "#22262b",
      accent: "#c8483a",
      illustrationsDir: "/nonexistent",
    });
    const svg = frameSvgFactory({
      storyboard: lsb,
      format: long,
      kit: NO_HANDS,
      title: twoSec.title,
      ink: "#22262b",
      accent: "#c8483a",
      burnSubtitles: false,
    })(1);
    expect(svg).toContain('width="1920" height="1080"');
    // 一切文字走矢量路径（帧渲染器不装系统字体，<text> 会渲成空白）
    expect(svg).not.toContain("<text");
    // 内容在画布层里，带镜头变换——这是无限画布与"一页一屏"的分界
    expect(svg).toContain('<g transform="translate(');
    expect(svg).toContain("scale(");
  });
});
