/**
 * @module cli/commands/persona
 *
 * `vagent persona show` — 把作者人设吐给调用方（默认人读摘要，`--json` 给结构）。
 *
 * skills 在写文案之前读它：口吻、选题、禁区、术语英文保留清单、CTA、署名都在这里，
 * 不需要把这些规则抄进 SKILL.md（抄过去的那份会和 `assets/persona/` 漂移，而漂移的
 * 表现是同一个号出现两种口吻）。
 *
 * Boundary rules honored here:
 * - BR-U6-2: 结果走 stdout；本命令零写入。
 * - 人设文件缺失不是错误（不署名），但要在 stderr 说明，别让调用方以为读到了。
 */

import { loadPersona } from "@core/persona";
import type { Persona } from "@core/persona";

import type { CommandResult } from "../envelope";

/** 人读摘要（分节输出，便于人核对；机器读走 --json）. */
function render(persona: Persona): string {
  const section = (title: string, items: readonly string[]): string =>
    `${title}\n${items.map((i) => `  · ${i}`).join("\n")}\n\n`;
  return (
    `笔名: ${persona.penName}\n` +
    `简介: ${persona.bio}\n\n` +
    section("身份线:", persona.career) +
    section("擅长话题:", persona.topics) +
    section("口吻:", persona.tone) +
    section("术语保留英文（不译名）:", persona.keepEnglish) +
    section("不碰的题材（硬红线见 domain-guard 词表）:", persona.avoid) +
    section("关注引导候选（第一条用于片内签名行）:", persona.cta) +
    `片内签名字样: ${persona.signature}\n` +
    `口播主讲默认音色: ${persona.defaultVoice}\n`
  );
}

/** Runs `persona show`（纯读）. */
export function runPersonaShow(
  seams: { path?: string; warn?: (message: string) => void } = {},
): CommandResult {
  const persona = loadPersona(seams.path);
  if (persona === undefined) {
    const warn = seams.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
    warn("未配置人设（assets/persona/ermu.json 不存在）→ 不署名、不写 CTA");
    return {
      data: { configured: false },
      text: "未配置人设：发布包不会写 author 块，白板视频不会画签名\n",
    };
  }
  return {
    data: { configured: true, ...persona },
    text: render(persona),
  };
}
