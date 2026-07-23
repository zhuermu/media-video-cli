/**
 * Offline tests for the growth registry (hermetic temp dataRoot per test):
 * publish idempotence key (BR-U5-7), ISO-Monday gate + correction semantics
 * (BR-U5-8), engagement-rate null semantics data vs display (BR-U5-9),
 * baseline >= 4 weeks gate + median/min-max + fansGrowth adjacent diffs
 * (BR-U5-10), append-only JSONL with blank-line tolerance (BR-U5-11).
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InsufficientDataError, IoError, ValidationError } from "@core/errors";
import {
  baselineReport,
  computeStat,
  metricsPath,
  publishLogPath,
  readJsonl,
  recordMetrics,
  registerPublish,
  weeklyReport,
  type PublishEntry,
  type WeeklyMetrics,
} from "@core/registry";

// ---- hermetic data roots ----------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mva-registry-test-"));
  tempRoots.push(root);
  return root;
}

/** A real directory usable as packageRef. */
function makePackageRef(): string {
  const root = makeDataRoot();
  const pkg = join(root, "package");
  mkdirSync(pkg);
  return pkg;
}

function entry(overrides: Partial<PublishEntry> = {}): PublishEntry {
  return {
    platform: "shipinhao",
    publishedAt: "2026-07-23T12:00:00+08:00",
    title: "测试标题",
    url: "https://example.com/v/1",
    packageRef: makePackageRef(),
    ...overrides,
  };
}

/** Mondays used across tests (2026-07-06/13/20/27 are ISO Mondays). */
const MON = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"] as const;

function metrics(overrides: Partial<WeeklyMetrics> = {}): WeeklyMetrics {
  return {
    platform: "shipinhao",
    weekStart: MON[0],
    followers: 100,
    views: 1000,
    likes: 30,
    comments: 15,
    shares: 5,
    ...overrides,
  };
}

// ---- registerPublish ----------------------------------------------------------

