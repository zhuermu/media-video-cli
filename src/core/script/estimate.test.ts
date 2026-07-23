/**
 * Tests for estimateDuration — formula snapshot (ceil(len/4.5) + 0.3s pause,
 * 0.1s precision), the 60/180s withinTarget boundaries, charsPerSec
 * override (BR-U3-8/Q2=A), and purity (repeat-call determinism, no input
 * mutation). Pure function — fully offline.
 */
import { describe, expect, test } from "bun:test";

import { estimateDuration, type Script } from "@core/script";

/** Builds a script whose segment texts have the given lengths. */
function scriptWithTextLengths(lengths: number[]): Script {
  return {
    title: "估算夹具",
    topic: "时长估算",
    segments: lengths.map((len) => ({
      text: "字".repeat(len),
      cardText: "要点",
    })),
    source: { kind: "topic", ref: "夹具" },
  };
}

describe("estimateDuration", () => {
  test("formula snapshot: ceil(len/4.5) + 0.3, total = Σ, 0.1 precision", () => {
    // ceil(9/4.5)=2 → 2.3; ceil(10/4.5)=3 → 3.3; ceil(1/4.5)=1 → 1.3
    const estimate = estimateDuration(scriptWithTextLengths([9, 10, 1]));
    expect(estimate).toEqual({
      total: 6.9,
      perSegment: [2.3, 3.3, 1.3],
      withinTarget: false,
    });
  });

  test("withinTarget boundaries: exactly 60s and 180s are inside", () => {
    // 10 segments: 9×(ceil=6 → 6.3) + 1×(ceil=3 → 3.3) = 60.0
    const at60 = estimateDuration(
      scriptWithTextLengths([...Array(9).fill(26), 12]),
    );
    expect(at60.total).toBe(60);
    expect(at60.withinTarget).toBe(true);

    // 10 segments: 9×(ceil=18 → 18.3) + 1×(ceil=15 → 15.3) = 180.0
    const at180 = estimateDuration(
      scriptWithTextLengths([...Array(9).fill(80), 66]),
    );
    expect(at180.total).toBe(180);
    expect(at180.withinTarget).toBe(true);
  });

  test("withinTarget boundaries: just below 60s and above 180s are outside", () => {
    // 10 segments: 9×6.3 + 1×(ceil=2 → 2.3) = 59.0
    const below = estimateDuration(
      scriptWithTextLengths([...Array(9).fill(26), 8]),
    );
    expect(below.total).toBe(59);
    expect(below.withinTarget).toBe(false);

    // 10 segments: 9×18.3 + 1×(ceil=16 → 16.3) = 181.0
    const above = estimateDuration(
      scriptWithTextLengths([...Array(9).fill(80), 70]),
    );
    expect(above.total).toBe(181);
    expect(above.withinTarget).toBe(false);
  });

  test("charsPerSec override changes the estimate (Q2=A configurable)", () => {
    const script = scriptWithTextLengths([9, 10, 1]);
    // ceil(9/9)=1 → 1.3; ceil(10/9)=2 → 2.3; ceil(1/9)=1 → 1.3
    expect(
      estimateDuration(script, { charsPerSec: 9, interSegmentPauseSec: 0.3 }),
    ).toEqual({ total: 4.9, perSegment: [1.3, 2.3, 1.3], withinTarget: false });
  });

  test("purity: repeat calls identical, input script untouched", () => {
    const script = scriptWithTextLengths([9, 10, 1]);
    const snapshot = structuredClone(script);
    expect(estimateDuration(script)).toEqual(estimateDuration(script));
    expect(script).toEqual(snapshot);
  });
});
