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

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_TEMPLATE_PATH,
  loadTemplate,
  renderCards,
  resolveBackgroundImagePath,
  type RenderCardsOptions,
} from "@core/cards";
import { loadConfig, type AppConfig } from "@core/config";
import { IoError, NotFoundError, ValidationError } from "@core/errors";
import {
  FfmpegComposeBackend,
  type RenderBackend,
  type RenderFrame,
  type RenderJob,
} from "@core/render";
import { validateScript, type Script } from "@core/script";
import { durationsPath, MERGED_FILE, readDurations } from "@core/tts";
import {
  buildSfxMixArgs,
  FFMPEG_TIMEOUTS,
  hasSfxWork,
  runFfmpeg,
  type SfxMixJob,
} from "@adapters/ffmpeg";
import {
  DEFAULT_THEME,
  HANDWRITING_FONT_DIR,
  handwritingFont,
  loadSfxManifest,
  planSfxEvents,
  planWhiteboard,
  renderWhiteboardFrames,
  THEMES,
  type RenderWhiteboardOptions,
  type WhiteboardPlan,
  type WhiteboardScene,
} from "@core/whiteboard";
import { load, markStep, stepDone, type VideoDir } from "@core/workdir";

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
  /** Whiteboard 帧栅格化 seam（透传 renderWhiteboardFrames）. */
  whiteboardRasterizeFn?: RenderWhiteboardOptions["rasterizeFn"];
  /** 音效清单路径 override（默认 assets/sfx/manifest.json；缺文件=纯口播）. */
  sfxManifestPath?: string;
  /** 混音执行 seam（默认真 runFfmpeg）. */
  mixRunFn?: (argv: string[], options: { timeoutSec: number }) => Promise<void>;
  /** Warning sink (template warnings + progress). Default: stderr. */
  warn?: (message: string) => void;
}

/** 白板场景 image.src 预读：路径解析（同 backgroundImage 约定）→ data URI. */
async function preloadSceneImages(
  scenes: readonly WhiteboardScene[],
  dir: VideoDir,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [i, scene] of scenes.entries()) {
    for (const el of scene.elements) {
      if (el.type !== "image" || out.has(el.src)) continue;
      const resolved = resolveBackgroundImagePath(el.src, dir);
      if (!existsSync(resolved)) {
        throw new NotFoundError(
          `场景 ${i} 图片不存在: ${resolved}（image.src "${el.src}"；` +
            `相对路径请放进 ${join(dir.paths.input, "images")}）`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(resolved);
      } catch (cause) {
        throw new IoError(`场景图片读取失败: ${resolved}`, { cause });
      }
      const mime = resolved.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
      out.set(el.src, `data:${mime};base64,${bytes.toString("base64")}`);
    }
  }
  return out;
}

/**
 * Whiteboard 渲染路径：scene DSL + 实测时长 → 规划 → 帧序列。
 * 帧输出在 cards/whiteboard/ 下（幂等跳过已有帧；改脚本后如需强制
 * 重渲，删除该目录重跑——与卡片路径的幂等提醒一致）。
 */
async function renderWhiteboardPath(
  script: Script,
  segmentDurations: number[],
  dir: VideoDir,
  seams: ComposeRunSeams,
  warn: (message: string) => void,
): Promise<{ frames: RenderFrame[]; plan: WhiteboardPlan }> {
  const scenes = script.segments.map((s, i) => {
    if (s.scene === undefined) {
      // validateScript 已拒绝；防御直调
      throw new ValidationError(`segments[${i}].scene 缺失（whiteboard 风格）`);
    }
    return s.scene;
  });
  const imageDataUris = await preloadSceneImages(scenes, dir);
  const plan = planWhiteboard(scenes, segmentDurations, {
    theme: THEMES[script.theme ?? DEFAULT_THEME]!,
    imageDataUris,
  });
  let lastPct = -1;
  const frames = await renderWhiteboardFrames(
    plan,
    join(dir.paths.cards, "whiteboard"),
    {
      rasterizeFn: seams.whiteboardRasterizeFn,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 10) * 10;
        if (pct > lastPct) {
          lastPct = pct;
          warn(`白板帧渲染 ${pct}%（${done}/${total}）`);
        }
      },
    },
  );
  return { frames, plan };
}

/** 混音后的音轨文件名（audio/ 下；口播 merged 的 sfx 变体）. */
export const MERGED_SFX_FILE = "merged-sfx.m4a";

/**
 * 手写字体授权条目（assets/fonts/manifest.json；C12 素材可追溯）。
 * 仅当字体实际加载成功（即本次渲染确实用了手写字形）才返回条目。
 */