describe("registerPublish", () => {
  test("appends JSON lines; duplicate (platform, url) rejected; other platform same url ok (BR-U5-7)", async () => {
    const dataRoot = makeDataRoot();
    const first = entry();

    await registerPublish(first, { dataRoot });
    await expect(registerPublish(entry(), { dataRoot })).rejects.toThrow(
      /已登记/,
    );
    // Same url, other platform — different idempotence key, accepted.
    await registerPublish(entry({ platform: "douyin" }), { dataRoot });

    const lines = readFileSync(publishLogPath({ dataRoot }), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(first);
  });

  test("field validation: bad platform + empty url + missing packageRef dir in one itemized error", async () => {
    const dataRoot = makeDataRoot();
    expect.assertions(4);
    try {
      await registerPublish(
        entry({
          platform: "weibo" as PublishEntry["platform"],
          url: " ",
          packageRef: "/nonexistent/package",
        }),
        { dataRoot },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("platform");
      expect(message).toContain("url");
      expect(message).toContain("packageRef");
    }
  });
});

// ---- recordMetrics ------------------------------------------------------------

describe("recordMetrics", () => {
  test("weekStart must be an ISO Monday (BR-U5-8, Q4=A)", async () => {
    const dataRoot = makeDataRoot();

    // 2026-07-21 is a Tuesday; 2026-7-20 is malformed.
    await expect(
      recordMetrics(metrics({ weekStart: "2026-07-21" }), { dataRoot }),
    ).rejects.toThrow(/周一/);
    await expect(
      recordMetrics(metrics({ weekStart: "2026-7-20" }), { dataRoot }),
    ).rejects.toThrow(/周一/);
    await expect(
      recordMetrics(metrics({ views: -1 }), { dataRoot }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Monday accepted.
    await recordMetrics(metrics({ weekStart: MON[2] }), { dataRoot });
    const rows = await readJsonl<WeeklyMetrics>(metricsPath({ dataRoot }));
    expect(rows).toHaveLength(1);
  });

  test("duplicate key = correction append; readers take the latest (BR-U5-8/11)", async () => {
    const dataRoot = makeDataRoot();
    await recordMetrics(metrics({ views: 100 }), { dataRoot });
    await recordMetrics(metrics({ views: 200 }), { dataRoot }); // correction

    // Append-only: both lines survive on disk.
    const raw = await readJsonl<WeeklyMetrics>(metricsPath({ dataRoot }));
    expect(raw).toHaveLength(2);

    // Merge-latest: the report sees only the correction.
    const report = await weeklyReport({ dataRoot });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.views).toBe(200);
  });
});

// ---- weeklyReport ---------------------------------------------------------------

describe("weeklyReport", () => {
  test("engagement rate: locked formula; views===0 → null in data, 无数据 in display (BR-U5-9)", async () => {
    const dataRoot = makeDataRoot();
    await recordMetrics(
      metrics({
        weekStart: MON[0],
        views: 1000,
        likes: 30,
        comments: 15,
        shares: 5,
      }),
      { dataRoot },
    );
    await recordMetrics(metrics({ weekStart: MON[1], views: 0 }), { dataRoot });

    const report = await weeklyReport({ dataRoot });
    expect(report.rows[0]!.engagementRate).toBe((30 + 15 + 5) / 1000);
    expect(report.rows[1]!.engagementRate).toBeNull(); // never 0 or NaN
    expect(report.text).toContain("5.00%"); // percent, 2 decimals
    expect(report.text).toContain("无数据"); // display layer
  });

  test("week-over-week deltas with null propagation (BR-U5-9)", async () => {
    const dataRoot = makeDataRoot();
    await recordMetrics(
      metrics({ weekStart: MON[0], followers: 100, views: 0 }),
      { dataRoot },
    );
    await recordMetrics(
      metrics({ weekStart: MON[1], followers: 130, views: 2000 }),
      { dataRoot },
    );

    const report = await weeklyReport({ dataRoot });
    const [first, second] = report.rows;
    // First data week has no predecessor → all deltas null.
    expect(first!.followersDelta).toBeNull();
    expect(first!.viewsDelta).toBeNull();
    // Second week: numeric deltas, but rate delta propagates the null.
    expect(second!.followersDelta).toBe(30);
    expect(second!.viewsDelta).toBe(2000);
    expect(second!.engagementRateDelta).toBeNull(); // prev rate was null
  });
});

// ---- baselineReport ---------------------------------------------------------------

describe("baselineReport", () => {
  test("fewer than 4 distinct weeks → InsufficientDataError with context (BR-U5-10)", async () => {
    const dataRoot = makeDataRoot();
    for (const weekStart of MON.slice(0, 3)) {
      await recordMetrics(metrics({ weekStart }), { dataRoot });
    }

    expect.assertions(4);
    try {
      await baselineReport({ dataRoot });
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientDataError);
      const e = error as InsufficientDataError;
      expect(e.platform).toBe("shipinhao");
      expect(e.weeksFound).toBe(3);
      expect(e.weeksRequired).toBe(4);
    }
  });

  test("empty data plane → InsufficientDataError", async () => {
    const dataRoot = makeDataRoot();
    await expect(baselineReport({ dataRoot })).rejects.toBeInstanceOf(
      InsufficientDataError,
    );
  });

  test("median (odd fansGrowth diffs / even views) + min/max + adjacent-week diffs (BR-U5-10)", async () => {
    const dataRoot = makeDataRoot();
    const followers = [100, 110, 130, 160]; // diffs: 10, 20, 30 (odd count)
    const views = [1000, 4000, 2000, 3000]; // sorted: median (2000+3000)/2
    for (const [i, weekStart] of MON.entries()) {
      await recordMetrics(
        metrics({
          weekStart,
          followers: followers[i]!,
          views: views[i]!,
          likes: 10,
          comments: 0,
          shares: 0,
        }),
        { dataRoot },
      );
    }

    const report = await baselineReport({ dataRoot });
    expect(report.weeks).toBe(4);
    const baseline = report.perPlatform["shipinhao"]!;
    expect(baseline.weeks).toBe(4);
    expect(baseline.fansGrowth).toEqual({ median: 20, min: 10, max: 30 });
    expect(baseline.views).toEqual({ median: 2500, min: 1000, max: 4000 });
    // engagementRate stats over per-week (10/views) values.
    expect(baseline.engagementRate.min).toBe(10 / 4000);
    expect(baseline.engagementRate.max).toBe(10 / 1000);
  });

  test("computeStat: odd middle / even mean of middles", () => {
    expect(computeStat([5, 1, 3])).toEqual({ median: 3, min: 1, max: 5 });
    expect(computeStat([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, max: 4 });
  });
});

// ---- JSONL data plane ----------------------------------------------------------

describe("jsonl data plane", () => {
  test("readJsonl tolerates blank lines, fails loud on malformed JSON (BR-U5-11)", async () => {
    const dataRoot = makeDataRoot();
    const path = join(dataRoot, "metrics.jsonl");
    writeFileSync(path, `${JSON.stringify(metrics())}\n\n\n`);
    appendFileSync(path, `${JSON.stringify(metrics({ weekStart: MON[1] }))}\n`);

    const rows = await readJsonl<WeeklyMetrics>(path);
    expect(rows).toHaveLength(2);

    appendFileSync(path, "not-json\n");
    await expect(readJsonl(path)).rejects.toBeInstanceOf(IoError);
  });
});
