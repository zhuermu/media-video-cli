/**
 * @module cli/commands/whiteboard
 *
 * `vagent whiteboard render <article.md>` — 一篇 Markdown → 一条白板讲解视频。
 *
 * Boundary rules honored here:
 * - BR-U6-2: 进度诊断走 stderr（`toStderr` 注进流水线的 log 口），stdout 只
 *   留结果；`--json` 时 stdout 只有 JsonEnvelope。
 * - 渲染很贵（整片一万多帧、近一小时），所以 `--stills` 提供一个几秒出结果
 *   的目视复核档：先看版式对不对，再决定要不要渲整片。
 */

import { ValidationError } from "@core/errors";
import type { ArmMode, VideoKind } from "@core/whiteboard-video";
import {
  renderWhiteboardStills,
  renderWhiteboardVideo,
  toStderr,
} from "@core/whiteboard-video";
import type { WhiteboardVideoOptions } from "@core/whiteboard-video";

import type { CommandResult } from "../envelope";

/** 命令参数（与 parse.ts 的 route spec 一一对应）. */
export interface WhiteboardRenderArgs {
  article: string;
  kind?: string;
  out?: string;
  frames?: string;
  stills?: string;
  cache?: string;
  tag?: string;
  persona?: string;
  assets?: string;
  onlyStills: boolean;
  fresh: boolean;
  noBurn: boolean;
  arm?: string;
}

const KINDS = new Set<VideoKind>(["short", "long", "auto"]);
const ARM_MODES = new Set<ArmMode>(["cuff", "extend"]);

/** `--arm` 值域校验. */
function parseArmMode(raw: string | undefined): ArmMode | undefined {
  if (raw === undefined) return undefined;
  if (!ARM_MODES.has(raw as ArmMode)) {
    throw new ValidationError(
      `--arm 只接受 ${[...ARM_MODES].join(" | ")}，得到 "${raw}"`,
    );
  }
  return raw as ArmMode;
}

/** `--kind` 值域校验（错值要当场报，别渲一小时才发现选了错版式）. */
function parseKind(raw: string | undefined): VideoKind | undefined {
  if (raw === undefined) return undefined;
  if (!KINDS.has(raw as VideoKind)) {
    throw new ValidationError(
      `--kind 只接受 ${[...KINDS].join(" | ")}，得到 "${raw}"`,
    );
  }
  return raw as VideoKind;
}

/** 秒 → `m:ss`（成片时长报给人看，不是给机器算的）. */
function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function runWhiteboardRender(
  args: WhiteboardRenderArgs,
): Promise<CommandResult> {
  const opts: WhiteboardVideoOptions & { log: typeof toStderr } = {
    articlePath: args.article,
    burnSubtitles: !args.noBurn,
    fresh: args.fresh,
    log: toStderr,
  };
  const kind = parseKind(args.kind);
  if (kind !== undefined) opts.kind = kind;
  const arm = parseArmMode(args.arm);
  if (arm !== undefined) opts.armMode = arm;
  if (args.out !== undefined) opts.outDir = args.out;
  if (args.frames !== undefined) opts.framesDir = args.frames;
  if (args.stills !== undefined) opts.stillsDir = args.stills;
  if (args.cache !== undefined) opts.cacheDir = args.cache;
  if (args.tag !== undefined) opts.tag = args.tag;
  if (args.persona !== undefined) opts.persona = args.persona;
  // `--assets` 给的是**素材根**，两个库按约定的子目录名找
  if (args.assets !== undefined) {
    opts.assets = {
      hands: `${args.assets}/sparkol`,
      illustrations: `${args.assets}/manypixels`,
    };
  }

  if (args.onlyStills) {
    const files = await renderWhiteboardStills(opts);
    return {
      data: { stills: files },
      text: `${files.length} 张关键帧：\n${files.join("\n")}\n`,
    };
  }

  const r = await renderWhiteboardVideo(opts);
  return {
    data: { ...r },
    text:
      `${r.mp4}\n` +
      `字幕：${r.srt}\n` +
      `${r.width}×${r.height} ${r.kind === "long" ? "横版长教程" : "竖版短片"}，` +
      `${mmss(r.durationSec)}，${r.sections} 段，` +
      `${r.totalFrames} 帧（新渲 ${r.renderedFrames}，复用 ${r.reusedFrames}）\n`,
  };
}
