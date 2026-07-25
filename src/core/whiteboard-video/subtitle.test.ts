/**
 * @module core/whiteboard-video/subtitle.test
 *
 * 分行的回归网 —— 重点是**不许把一个词劈成两半**。
 *
 * 早先的硬切会切出 "需要 offline_ac" / "cess 才能拿到" 这种相邻两行：字幕
 * 一闪而过，观众得把两行拼起来才知道那是什么词。中文可以逐字断行，拉丁
 * 单词和标识符不行。
 */

import { describe, expect, test } from "bun:test";

import type { Narration } from "./narrate";
import { subtitleLines, toSrt } from "./subtitle";

/** 无词边界的口播（`timeAtChar` 会线性插值兜底）. */
function narration(text: string, durationSec = 10): Narration {
  return { text, path: "/tmp/x.mp3", durationSec, words: [] };
}

/** 相邻两行的拼接处是否劈开了一个词. */
function brokenWords(lines: readonly { text: string }[]): string[] {
  const bad: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const tail = /[0-9A-Za-z_$@#.\-+/]$/.exec(lines[i - 1]!.text);
    const head = /^[0-9A-Za-z_$@#.\-+/]/.exec(lines[i]!.text);
    if (tail !== null && head !== null) {
      bad.push(`${lines[i - 1]!.text} | ${lines[i]!.text}`);
    }
  }
  return bad;
}

describe("subtitleLines 不劈开单词", () => {
  test("长标识符不会被切在中间", () => {
    const n = narration(
      "必须签发 offline_access 才能拿到 refresh token 否则桌面端登录会直接失败",
    );
    const lines = subtitleLines(n, 0);
    expect(brokenWords(lines)).toEqual([]);
    expect(lines.some((l) => l.text.includes("offline_access"))).toBe(true);
  });

  test("无标点长句里的英文词整词保留", () => {
    const n = narration(
      "Issuer URL 必须带 v2.0 后缀否则会报 Invalid issuer 而控制台的 Authority URL 恰好没有这个后缀",
    );
    const lines = subtitleLines(n, 0);
    expect(brokenWords(lines)).toEqual([]);
  });

  test("中文可以逐字断行（不因为汉字相邻而挤出短行）", () => {
    const n = narration(
      "这是一段没有任何标点的很长的中文口播内容需要被切成好几行来显示",
    );
    const lines = subtitleLines(n, 0);
    // 除最后一行，每行都应该接近上限
    for (const l of lines.slice(0, -1)) {
      expect(l.text.length).toBeGreaterThan(14);
    }
  });

  test("整行是一个超长标识符时只能硬切（不死循环、不丢字）", () => {
    const long = "a".repeat(70);
    const lines = subtitleLines(narration(long), 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.text).join("")).toBe(long);
  });

  test("切在词间空格上时下一行不会顶着空格起头", () => {
    const n = narration(
      "public client PKCE S256 offline_access email claim 四条硬性要求缺一不可",
    );
    for (const l of subtitleLines(n, 0)) {
      expect(l.text).toBe(l.text.trim());
    }
  });
});

describe("subtitleLines 时间轴", () => {
  test("按 offset 平移到全片时间轴", () => {
    const lines = subtitleLines(narration("第一句话。第二句话。"), 12.5);
    expect(lines[0]!.t0).toBeGreaterThanOrEqual(12.5);
  });

  test("相邻行首尾相接（否则字幕会闪）", () => {
    const lines = subtitleLines(narration("第一句话。第二句话。第三句话。"), 0);
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]!.t1).toBeGreaterThanOrEqual(lines[i + 1]!.t0);
    }
  });

  test("最后一行盖到口播结束", () => {
    const lines = subtitleLines(narration("一句话。", 8), 0);
    expect(lines[lines.length - 1]!.t1).toBeGreaterThanOrEqual(8);
  });

  test("空文本不产出任何行", () => {
    expect(subtitleLines(narration(""), 0)).toEqual([]);
  });
});

describe("toSrt", () => {
  test("序号从 1 起、时间码是 HH:MM:SS,mmm", () => {
    const srt = toSrt([{ text: "测试", t0: 1.5, t1: 3.25 }]);
    expect(srt).toContain("1\n00:00:01,500 --> 00:00:03,250\n测试");
  });
});
