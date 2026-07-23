/**
 * @module cli/commands/register
 *
 * `vagent register add --platform --url --title --published-at --package`
 * — U5 registry delegation (发布登记, after HUMAN upload — the CLI never
 * publishes anything itself, BR-U6-7 / C13 红线).
 *
 * Field validation (platform enum, ISO time, packageRef dir) lives in
 * U5's registerPublish — this command only maps argv → PublishEntry.
 */

import {
  registerPublish,
  type Platform,
  type PublishEntry,
} from "@core/registry";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `register add`. */
export interface RegisterAddArgs {
  platform: string;
  url: string;
  title: string;
  publishedAt: string;
  package: string;
  /** Registry data plane override (tests). Default: $DATA_ROOT or ./data. */
  dataRoot?: string;
}

/**
 * Runs `register add` (U5 Workflow 3).
 *
 * @throws ValidationError bad fields or duplicate (platform, url) key.
 * @throws IoError data-plane write failure.
 */
export async function runRegisterAdd(
  args: RegisterAddArgs,
): Promise<CommandResult> {
  const entry: PublishEntry = {
    platform: args.platform as Platform, // enum validated by registerPublish
    publishedAt: args.publishedAt,
    title: args.title,
    url: args.url,
    packageRef: args.package,
  };
  await registerPublish(entry, { dataRoot: args.dataRoot });

  return {
    data: { entry },
    text:
      `✅ 已登记发布: (${entry.platform}) ${entry.url}\n` +
      "提示: 每周录入指标 vagent metrics add ...，满 4 周后可跑 vagent report baseline\n",
  };
}
