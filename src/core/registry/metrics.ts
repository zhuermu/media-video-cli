/**
 * @module @core/registry (metrics)
 *
 * Weekly metrics recording and reporting (Workflow 4, FR-6.2/6.3).
 *
 * Boundary rules honored here:
 * - BR-U5-8 (Q4=A): weekStart must be an ISO Monday date; a duplicate
 *   (platform, weekStart) is a CORRECTION — appended, readers take the
 *   latest line (append-only correction semantics).
 * - BR-U5-9 (FR-6.2): engagementRate = (likes+comments+shares)/views;
 *   views === 0 → null at the DATA layer (never 0/NaN); the DISPLAY layer
 *   renders null as 「无数据」. Week-over-week deltas propagate null.
 * - BR-U5-10 (FR-6.3): baseline needs >= 4 distinct weeks per platform
 *   (InsufficientDataError otherwise); stats are median + min/max;
 *   fansGrowth = adjacent-week followers diff.
 * - BR-U5-11 (ADR-006): metrics.jsonl is append-only.
 */

import { join } from "node:path";

import { InsufficientDataError, ValidationError } from "@core/errors";

import { appendJsonl, readJsonl } from "./jsonl";
import {
  BASELINE_WEEKS_REQUIRED,
  METRICS_FILE,
  resolveDataRoot,
  type BaselineReport,
  type Platform,
  type PlatformBaseline,
  type RegistryOptions,
  type ReportTable,
  type Stat,
  type WeeklyMetrics,
  type WeeklyReportRow,
} from "./types";

/** metrics.jsonl path under the resolved data root. */
export function metricsPath(options?: RegistryOptions): string {
  return join(resolveDataRoot(options), METRICS_FILE);
}

/** Numeric metric fields validated as finite and >= 0. */
const METRIC_FIELDS = [
  "followers",
  "views",
  "likes",
  "comments",
  "shares",
] as const;

/**
 * Returns true when `date` (YYYY-MM-DD) is an ISO Monday. Computed in UTC
 * from the date string itself — immune to the local timezone (reliable
 * weekday derivation, BR-U5-8).
 */
export function isIsoMonday(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip guard: rejects overflow dates like 2026-02-31.
  if (parsed.toISOString().slice(0, 10) !== date) return false;
  return parsed.getUTCDay() === 1;
}

/**
 * Records one weekly metrics row (manual entry). A repeated
 * (platform, weekStart) is a correction: appended as a new line, readers
 * merge-latest (BR-U5-8).
 *
 * @throws ValidationError on non-Monday weekStart, bad platform, or
 *         negative/non-finite metric values.
 * @throws IoError on data-plane write failure.
 */
export async function recordMetrics(
  metrics: WeeklyMetrics,
  options?: RegistryOptions,
): Promise<void> {
  const violations: string[] = [];

  if (metrics.platform !== "shipinhao" && metrics.platform !== "douyin") {
    violations.push(
      `platform: 必须为 "shipinhao" 或 "douyin"（实际: ${JSON.stringify(metrics.platform)}）`,
    );
  }
  if (!isIsoMonday(metrics.weekStart)) {
    violations.push(
      `weekStart: 必须为 ISO 周一日期 YYYY-MM-DD（实际: ${JSON.stringify(metrics.weekStart)}，Q4=A）`,
    );
  }
  for (const field of METRIC_FIELDS) {
    const value = metrics[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      violations.push(
        `${field}: 必须为 >= 0 的数字（实际: ${JSON.stringify(value)}）`,
      );
    }
  }

  if (violations.length > 0) {
    throw new ValidationError(
      `周指标录入校验失败（${violations.length} 处问题）:\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
  }

  await appendJsonl(metricsPath(options), metrics);
}

/**
 * Data-layer engagement rate (BR-U5-9, locked formula):
 * (likes+comments+shares)/views; views === 0 → null — null is a DATA
 * value, 0 or NaN must never stand in for it.
 */
export function engagementRate(m: WeeklyMetrics): number | null {
  if (m.views === 0) return null;
  return (m.likes + m.comments + m.shares) / m.views;
}

/** Display-layer rendering: null → 无数据; number → percent, 2 decimals. */
function renderRate(rate: number | null): string {
  return rate === null ? "无数据" : `${(rate * 100).toFixed(2)}%`;
}

/** Display-layer rendering for signed deltas: null → 无数据. */
function renderDelta(delta: number | null): string {
  if (delta === null) return "无数据";
  return delta >= 0 ? `+${delta}` : String(delta);
}

/** Percentage-point delta rendering: null → 无数据. */
function renderRateDelta(delta: number | null): string {
  if (delta === null) return "无数据";
  const points = (delta * 100).toFixed(2);
  return delta >= 0 ? `+${points}pp` : `${points}pp`;
}

/**
 * Merge-latest over the raw append-only lines: for each
 * (platform, weekStart) key the LAST line wins (correction semantics,
 * BR-U5-8). Returns rows sorted platform → weekStart ascending.
 */
function mergeLatest(records: WeeklyMetrics[]): WeeklyMetrics[] {
  const byKey = new Map<string, WeeklyMetrics>();
  for (const record of records) {
    byKey.set(`${record.platform}\u0000${record.weekStart}`, record);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.weekStart.localeCompare(b.weekStart),
  );
}

/**
 * Weekly report (FR-6.2): merge-latest rows with engagement rates and
 * week-over-week deltas (vs the previous DATA week per platform), plus the
 * rendered text table. Null semantics per BR-U5-9.
 */
export async function weeklyReport(
  options?: RegistryOptions,
): Promise<ReportTable> {
  const merged = mergeLatest(
    await readJsonl<WeeklyMetrics>(metricsPath(options)),
  );

  const rows: WeeklyReportRow[] = [];
  const previousByPlatform = new Map<Platform, WeeklyReportRow>();
  for (const m of merged) {
    const rate = engagementRate(m);
    const prev = previousByPlatform.get(m.platform);
    const row: WeeklyReportRow = {
      platform: m.platform,
      weekStart: m.weekStart,
      followers: m.followers,
      views: m.views,
      engagementRate: rate,
      followersDelta: prev === undefined ? null : m.followers - prev.followers,
      viewsDelta: prev === undefined ? null : m.views - prev.views,
      engagementRateDelta:
        prev === undefined || prev.engagementRate === null || rate === null
          ? null // null propagation (环比遇 null 同样「无数据」)
          : rate - prev.engagementRate,
    };
    rows.push(row);
    previousByPlatform.set(m.platform, row);
  }

  const lines = [
    "| 平台 | 周起始 | 粉丝 | 粉丝环比 | 播放 | 播放环比 | 互动率 | 互动率环比 |",
    "|------|--------|------|----------|------|----------|--------|------------|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.platform} | ${row.weekStart} | ${row.followers} | ` +
        `${renderDelta(row.followersDelta)} | ${row.views} | ` +
        `${renderDelta(row.viewsDelta)} | ${renderRate(row.engagementRate)} | ` +
        `${renderRateDelta(row.engagementRateDelta)} |`,
    );
  }
  if (rows.length === 0) {
    lines.push("| （无指标数据） | — | — | — | — | — | — | — |");
  }

  return { rows, text: `${lines.join("\n")}\n` };
}

