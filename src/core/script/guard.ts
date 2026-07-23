/**
 * @module @core/script (guard)
 *
 * Restricted-domain keyword guard (Workflow 2, C7 硬防线). Deterministic
 * keyword-table lookup — ZERO LLM involvement (ADR-002); the skills-side
 * LLM self-review is the first soft line, this table is the hard line.
 *
 * Boundary rules honored here:
 * - BR-U3-2: a hit rejects with DomainGuardError (exit code 4) and the
 *   caller produces zero artifacts (no script.md, no markStep).
 * - BR-U3-3: scan surface = topic + every segments[].text + cardText
 *   (emphasis excluded — it is a cardText substring by BR-U3-10).
 * - BR-U3-4: the keyword table lives in `assets/domain-guard.json`, never
 *   hardcoded (Q1=A); loaded once and cached per path.
 * - Fail closed: a missing/corrupt table file is an IoError — the guard
 *   must never silently pass.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DomainGuardError, IoError } from "@core/errors";

import type { DomainGuardTable, Script } from "./types";

/** Shipped keyword-table asset (packaged, version-controlled — BR-U3-4). */
export const DEFAULT_GUARD_TABLE_PATH = fileURLToPath(
  new URL("../../../assets/domain-guard.json", import.meta.url),
);

/** Per-path table cache (loaded once at first guard call). */
const tableCache = new Map<string, DomainGuardTable>();

/** Injectable seams for {@link guardDomain} (offline unit tests). */
export interface GuardDomainOptions {
  /** Keyword-table path. Default: the shipped asset. */
  tablePath?: string;
}

/**
 * Loads (and caches) the domain-guard keyword table.
 *
 * @throws IoError when the file is missing, unreadable, not valid JSON, or
 *         not shaped like {@link DomainGuardTable} — fail closed.
 */
export function loadGuardTable(
  tablePath: string = DEFAULT_GUARD_TABLE_PATH,
): DomainGuardTable {
  const cached = tableCache.get(tablePath);
  if (cached !== undefined) return cached;

  let table: DomainGuardTable;
  try {
    table = JSON.parse(readFileSync(tablePath, "utf8")) as DomainGuardTable;
  } catch (cause) {
    throw new IoError(
      `领域守卫词表加载失败: ${tablePath}。守卫不可静默放行（fail closed），请恢复 assets/domain-guard.json`,
      { cause },
    );
  }

  if (
    !Array.isArray(table.categories) ||
    table.categories.some(
      (c) =>
        typeof c.name !== "string" ||
        !Array.isArray(c.keywords) ||
        c.keywords.some((k) => typeof k !== "string" || k.length === 0),
    )
  ) {
    throw new IoError(
      `领域守卫词表结构非法: ${tablePath}（期望 { categories: [{ name, keywords[] }] }）。守卫不可静默放行（fail closed）`,
    );
  }

  tableCache.set(tablePath, table);
  return table;
}

/**
 * Restricted-domain guard (C7): case-insensitive substring scan of the
 * keyword table over topic + all segment text + cardText (BR-U3-3).
 * A plain string argument is treated as a bare topic.
 *
 * @throws DomainGuardError naming every hit category and its matched terms
 *         (exit code 4; caller must produce zero artifacts, BR-U3-2).
 * @throws IoError when the keyword table cannot be loaded (fail closed).
 */
export function guardDomain(
  scriptOrTopic: Script | string,
  options: GuardDomainOptions = {},
): void {
  const table = loadGuardTable(options.tablePath);

  const surfaces: string[] =
    typeof scriptOrTopic === "string"
      ? [scriptOrTopic]
      : [
          scriptOrTopic.topic,
          ...scriptOrTopic.segments.flatMap((seg) => [seg.text, seg.cardText]),
        ];
  const haystack = surfaces.join("\n").toLowerCase();

  const hits: Array<{ category: string; matchedTerms: string[] }> = [];
  for (const category of table.categories) {
    const matchedTerms = category.keywords.filter((keyword) =>
      haystack.includes(keyword.toLowerCase()),
    );
    if (matchedTerms.length > 0) {
      hits.push({ category: category.name, matchedTerms });
    }
  }

  if (hits.length > 0) {
    const detail = hits
      .map(
        (h) => `- 类别「${h.category}」命中词条: ${h.matchedTerms.join("、")}`,
      )
      .join("\n");
    throw new DomainGuardError(
      `内容命中严管领域（C7 红线），已拒绝，不产生任何产物:\n${detail}`,
    );
  }
}
