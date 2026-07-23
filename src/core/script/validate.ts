/**
 * @module @core/script (validate)
 *
 * script.json schema validation (Workflow 1): file → JSON → field-by-field
 * assertions against the SCRIPT_CONSTRAINTS table → validated Script.
 *
 * Boundary rules honored here:
 * - BR-U3-1: violations are collected into ONE ValidationError listing every
 *   problem (one per line) — never fail-fast on the first field, so the
 *   review loop fixes everything in a single pass.
 * - BR-U3-5: topic >500 chars is truncated to 500 with a warning — NOT a
 *   rejection (FR-1 AC-3).
 * - BR-U3-10: every emphasis entry must be a substring of its cardText
 *   (U4 highlight positioning safety).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { NotFoundError, ValidationError } from "@core/errors";

import { SCRIPT_CONSTRAINTS, type Script, type Segment } from "./types";

/** Injectable seams for {@link validateScript} (offline unit tests). */
export interface ValidateScriptOptions {
  /** Warning sink for non-rejecting issues (BR-U3-5). Default: stderr. */
  warn?: (message: string) => void;
}

/**
 * Validates `script/script.json` against the locked Script schema and the
 * SCRIPT_CONSTRAINTS table, returning the parsed (and possibly
 * topic-truncated, BR-U3-5) Script.
 *
 * @throws NotFoundError when the file does not exist.
 * @throws ValidationError when the file is not valid JSON, or with the full
 *         itemized violations list (BR-U3-1, one per line).
 */
export async function validateScript(
  path: string,
  options: ValidateScriptOptions = {},
): Promise<Script> {
  const { warn = (message: string) => console.error(message) } = options;

  if (!existsSync(path)) {
    throw new NotFoundError(`script.json 不存在: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ValidationError(`script.json 不是合法 JSON: ${path}`, { cause });
  }

  const violations: string[] = [];
  const script = assertScriptShape(raw, violations, warn);

  if (violations.length > 0) {
    throw new ValidationError(
      `script.json 校验失败（${violations.length} 处问题，请一并修正后重跑）:\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
  }
  return script;
}

/** Non-empty-string helper: returns true when value is a usable string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Field-by-field assertions (SCRIPT_CONSTRAINTS table). Collects every
 * violation instead of stopping at the first one (BR-U3-1). Returns the
 * (topic-truncated) Script — only meaningful when `violations` stays empty.
 */
function assertScriptShape(
  raw: unknown,
  violations: string[],
  warn: (message: string) => void,
): Script {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    violations.push("根节点必须是 JSON 对象");
    return {
      title: "",
      topic: "",
      segments: [],
      source: { kind: "topic", ref: "" },
    };
  }
  const obj = raw as Record<string, unknown>;

  // title: 非空，≤60 字符
  let title = "";
  if (!isNonEmptyString(obj["title"])) {
    violations.push("title: 必须为非空字符串");
  } else {
    title = obj["title"];
    if (title.length > SCRIPT_CONSTRAINTS.titleMaxChars) {
      violations.push(
        `title: 超长 ${title.length} 字符（上限 ${SCRIPT_CONSTRAINTS.titleMaxChars}）`,
      );
    }
  }

  // topic: 非空；>500 截断+警告（BR-U3-5，不拒绝）
  let topic = "";
  if (!isNonEmptyString(obj["topic"])) {
    violations.push("topic: 必须为非空字符串");
  } else {
    topic = obj["topic"];
    if (topic.length > SCRIPT_CONSTRAINTS.topicMaxChars) {
      warn(
        `警告: topic 超长 ${topic.length} 字符，已截断至 ` +
          `${SCRIPT_CONSTRAINTS.topicMaxChars} 字符（BR-U3-5，不拒绝）`,
      );
      topic = topic.slice(0, SCRIPT_CONSTRAINTS.topicMaxChars);
    }
  }

  // segments: 数组，3-20 段
  const segments: Segment[] = [];
  if (!Array.isArray(obj["segments"])) {
    violations.push("segments: 必须为数组");
  } else {
    const rawSegments = obj["segments"] as unknown[];
    if (rawSegments.length < SCRIPT_CONSTRAINTS.segmentsMin) {
      violations.push(
        `segments: 段数 ${rawSegments.length} 少于下限 ${SCRIPT_CONSTRAINTS.segmentsMin}（FR-1 AC-1）`,
      );
    }
    if (rawSegments.length > SCRIPT_CONSTRAINTS.segmentsMax) {
      violations.push(
        `segments: 段数 ${rawSegments.length} 超过上限 ${SCRIPT_CONSTRAINTS.segmentsMax}`,
      );
    }
    for (const [i, rawSegment] of rawSegments.entries()) {
      segments.push(assertSegmentShape(rawSegment, i, violations));
    }
  }

  // source: kind ∈ {article, topic}，ref 非空（追溯用）
  let source: Script["source"] = { kind: "topic", ref: "" };
  const rawSource = obj["source"];
  if (typeof rawSource !== "object" || rawSource === null) {
    violations.push("source: 必须为对象 { kind, ref }");
  } else {
    const src = rawSource as Record<string, unknown>;
    const kind = src["kind"];
    if (kind !== "article" && kind !== "topic") {
      violations.push(
        `source.kind: 必须为 "article" 或 "topic"（得到 ${JSON.stringify(kind)}）`,
      );
    }
    if (!isNonEmptyString(src["ref"])) {
      violations.push("source.ref: 必须为非空字符串（素材来源追溯）");
    }
    source = {
      kind: kind === "article" ? "article" : "topic",
      ref: isNonEmptyString(src["ref"]) ? src["ref"] : "",
    };
  }

  return { title, topic, segments, source };
}

