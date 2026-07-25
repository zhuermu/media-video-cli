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
// 只引轻量子模块（library/types），避免把 resvg/opentype 拉进校验链
import { LINE_ART_NAMES, STICKER_NAMES } from "@core/whiteboard/library";
import type { SceneElement, WhiteboardScene } from "@core/whiteboard/types";
import { SCENE_ELEMENTS_MAX, THEMES } from "@core/whiteboard/types";

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

  // style / theme（additive；缺省 cards 路径）
  let style: Script["style"];
  if (obj["style"] !== undefined) {
    if (obj["style"] !== "cards" && obj["style"] !== "whiteboard") {
      violations.push(
        `style: 必须为 "cards" 或 "whiteboard"（得到 ${JSON.stringify(obj["style"])}）`,
      );
    } else {
      style = obj["style"];
    }
  }
  let theme: string | undefined;
  if (obj["theme"] !== undefined) {
    if (!isNonEmptyString(obj["theme"]) || THEMES[obj["theme"]] === undefined) {
      violations.push(
        `theme: 未知白板主题 ${JSON.stringify(obj["theme"])}（可用: ${Object.keys(THEMES).join(", ")}）`,
      );
    } else {
      theme = obj["theme"];
    }
  }

  // whiteboard 风格：每段必须带 scene（cards 风格下 scene 被忽略并警告）
  if (style === "whiteboard") {
    for (const [i, segment] of segments.entries()) {
      if (segment.scene === undefined) {
        violations.push(
          `segments[${i}].scene: style="whiteboard" 时每段必须提供场景描述`,
        );
      }
    }
  } else if (segments.some((s) => s.scene !== undefined)) {
    warn('警告: 存在 segments[].scene 但 style 不是 "whiteboard"，将被忽略');
  }

  const script: Script = { title, topic, segments, source };
  if (style !== undefined) script.style = style;
  if (theme !== undefined) script.theme = theme;
  return script;
}

/**
 * 白板场景元素校验（shape + 名字表 + 文案长度；image 文件存在性在
 * compose 期检查——validateScript 无 workdir 上下文，同 backgroundImage）.
 */
function assertSceneShape(
  raw: unknown,
  at: string,
  violations: string[],
): WhiteboardScene | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    violations.push(`${at}: 必须为对象 { elements: [...] }`);
    return undefined;
  }
  const rawElements = (raw as Record<string, unknown>)["elements"];
  if (!Array.isArray(rawElements) || rawElements.length === 0) {
    violations.push(`${at}.elements: 必须为非空数组`);
    return undefined;
  }
  if (rawElements.length > SCENE_ELEMENTS_MAX) {
    violations.push(
      `${at}.elements: 元素数 ${rawElements.length} 超上限 ${SCENE_ELEMENTS_MAX}`,
    );
  }

  const elements: SceneElement[] = [];
  for (const [k, rawEl] of rawElements.entries()) {
    const el = assertSceneElement(rawEl, `${at}.elements[${k}]`, violations);
    if (el !== undefined) elements.push(el);
  }
  return { elements };
}

/** 手写文案长度断言辅助. */
function assertLen(
  value: string,
  max: number,
  at: string,
  violations: string[],
): void {
  if ([...value].length > max) {
    violations.push(`${at}: 超长 ${[...value].length} 字符（上限 ${max}）`);
  }
}

