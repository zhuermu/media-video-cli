/**
 * @module core/persona
 *
 * 作者人设 —— **一份数据，三个消费点**。
 *
 * 1. skills 写作时注入（口吻 / 选题 / 禁区 / 术语英文保留清单）；
 * 2. `package assemble` 写进 `manifest.author`（署名 + 关注引导文案）；
 * 3. 白板视频收尾在画布角落手写签名与 CTA。
 *
 * 做成数据而不是散写在三处文案里，是因为这三处**必须一致**：片尾署名叫「二木」、
 * 发布包作者写别的名字、skill 又用第三种口吻，观众看到的是三个人。一致性靠人肉
 * 同步维持不住，靠一个文件才行。
 *
 * ## 加载语义：缺文件是合法的，缺字段不是
 *
 * - 文件不存在 → `undefined`。人设是**可选**的：没有它只是不署名、不写 CTA，
 *   渲染与打包照常。让一个可选素材决定流水线能不能跑是错的（音效清单同款语义）。
 * - 文件存在但字段缺失 / `cta` 为空 / `keepEnglish` 为空 / JSON 坏 →
 *   `ValidationError`，逐条列出问题。既然作者显式配了人设，就说明他要署名；此时
 *   静默用默认值会让成片署上一个他没写过的名字。
 *
 * Boundary rules honored here:
 * - core 层：只抛类型化错误，从不 `process.exit`。
 * - I/O 收敛在 {@link loadPersona} 一处，其余为纯函数。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ValidationError } from "@core/errors";

/** 随仓库分发的默认人设文件（可以不存在——不署名）. */
export const DEFAULT_PERSONA_PATH = fileURLToPath(
  new URL("../../../assets/persona/ermu.json", import.meta.url),
);

/** 一份人设（全部字段必填；见模块注释的加载语义）. */
export interface Persona {
  /** 笔名（署名与 CTA 里出现的那个名字）. */
  penName: string;
  /** 一句话简介（发布包 author.bio / 平台简介）. */
  bio: string;
  /** 身份线（从哪来、现在做什么）. */
  career: string[];
  /** 擅长话题（选题依据）. */
  topics: string[];
  /** 口吻规则（写作时逐条遵守）. */
  tone: string[];
  /** term of art 保留英文清单（不译名，见 ermu.md 的理由）. */
  keepEnglish: string[];
  /** 不碰的题材（写作侧提醒；硬红线是 domain-guard 词表）. */
  avoid: string[];
  /** 关注引导文案候选；`cta[0]` 用于片内那一行. */
  cta: string[];
  /** 片内手写签名字样. */
  signature: string;
  /** 口播主讲默认音色 id（文章显式 cast 优先）. */
  defaultVoice: string;
}

/** 必填的字符串字段. */
const STRING_FIELDS = ["penName", "bio", "signature", "defaultVoice"] as const;
/** 必填的非空字符串数组字段. */
const LIST_FIELDS = [
  "career",
  "topics",
  "tone",
  "keepEnglish",
  "avoid",
  "cta",
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 校验一个已解析的对象是不是完整人设（纯函数，便于测试与直接注入）。
 *
 * @throws ValidationError 逐条列出所有问题（不是遇到第一个就返回——配一次人设
 *         要改三处字段时，一次报全比来回试三遍便宜）.
 */
export function parsePersona(raw: unknown, source: string): Persona {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`人设文件不是一个 JSON 对象: ${source}`);
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];

  for (const field of STRING_FIELDS) {
    if (!isNonEmptyString(obj[field])) {
      problems.push(`${field} 必须是非空字符串`);
    }
  }
  for (const field of LIST_FIELDS) {
    const value = obj[field];
    if (!Array.isArray(value) || value.length === 0) {
      problems.push(`${field} 必须是非空数组`);
      continue;
    }
    if (!value.every((item) => isNonEmptyString(item))) {
      problems.push(`${field} 的每一项都必须是非空字符串`);
    }
  }

  if (problems.length > 0) {
    throw new ValidationError(
      `人设文件字段不合法（${problems.length} 处）: ${source}\n` +
        problems.map((p) => `- ${p}`).join("\n"),
    );
  }

  return {
    penName: obj["penName"] as string,
    bio: obj["bio"] as string,
    career: obj["career"] as string[],
    topics: obj["topics"] as string[],
    tone: obj["tone"] as string[],
    keepEnglish: obj["keepEnglish"] as string[],
    avoid: obj["avoid"] as string[],
    cta: obj["cta"] as string[],
    signature: obj["signature"] as string,
    defaultVoice: obj["defaultVoice"] as string,
  };
}

/**
 * 加载人设。文件不存在 → `undefined`（合法：不署名）。
 *
 * @throws ValidationError JSON 解析失败或字段不合法.
 */
export function loadPersona(
  path: string = DEFAULT_PERSONA_PATH,
): Persona | undefined {
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new ValidationError(
      `人设文件不是合法 JSON: ${path}（${(cause as Error).message}）`,
      { cause },
    );
  }
  return parsePersona(raw, path);
}

/** 发布包 `manifest.author` 那一块（可选字段，见 core/pkg）. */
export interface PersonaAuthor {
  pen_name: string;
  bio: string;
  cta: string;
}

/** 人设 → manifest 的 author 块（CTA 取第一条候选）. */
export function authorBlock(persona: Persona): PersonaAuthor {
  return {
    pen_name: persona.penName,
    bio: persona.bio,
    cta: persona.cta[0]!,
  };
}