/** Per-segment assertions: text ≤300, cardText ≤80, emphasis ⊂ cardText. */
function assertSegmentShape(
  raw: unknown,
  index: number,
  violations: string[],
): Segment {
  const at = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    violations.push(`${at}: 必须为对象 { text, cardText, emphasis? }`);
    return { text: "", cardText: "" };
  }
  const seg = raw as Record<string, unknown>;

  let text = "";
  if (!isNonEmptyString(seg["text"])) {
    violations.push(`${at}.text: 必须为非空字符串`);
  } else {
    text = seg["text"];
    if (text.length > SCRIPT_CONSTRAINTS.textMaxChars) {
      violations.push(
        `${at}.text: 超长 ${text.length} 字符（上限 ${SCRIPT_CONSTRAINTS.textMaxChars}/段）`,
      );
    }
  }

  let cardText = "";
  if (!isNonEmptyString(seg["cardText"])) {
    violations.push(`${at}.cardText: 必须为非空字符串`);
  } else {
    cardText = seg["cardText"];
    if (cardText.length > SCRIPT_CONSTRAINTS.cardTextMaxChars) {
      violations.push(
        `${at}.cardText: 超长 ${cardText.length} 字符（上限 ${SCRIPT_CONSTRAINTS.cardTextMaxChars}）`,
      );
    }
  }

  let emphasis: string[] | undefined;
  if (seg["emphasis"] !== undefined) {
    if (
      !Array.isArray(seg["emphasis"]) ||
      seg["emphasis"].some((e) => typeof e !== "string")
    ) {
      violations.push(`${at}.emphasis: 必须为字符串数组`);
    } else {
      emphasis = seg["emphasis"] as string[];
      for (const term of emphasis) {
        if (!cardText.includes(term)) {
          violations.push(
            `${at}.emphasis: "${term}" 不是 cardText 的子串（BR-U3-10，U4 高亮定位）`,
          );
        }
      }
    }
  }

  return emphasis === undefined
    ? { text, cardText }
    : { text, cardText, emphasis };
}