function assertSceneElement(
  raw: unknown,
  at: string,
  violations: string[],
): SceneElement | undefined {
  if (typeof raw !== "object" || raw === null) {
    violations.push(`${at}: 必须为对象 { type, ... }`);
    return undefined;
  }
  const el = raw as Record<string, unknown>;
  const type = el["type"];
  const C = SCRIPT_CONSTRAINTS;

  const label = el["label"];
  if (label !== undefined) {
    if (!isNonEmptyString(label)) {
      violations.push(`${at}.label: 必须为非空字符串`);
    } else {
      assertLen(label, C.sceneLabelMaxChars, `${at}.label`, violations);
    }
  }

  switch (type) {
    case "title":
    case "text":
    case "bullet": {
      if (!isNonEmptyString(el["text"])) {
        violations.push(`${at}.text: 必须为非空字符串`);
        return undefined;
      }
      const max = type === "title" ? C.sceneTitleMaxChars : C.sceneTextMaxChars;
      assertLen(el["text"], max, `${at}.text`, violations);
      if (type === "title") {
        const out: SceneElement = { type, text: el["text"] };
        if (el["underline"] !== undefined) {
          if (typeof el["underline"] !== "boolean") {
            violations.push(`${at}.underline: 必须为布尔值`);
          } else {
            out.underline = el["underline"];
          }
        }
        return out;
      }
      return { type, text: el["text"] };
    }
    case "icon": {
      if (
        !isNonEmptyString(el["name"]) ||
        !LINE_ART_NAMES.includes(el["name"])
      ) {
        violations.push(
          `${at}.name: 未知线稿元素 ${JSON.stringify(el["name"])}（可用: ${LINE_ART_NAMES.join(", ")}）`,
        );
        return undefined;
      }
      const out: SceneElement = { type, name: el["name"] };
      if (el["accent"] !== undefined) {
        if (typeof el["accent"] !== "boolean") {
          violations.push(`${at}.accent: 必须为布尔值`);
        } else {
          out.accent = el["accent"];
        }
      }
      if (isNonEmptyString(label)) out.label = label;
      return out;
    }
    case "chart": {
      const kind = el["chart"];
      if (kind !== "bars-up" && kind !== "line-up" && kind !== "steps") {
        violations.push(
          `${at}.chart: 必须为 "bars-up"/"line-up"/"steps"（得到 ${JSON.stringify(kind)}）`,
        );
        return undefined;
      }
      const out: SceneElement = { type, chart: kind };
      if (isNonEmptyString(label)) out.label = label;
      return out;
    }
    case "image": {
      const src = el["src"];
      if (!isNonEmptyString(src)) {
        violations.push(`${at}.src: 必须为非空字符串（图片路径）`);
        return undefined;
      }
      if (
        !C.backgroundImageExtensions.some((ext) =>
          src.toLowerCase().endsWith(ext),
        )
      ) {
        violations.push(
          `${at}.src: "${src}" 扩展名不支持（允许 ${C.backgroundImageExtensions.join("/")}；文件存在性在 compose 期检查）`,
        );
        return undefined;
      }
      const out: SceneElement = { type, src };
      if (el["circle"] !== undefined) {
        if (typeof el["circle"] !== "boolean") {
          violations.push(`${at}.circle: 必须为布尔值`);
        } else {
          out.circle = el["circle"];
        }
      }
      if (isNonEmptyString(label)) out.label = label;
      return out;
    }
    case "sticker": {
      if (
        !isNonEmptyString(el["name"]) ||
        !(STICKER_NAMES as readonly string[]).includes(el["name"])
      ) {
        violations.push(
          `${at}.name: 未知装饰件 ${JSON.stringify(el["name"])}（可用: ${STICKER_NAMES.join(", ")}）`,
        );
        return undefined;
      }
      return { type, name: el["name"] };
    }
    default:
      violations.push(
        `${at}.type: 未知元素类型 ${JSON.stringify(type)}（可用: title/text/bullet/icon/chart/image/sticker）`,
      );
      return undefined;
  }
}

/**
 * Per-segment assertions: text ≤300, cardText ≤80, emphasis ⊂ cardText,
 * backgroundImage 扩展名 ∈ {.jpg,.jpeg,.png}（存在性不在此查 —
 * validateScript 无 workdir 上下文，渲染期 frames.ts 负责）.
 */
function assertSegmentShape(
  raw: unknown,
  index: number,
  violations: string[],
): Segment {
  const at = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    violations.push(
      `${at}: 必须为对象 { text, cardText, emphasis?, backgroundImage? }`,
    );
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

  let backgroundImage: string | undefined;
  if (seg["backgroundImage"] !== undefined) {
    const rawBg = seg["backgroundImage"];
    if (!isNonEmptyString(rawBg)) {
      violations.push(`${at}.backgroundImage: 必须为非空字符串（图片路径）`);
    } else if (
      !SCRIPT_CONSTRAINTS.backgroundImageExtensions.some((ext) =>
        rawBg.toLowerCase().endsWith(ext),
      )
    ) {
      violations.push(
        `${at}.backgroundImage: "${rawBg}" 扩展名不支持` +
          `（允许 ${SCRIPT_CONSTRAINTS.backgroundImageExtensions.join("/")}；` +
          `文件存在性在渲染期检查）`,
      );
    } else {
      backgroundImage = rawBg;
    }
  }

  let scene: WhiteboardScene | undefined;
  if (seg["scene"] !== undefined) {
    scene = assertSceneShape(seg["scene"], `${at}.scene`, violations);
  }

  const segment: Segment = { text, cardText };
  if (emphasis !== undefined) segment.emphasis = emphasis;
  if (backgroundImage !== undefined) segment.backgroundImage = backgroundImage;
  if (scene !== undefined) segment.scene = scene;
  return segment;
}
