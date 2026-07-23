/**
 * @module @core/pkg (frontmatter)
 *
 * Small tolerant YAML-frontmatter parser, implemented in-house (no new
 * dependencies — Mandated free-toolchain / exact-pin discipline). Only the
 * subset the metadata contract needs is supported:
 *
 * - a `---` delimited block at the very start of the file (CRLF tolerated)
 * - `key: value` scalars (optional single/double quotes)
 * - block lists (`- item` lines under a `key:`) and inline lists
 *   (`key: [a, b, c]`)
 *
 * Unknown keys are kept (tolerant), malformed lines are skipped (tolerant),
 * but a MISSING or unterminated frontmatter block is a hard problem the
 * callers turn into a violation (BR-U5-12 / 校验逻辑: frontmatter 解析失败
 * = 校验失败).
 */

/** Parsed metadata fields required by the contract (BR-U5-12). */
export interface MetadataFields {
  /** Exactly 3 candidate titles. */
  titles: string[];
  /** At least 1 tag. */
  tags: string[];
  /** Non-empty description. */
  description: string;
}

/** Strips one matching pair of surrounding quotes. */
function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parses `[a, "b", c]` into trimmed, unquoted items (empty items dropped). */
function parseInlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/**
 * Parses the frontmatter block at the start of `content`.
 *
 * @returns key → string | string[] map, or `null` when the file has no
 *          well-formed `---` block (missing opener or missing closer).
 */
export function parseFrontmatter(
  content: string,
): Record<string, string | string[]> | null {
  const lines = content.split(/\r?\n/);

  // Opener must be the first non-blank line.
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  if (start >= lines.length || lines[start]!.trim() !== "---") return null;

  // Find the closing delimiter.
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const result: Record<string, string | string[]> = {};
  let currentListKey: string | undefined;

  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Block-list item under the current key: `- item`
    const listItem = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (listItem !== null && currentListKey !== undefined) {
      const item = unquote(listItem[1]!);
      if (item.length > 0) {
        (result[currentListKey] as string[]).push(item);
      }
      continue;
    }

    // `key:` / `key: value` / `key: [a, b]`
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv === null) continue; // tolerant: skip malformed lines
    const key = kv[1]!;
    const rawValue = kv[2]!.trim();

    if (rawValue === "") {
      // Opens a block list (`titles:` followed by `- ...` lines).
      result[key] = [];
      currentListKey = key;
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = parseInlineList(rawValue);
      currentListKey = undefined;
    } else {
      result[key] = unquote(rawValue);
      currentListKey = undefined;
    }
  }

  return result;
}

/**
 * Extracts and checks the metadata contract fields from a parsed
 * frontmatter map: titles exactly 3, tags >= 1, description non-empty
 * (BR-U5-12). Shared by the assemble pre-flight and the validate layer-2
 * fallback so both enforce identical rules.
 *
 * @returns problems in Chinese (empty = compliant); `fields` is only
 *          present when there are no problems.
 */
export function extractMetadataFields(
  frontmatter: Record<string, string | string[]> | null,
): { fields?: MetadataFields; problems: string[] } {
  if (frontmatter === null) {
    return { problems: ["frontmatter 缺失或未闭合（需要成对的 --- 分隔行）"] };
  }

  const problems: string[] = [];

  const titles = frontmatter["titles"];
  if (!Array.isArray(titles)) {
    problems.push("titles: 必须为字符串列表");
  } else if (titles.length !== 3) {
    problems.push(
      `titles: 需恰好 3 条候选标题（实际 ${titles.length} 条，多不裁少不补）`,
    );
  }

  const tags = frontmatter["tags"];
  if (!Array.isArray(tags)) {
    problems.push("tags: 必须为字符串列表");
  } else if (tags.length < 1) {
    problems.push("tags: 需至少 1 条");
  }

  const description = frontmatter["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    problems.push("description: 必须为非空字符串");
  }

  if (problems.length > 0) return { problems };
  return {
    fields: {
      titles: titles as string[],
      tags: tags as string[],
      description: description as string,
    },
    problems: [],
  };
}
