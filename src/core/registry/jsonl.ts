/**
 * @module @core/registry (jsonl)
 *
 * Append-only JSONL helpers (ADR-006 / BR-U5-11): one JSON object per
 * line, files are NEVER rewritten — corrections are new lines, readers
 * merge by key taking the latest.
 *
 * readJsonl is tolerant of blank lines (hand-inspected files) but fails
 * loud on malformed JSON lines — every report number must trace back to a
 * parseable raw line (invariant 3), so silent skipping is not acceptable.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { IoError } from "@core/errors";

/**
 * Appends one record as a single JSON line (append-only; creates the
 * parent directory on first write).
 *
 * @throws IoError on write failure.
 */
export async function appendJsonl(
  path: string,
  record: unknown,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch (cause) {
    throw new IoError(`JSONL 追加写入失败: ${path}`, { cause });
  }
}

/**
 * Reads every record in file order (append order — later lines are newer).
 * A missing file yields `[]` (empty data plane, not an error); blank lines
 * are skipped.
 *
 * @throws IoError when a non-blank line is not valid JSON (line number in
 *         the message — data integrity over tolerance).
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const records: T[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue; // tolerant of blank lines
    try {
      records.push(JSON.parse(line) as T);
    } catch (cause) {
      throw new IoError(
        `JSONL 第 ${index + 1} 行不是合法 JSON: ${path}（数据完整性要求每行可解析）`,
        { cause },
      );
    }
  }
  return records;
}
