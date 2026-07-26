/**
 * 排拍与口播的同步测试。
 *
 * 这是观众唯一能一眼看出来的时间问题：板上的东西比讲解**早**出现（结论被剧透，
 * 再讲就成了复述），或者多拍挤在同一句里一次冒出来（讲第一句时板上突然多三条，
 * 后面一大段没东西可看）。
 *
 * 这两条都不会让任何命令失败——所以用测试钉住。
 */

import { describe, expect, test } from "bun:test";

import { beatTargets } from "./compose";
import type { Narration, SpokenLine } from "./narrate";

function line(offset: number, durationSec: number): SpokenLine {
  const narration: Narration = {
    path: `/tmp/n-${offset}.mp3`,
    text: "一句台词",
    durationSec,
    words: [],
  } as unknown as Narration;
  return { speaker: "旁白", voiceId: "v", narration, offset };
}

/** 四句台词，每句 5s（可排窗口是 20 × 0.82 = 16.4s）. */
const FOUR = [line(0, 5), line(5, 5), line(10, 5), line(15, 5)];

describe("beatTargets", () => {
  test("拍数与句数相等：每一拍贴住自己那句的句首", () => {
    expect(beatTargets(FOUR, 4, 20)).toEqual([0, 5, 10, 15]);
  });

  test("目标时刻单调不倒退（拍序与句序同向）", () => {
    for (const count of [1, 2, 3, 5, 7, 12]) {
      const t = beatTargets(FOUR, count, 20);
      for (let i = 1; i < t.length; i += 1) {
        expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]!);
      }
    }
  });

  test("拍多句少：同一句里的多拍在这句内均分，不是全堆在句首", () => {
    // 8 拍 4 句 → 每句 2 拍，第二拍落在这句中段
    const t = beatTargets(FOUR, 8, 20);
    expect(t[0]).toBeCloseTo(0, 5);
    expect(t[1]).toBeGreaterThan(0);
    expect(t[1]!).toBeLessThan(5);
    // 同一句的两拍不能是同一时刻（否则板上一次冒出两件东西）
    for (let i = 0; i + 1 < t.length; i += 1) {
      expect(t[i + 1]! - t[i]!).toBeGreaterThan(0);
    }
  });

  test("句多拍少：靠后的拍归到靠后的句子，绝不提前到上一句", () => {
    const t = beatTargets(FOUR, 2, 20);
    expect(t[0]).toBe(0);
    // 第二拍必须落在后半段的某个句首，不能被拉回第一句
    expect(t[1]!).toBeGreaterThanOrEqual(5);
  });

  test("每一拍都不早于它所属句子的句首（不剧透）", () => {
    const count = 9;
    const t = beatTargets(FOUR, count, 20);
    const starts = FOUR.map((l) => l.offset);
    for (const [i, at] of t.entries()) {
      const li = Math.min(
        starts.length - 1,
        Math.floor((i * starts.length) / count),
      );
      expect(at).toBeGreaterThanOrEqual(starts[li]! - 1e-9);
    }
  });

  test("所有目标都落在可排窗口内（末尾留白给运镜）", () => {
    const t = beatTargets(FOUR, 6, 20);
    for (const at of t) expect(at).toBeLessThan(20);
  });

  test("单句段退回均匀分布（没有句首可对齐）", () => {
    const t = beatTargets([line(0, 12)], 4, 12);
    expect(t[0]).toBe(0);
    expect(t[3]!).toBeGreaterThan(t[1]!);
  });

  test("零拍不报错", () => {
    expect(beatTargets(FOUR, 0, 20)).toEqual([]);
  });
});
