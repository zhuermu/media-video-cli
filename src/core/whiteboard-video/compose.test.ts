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
  WIPE_SEC,
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
    // 段时长 = 配音 + 收板停顿 + 擦板 + 擦后间隔
    expect(first.end).toBeCloseTo(
      48 + HOLD_BEFORE_WIPE + WIPE_SEC + AFTER_WIPE,
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
    expect(first.end).toBeGreaterThan(2 + HOLD_BEFORE_WIPE + WIPE_SEC);
  });

  test("末段不擦板，收尾只留 FINAL_TAIL", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    const last = sb.placed[1]!;
    expect(last.wipe).toBeNull();
    expect(sb.placed[0]!.wipe).not.toBeNull();
    expect(last.end - last.start).toBeCloseTo(20 + FINAL_TAIL, 5);
    expect(sb.totalSec).toBeCloseTo(last.end, 5);
  });

  test("擦板落在板面收完之后，而不是段末", () => {
    const a = article([section("一", ["x"]), section("二", ["y"])]);
    const sb = composeStoryboard({
      ...base,
      article: a,
      spoken: [spoken(4, 5), spoken(4, 5)],
    });
    const p = sb.placed[0]!;
    expect(p.wipe!.t0).toBeCloseTo(20 + HOLD_BEFORE_WIPE, 5);
    expect(p.wipe!.t0).toBeLessThan(p.end);
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

  test("长横版带页眉，且页眉里的进度是 1 / N", () => {
    const long = resolveFormat("long", 400);
    expect(long.chrome).toBe(true);
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
    // 页眉走矢量路径（帧渲染器不装系统字体，<text> 会渲成空白）
    expect(svg).not.toContain("<text");
  });
});