async function fontProvenanceEntries(): Promise<string[]> {
  if (handwritingFont() === null) return [];
  const path = join(HANDWRITING_FONT_DIR, "manifest.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      entries?: Array<{ name?: string; source?: string; license?: string }>;
    };
    return (raw.entries ?? [])
      .filter((e) => e.name !== undefined)
      .map(
        (e) =>
          `- 手写字体 ${e.name}: ${e.source ?? "未记录来源"}（许可: ${e.license ?? "未记录"}）`,
      );
  } catch {
    return []; // 追溯清单损坏不阻断渲染；authorization 由入库纪律保证
  }
}

/**
 * 可选音效混音：清单存在且有事件 → 口播 + writing/whoosh → merged-sfx.m4a。
 * 返回 [最终音轨路径, 素材追溯条目]（无清单/无事件时原样返回口播轨）。
 */
async function mixSfxIfAvailable(
  plan: WhiteboardPlan,
  narration: string,
  dir: VideoDir,
  ffmpegPath: string,
  seams: ComposeRunSeams,
  warn: (message: string) => void,
): Promise<[string, string[]]> {
  const manifest = await loadSfxManifest(seams.sfxManifestPath);
  if (manifest === undefined) return [narration, []];

  const events = planSfxEvents(plan);
  const mixJob: SfxMixJob = {
    narration,
    writingSpans: events.writingSpans,
    whooshTimes: events.whooshTimes,
    output: join(dir.paths.audio, MERGED_SFX_FILE),
  };
  if (manifest.byId.writing !== undefined) {
    mixJob.writingFile = manifest.byId.writing.file;
  }
  if (manifest.byId.whoosh !== undefined) {
    mixJob.whooshFile = manifest.byId.whoosh.file;
  }
  if (!hasSfxWork(mixJob)) return [narration, []];

  const argv = buildSfxMixArgs(mixJob, { ffmpegPath });
  const run = seams.mixRunFn ?? runFfmpeg;
  await run(argv, { timeoutSec: FFMPEG_TIMEOUTS.concatSec });

  const used: string[] = [];
  if (mixJob.writingFile !== undefined && events.writingSpans.length > 0) {
    const e = manifest.byId.writing!;
    used.push(`- 音效 writing: ${e.source}（许可: ${e.license}）`);
  }
  if (mixJob.whooshFile !== undefined && events.whooshTimes.length > 0) {
    const e = manifest.byId.whoosh!;
    used.push(`- 音效 whoosh: ${e.source}（许可: ${e.license}）`);
  }
  warn(
    `音效混音完成（writing ${events.writingSpans.length} 段 / whoosh ${events.whooshTimes.length} 处）→ ${mixJob.output}`,
  );
  return [mixJob.output, used];
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

  const script = await validateScript(join(dir.paths.script, "script.json"));
  const durations = await readDurations(dir);
  if (durations === undefined) {
    throw new IoError(
      `durations.json 读取失败: ${durationsPath(dir)}` +
        "（先运行 tts run，或用 --rebuild-state 检查状态）",
    );
  }

  let frames: RenderFrame[];
  let audioTrack = join(dir.paths.audio, MERGED_FILE);
  let sfxEntries: string[] = [];
  let fontEntries: string[] = [];
  if (script.style === "whiteboard") {
    // 白板手绘动画路径（scene DSL + 实测时长 → 逐帧渲染 + 可选混音）
    const rendered = await renderWhiteboardPath(
      script,
      durations.perSegment,
      dir,
      seams,
      warn,
    );
    frames = rendered.frames;
    [audioTrack, sfxEntries] = await mixSfxIfAvailable(
      rendered.plan,
      audioTrack,
      dir,
      config.ffmpegPath,
      seams,
      warn,
    );
    fontEntries = await fontProvenanceEntries();
  } else {
    // 既有静态卡片路径
    // Template: config 名 → shipped assets/templates/<name>.json sibling.
    const templatePath =
      seams.templatePath ??
      join(dirname(DEFAULT_TEMPLATE_PATH), `${config.cardTemplate}.json`);
    const { template, warnings } = loadTemplate(templatePath);
    for (const warning of warnings) warn(`模板警告: ${warning}`);

    // U4: frames.json 生成（幂等跳过已有帧, BR-U4-10）.
    frames = await renderCards(script, durations.perSegment, template, dir, {
      rasterizeFn: seams.rasterizeFn,
    });
  }

  // v1.1 修正案装配点: 文件契约 → RenderJob 端口纯值.
  const job: RenderJob = {
    frames,
    audioTrack,
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
    style: script.style ?? "cards",
    sfx: sfxEntries.length > 0,
    // 素材追溯条目（音效 + 手写字体）；package assemble 追加进 materials-manifest
    sfxEntries: [...sfxEntries, ...fontEntries],
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
