/**
 * @module cli/commands/metrics
 *
 * `vagent metrics add --platform --week --followers --views --likes
 * --comments --shares` — U5 registry delegation (周指标人工录入).
 *
 * Numeric parsing is strict here (empty string → NaN, not 0); value-range
 * validation (>= 0, finite) and the ISO-Monday gate live in U5's
 * recordMetrics (BR-U5-8).
 */

import {
  recordMetrics,
  type Platform,
  type WeeklyMetrics,
} from "@core/registry";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `metrics add` (all flags arrive as strings). */
export interface MetricsAddArgs {
  platform: string;
  week: string;
  followers: string;
  views: string;
  likes: string;
  comments: string;
  shares: string;
  /** Registry data plane override (tests). Default: $DATA_ROOT or ./data. */
  dataRoot?: string;
}

/** Strict numeric parse: blank → NaN (rejected downstream), never 0. */
function toNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/**
 * Runs `metrics add` (U5 Workflow 4 recording half).
 *
 * @throws ValidationError bad platform/weekStart/metric values (itemized).
 * @throws IoError data-plane write failure.
 */
export async function runMetricsAdd(
  args: MetricsAddArgs,
): Promise<CommandResult> {
  const metrics: WeeklyMetrics = {
    platform: args.platform as Platform, // enum validated by recordMetrics
    weekStart: args.week,
    followers: toNumber(args.followers),
    views: toNumber(args.views),
    likes: toNumber(args.likes),
    comments: toNumber(args.comments),
    shares: toNumber(args.shares),
  };
  await recordMetrics(metrics, { dataRoot: args.dataRoot });

  return {
    data: { metrics },
    text: `✅ 已录入周指标: (${metrics.platform}) 周起始 ${metrics.weekStart}\n`,
  };
}
