/**
 * @module @core/registry (types)
 *
 * Growth-registry types: locked contracts (component-methods.md —
 * PublishEntry / WeeklyMetrics / BaselineReport / Stat) plus the
 * ReportTable shape referenced by the weeklyReport signature (field set
 * defined here — not locked upstream).
 *
 * Deviation note (additive, FR-6.3 "输出含数据周数标注（每平台独立）"):
 * the locked BaselineReport.perPlatform value gains a `weeks` field so the
 * per-platform data-week annotation has a home. No locked field changed.
 */

/** Publishing platforms (locked enum). */
export type Platform = "shipinhao" | "douyin";

/** One publish-log entry (locked fields). Idempotence key: platform+url. */
export interface PublishEntry {
  platform: Platform;
  /** ISO 8601 publish timestamp. */
  publishedAt: string;
  title: string;
  url: string;
  /** Publish-package directory reference. */
  packageRef: string;
}

/** One weekly metrics record (locked fields). weekStart: ISO Monday. */
export interface WeeklyMetrics {
  platform: Platform;
  /** ISO Monday date, YYYY-MM-DD (BR-U5-8, Q4=A). */
  weekStart: string;
  followers: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/** median + range (locked fields, FR-6.3). */
export interface Stat {
  median: number;
  min: number;
  max: number;
}

/** Per-platform baseline stats (+ additive weeks annotation, FR-6.3). */
export interface PlatformBaseline {
  /** Distinct data weeks for this platform (每平台独立标注). */
  weeks: number;
  /** Weekly follower growth = adjacent-week followers diff. */
  fansGrowth: Stat;
  views: Stat;
  engagementRate: Stat;
}

/** Baseline report (locked shape + additive per-platform weeks). */
export interface BaselineReport {
  /** Smallest distinct-week count across reported platforms. */
  weeks: number;
  perPlatform: Record<string, PlatformBaseline>;
}

/**
 * One weekly report row (merged-latest per platform+week). Data-layer null
 * semantics (FR-6.2 / BR-U5-9): `engagementRate` is null when views === 0
 * — never 0 or NaN; deltas are null when no previous week or a null rate
 * is involved (null propagation).
 */
export interface WeeklyReportRow {
  platform: Platform;
  weekStart: string;
  followers: number;
  views: number;
  /** (likes+comments+shares)/views; views===0 → null (数据层语义). */
  engagementRate: number | null;
  /** Week-over-week absolute change vs the previous data week. */
  followersDelta: number | null;
  viewsDelta: number | null;
  /** Percentage-point change; null propagates (BR-U5-9). */
  engagementRateDelta: number | null;
}

/** weeklyReport result: structured rows + rendered text table (display). */
export interface ReportTable {
  rows: WeeklyReportRow[];
  /** Text table; null values render as 「无数据」 (展示层语义). */
  text: string;
}

/** Registry data-plane location (JSONL files live under dataRoot). */
export interface RegistryOptions {
  /** Data directory. Default: $DATA_ROOT or ./data (config defaults). */
  dataRoot?: string;
}

/** publish-log file name inside dataRoot. */
export const PUBLISH_LOG_FILE = "publish-log.jsonl";

/** metrics file name inside dataRoot. */
export const METRICS_FILE = "metrics.jsonl";

/** Baseline gate: distinct weeks required per platform (FR-6.3). */
export const BASELINE_WEEKS_REQUIRED = 4;

/** Resolves the registry data root (explicit param > env > default). */
export function resolveDataRoot(options?: RegistryOptions): string {
  return options?.dataRoot ?? process.env["DATA_ROOT"] ?? "./data";
}