/** median (odd → middle; even → mean of the two middles) + min/max. */
export function computeStat(values: number[]): Stat {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

/**
 * Baseline report (FR-6.3): per platform present in the data plane —
 * requires >= 4 distinct weeks each; fansGrowth = adjacent-week followers
 * diff (sorted week order); engagementRate stats over non-null values
 * only (null weeks carry no data, they are excluded — never zero-filled).
 *
 * @throws InsufficientDataError when a platform has < 4 distinct weeks
 *         (context: platform, weeksFound, weeksRequired), or when the data
 *         plane is empty.
 */
export async function baselineReport(
  options?: RegistryOptions,
): Promise<BaselineReport> {
  const merged = mergeLatest(
    await readJsonl<WeeklyMetrics>(metricsPath(options)),
  );

  if (merged.length === 0) {
    throw new InsufficientDataError(
      `基线报告需要每平台至少 ${BASELINE_WEEKS_REQUIRED} 个不同周的数据；当前无任何指标数据`,
      { platform: "*", weeksFound: 0, weeksRequired: BASELINE_WEEKS_REQUIRED },
    );
  }

  const byPlatform = new Map<Platform, WeeklyMetrics[]>();
  for (const m of merged) {
    const list = byPlatform.get(m.platform) ?? [];
    list.push(m); // already sorted weekStart ascending per mergeLatest
    byPlatform.set(m.platform, list);
  }

  const perPlatform: Record<string, PlatformBaseline> = {};
  let minWeeks = Number.POSITIVE_INFINITY;

  for (const [platform, weeks] of byPlatform) {
    if (weeks.length < BASELINE_WEEKS_REQUIRED) {
      throw new InsufficientDataError(
        `平台 ${platform} 仅有 ${weeks.length} 个不同周的数据，基线需要 >= ${BASELINE_WEEKS_REQUIRED} 周（FR-6.3）`,
        {
          platform,
          weeksFound: weeks.length,
          weeksRequired: BASELINE_WEEKS_REQUIRED,
        },
      );
    }

    // fansGrowth: adjacent-week followers diff over the sorted weeks.
    const fansGrowth: number[] = [];
    for (let i = 1; i < weeks.length; i += 1) {
      fansGrowth.push(weeks[i]!.followers - weeks[i - 1]!.followers);
    }

    const rates = weeks
      .map((w) => engagementRate(w))
      .filter((r): r is number => r !== null);

    perPlatform[platform] = {
      weeks: weeks.length,
      fansGrowth: computeStat(fansGrowth),
      views: computeStat(weeks.map((w) => w.views)),
      engagementRate: computeStat(rates),
    };
    minWeeks = Math.min(minWeeks, weeks.length);
  }

  return { weeks: minWeeks, perPlatform };
}
