/**
 * @module cli/commands/report
 *
 * `vagent report weekly|baseline [--json]` — U5 registry delegation.
 * weekly: merge-latest 周报表 (display 层 null → 「无数据」, BR-U5-9);
 * baseline: 每平台 ≥4 周门槛 (InsufficientDataError → exit 10, BR-U5-10).
 */

import {
  baselineReport,
  weeklyReport,
  type BaselineReport,
} from "@core/registry";

import type { CommandResult } from "../envelope";

/** Shared argv surface of the report subcommands. */
export interface ReportArgs {
  /** Registry data plane override (tests). Default: $DATA_ROOT or ./data. */
  dataRoot?: string;
}

/** Runs `report weekly` — rows in data, rendered text table on stdout. */
export async function runReportWeekly(
  args: ReportArgs = {},
): Promise<CommandResult> {
  const table = await weeklyReport({ dataRoot: args.dataRoot });
  return { data: { rows: table.rows }, text: table.text };
}

/** Percent rendering for baseline stats (2 decimals). */
function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Text rendering of the baseline report (数据周数标注每平台独立). */
function renderBaseline(report: BaselineReport): string {
  const lines: string[] = [`# 基线报告（最小数据周数: ${report.weeks}）`, ""];
  for (const [platform, baseline] of Object.entries(report.perPlatform)) {
    lines.push(`## ${platform}（${baseline.weeks} 周数据）`);
    lines.push(
      `- 周粉丝增长: 中位 ${baseline.fansGrowth.median}` +
        `（${baseline.fansGrowth.min} ~ ${baseline.fansGrowth.max}）`,
      `- 周播放: 中位 ${baseline.views.median}` +
        `（${baseline.views.min} ~ ${baseline.views.max}）`,
      `- 互动率: 中位 ${percent(baseline.engagementRate.median)}` +
        `（${percent(baseline.engagementRate.min)} ~ ${percent(baseline.engagementRate.max)}）`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Runs `report baseline`.
 *
 * @throws InsufficientDataError when any platform has < 4 distinct weeks.
 */
export async function runReportBaseline(
  args: ReportArgs = {},
): Promise<CommandResult> {
  const report = await baselineReport({ dataRoot: args.dataRoot });
  return { data: report, text: renderBaseline(report) };
}
