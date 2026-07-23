/**
 * @module @core/registry (publish)
 *
 * Publish registration (Workflow 3, FR-6.1): field validation → idempotence
 * scan → append to publish-log.jsonl.
 *
 * Boundary rules honored here:
 * - BR-U5-7 (Q3=A): idempotence key is (platform, url) — a duplicate
 *   registration is rejected with ValidationError, never silently ignored.
 * - BR-U5-11 (ADR-006): publish-log.jsonl is append-only.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { ValidationError } from "@core/errors";

import { appendJsonl, readJsonl } from "./jsonl";
import {
  PUBLISH_LOG_FILE,
  resolveDataRoot,
  type PublishEntry,
  type RegistryOptions,
} from "./types";

/** publish-log.jsonl path under the resolved data root. */
export function publishLogPath(options?: RegistryOptions): string {
  return join(resolveDataRoot(options), PUBLISH_LOG_FILE);
}

/**
 * Registers a manual publish (after human upload). Validates fields,
 * rejects duplicates on the (platform, url) key, then appends.
 *
 * @throws ValidationError on invalid fields or duplicate registration.
 * @throws IoError on data-plane read/write failure.
 */
export async function registerPublish(
  entry: PublishEntry,
  options?: RegistryOptions,
): Promise<void> {
  const violations: string[] = [];

  if (entry.platform !== "shipinhao" && entry.platform !== "douyin") {
    violations.push(
      `platform: 必须为 "shipinhao" 或 "douyin"（实际: ${JSON.stringify(entry.platform)}）`,
    );
  }
  if (
    typeof entry.publishedAt !== "string" ||
    Number.isNaN(Date.parse(entry.publishedAt))
  ) {
    violations.push(
      `publishedAt: 必须为合法 ISO 8601 时间（实际: ${JSON.stringify(entry.publishedAt)}）`,
    );
  }
  if (typeof entry.title !== "string" || entry.title.trim().length === 0) {
    violations.push("title: 不能为空");
  }
  if (typeof entry.url !== "string" || entry.url.trim().length === 0) {
    violations.push("url: 不能为空");
  }
  if (!isDirectory(entry.packageRef)) {
    violations.push(`packageRef: 目录不存在: ${entry.packageRef}`);
  }

  if (violations.length > 0) {
    throw new ValidationError(
      `发布登记字段校验失败（${violations.length} 处问题）:\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
  }

  // Idempotence scan (BR-U5-7, Q3=A): platform+url must be unique.
  const path = publishLogPath(options);
  const existing = await readJsonl<PublishEntry>(path);
  const duplicate = existing.find(
    (e) => e.platform === entry.platform && e.url === entry.url,
  );
  if (duplicate !== undefined) {
    throw new ValidationError(
      `已登记: (${entry.platform}, ${entry.url}) 于 ${duplicate.publishedAt}（幂等键 platform+url，重复登记拒绝）`,
    );
  }

  await appendJsonl(path, entry);
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
