/**
 * @module cli/commands/compose
 *
 * `vagent compose run <slug>` — Workflow 3 (compose 装配: 文件契约→端口
 * 纯值的桥): 前置 stepDone(script+tts) → loadTemplate → renderCards →
 * RenderJob 装配 (v1.1 修正案装配点) → FfmpegComposeBackend.compose →
 * markStep("compose").
 *
 * Boundary rules honored here:
 * - 校验逻辑: frames 与 durations 的段数一致性由 renderCards 断言
 *   (BR-U4-6); RenderJob 防御断言在 backend 内 (BR-U4-12 表).
 * - BR-U4-6: segmentDurations 只来自 durations.json 实测值.
 * - Template resolution: config.cardTemplate 名 → 与默认模板同目录的
 *   assets/templates/<name>.json.
 */

import { dirname, join } from "node:path";

import {
  DEFAULT_TEMPLATE_PATH,
  loadTemplate,
  renderCards,
  type RenderCardsOptions,
} from "@core/cards";
import { loadConfig, type AppConfig } from "@core/config";
import { IoError, ValidationError } from "@core/errors";
import {
  FfmpegComposeBackend,
  type RenderBackend,
  type RenderJob,
} from "@core/render";
import { validateScript } from "@core/script";
import { durationsPath, MERGED_FILE, readDurations } from "@core/tts";
import { load, markStep, stepDone } from "@core/workdir";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `compose run`. */
export interface ComposeRunArgs {
  slug: string;
  videosRoot?: string;
}

/** Injectable seams for offline tests. */
export interface ComposeRunSeams {
  /** Pre-resolved config (skips loadConfig + ffmpeg probe). */
  config?: AppConfig;
  /** Template file override (default: assets/templates/<config 名>.json). */
  templatePath?: string;
  /** Render backend override. Default: real FfmpegComposeBackend. */
  backend?: RenderBackend;
  /** Rasterizer seam passed through to renderCards. */
  rasterizeFn?: RenderCardsOptions["rasterizeFn"];
  /** Warning sink (template warnings). Default: stderr. */
  warn?: (message: string) => void;
}

/**
 * Runs `compose run` (Workflow 3, the file-contract → port-value bridge).
 *
 * @throws ValidationError missing前置步骤, template problems, or RenderJob
 *         assertion/probe self-check failures from the backend.
 * @throws IoError durations.json unreadable, or stepDone invariant breach.
 * @throws RenderError / FfmpegError from U4 delegation.
 */
export async function runComposeRun(
  args: ComposeRunArgs,
  seams: ComposeRunSeams = {},
): Promise<CommandResult> {
  const dir = await load(args.slug, { videosRoot: args.videosRoot });

  for (const step of ["script", "tts"] as const) {
    if (!stepDone(dir, step)) {
      throw new ValidationError(
        `步骤 ${step} 未完成: compose 前置要求 script 与 tts 均已完成` +
          `（请先运行对应命令；当前 slug: ${args.slug}）`,
      );
    }
  }

  const config = seams.config ?? (await loadConfig());
  const warn = seams.warn ?? console.error;

  // Template: config 名 → shipped assets/templates/<name>.json sibling.
  const templatePath =
    seams.templatePath ??
    join(dirname(DEFAULT_TEMPLATE_PATH), `${config.cardTemplate}.json`);
  const { template, warnings } = loadTemplate(templatePath);
  for (const warning of warnings) warn(`模板警告: ${warning}`);

  const script = await validateScript(join(dir.paths.script, "script.json"));
  const durations = await readDurations(dir);
  if (durations === undefined) {
    throw new IoError(
      `durations.json 读取失败: ${durationsPath(dir)}` +
        "（先运行 tts run，或用 --rebuild-state 检查状态）",
    );
  }

  // U4: frames.json 生成（幂等跳过已有帧, BR-U4-10）.
  const frames = await renderCards(
    script,
    durations.perSegment,
    template,
    dir,
    { rasterizeFn: seams.rasterizeFn },
  );

  // v1.1 修正案装配点: 文件契约 → RenderJob 端口纯值.
  const job: RenderJob = {
    frames,
    audioTrack: join(dir.paths.audio, MERGED_FILE),
    segmentDurations: durations.perSegment,
    subtitleText: script.segments.map((segment) => segment.text),
    output: {
      path: join(dir.paths.video, "video.mp4"),
      width: 1080,
      height: 1920,
      fps: 30,
    },
  };

  const backend =
    seams.backend ??
    new FfmpegComposeBackend({ ffmpegPath: config.ffmpegPath });
  const result = await backend.compose(job);

  await markStep(dir, "compose", {
    durationSec: result.durationSec,
    width: result.probe.width,
    height: result.probe.height,
    frames: frames.length,
  });

  return {
    step: "compose",
    data: {
      videoPath: result.path,
      durationSec: result.durationSec,
      width: result.probe.width,
      height: result.probe.height,
      frames: frames.length,
    },
    text:
      `✅ 视频合成完成（${result.durationSec.toFixed(1)}s，` +
      `${result.probe.width}×${result.probe.height}）: ${result.path}\n` +
      `下一步: 准备 metadata 五件后运行 vagent package assemble ${args.slug}\n`,
  };
}
