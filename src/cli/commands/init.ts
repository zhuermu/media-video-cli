/**
 * @module cli/commands/init
 *
 * `vagent init <slug> --article|--topic` — U1 delegation (CommandSpec
 * v1.1 init row): argv 校验 → initVideo → 下一步提示.
 *
 * Boundary rules honored here:
 * - 校验逻辑: exactly one of --article/--topic (违规 → ValidationError +
 *   用法摘要); slug 格式复用 U1 规则 (initVideo 内部, BR-U1-1).
 * - BR-U6-3: 以显式参数独立运行, 结果与 skills 编排等价.
 */

import { initVideo, type InputRef } from "@core/workdir";
import { ValidationError } from "@core/errors";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `init`. */
export interface InitArgs {
  slug: string;
  article?: string;
  topic?: string;
  videosRoot?: string;
}

/**
 * Runs `init` (Workflow: CommandSpec → U1.initVideo).
 *
 * @throws ValidationError when not exactly one of --article/--topic is
 *         given, or from initVideo (bad slug, slug conflict, bad ref).
 * @throws NotFoundError when the article file does not exist.
 */
export async function runInit(args: InitArgs): Promise<CommandResult> {
  if ((args.article === undefined) === (args.topic === undefined)) {
    throw new ValidationError(
      "init 需要且仅需要 --article 或 --topic 之一\n" +
        "用法: vagent init <slug> --article <path.md> | --topic <文字>",
    );
  }
  const input: InputRef =
    args.article !== undefined
      ? { kind: "article", ref: args.article }
      : { kind: "topic", ref: args.topic! };

  const dir = await initVideo(args.slug, input, {
    videosRoot: args.videosRoot,
  });

  return {
    data: { slug: dir.slug, root: dir.root, input },
    text:
      `✅ 已初始化工作目录: ${dir.root}\n` +
      `下一步: 写入 script/script.json 后运行 vagent script validate ${dir.slug}\n`,
  };
}
