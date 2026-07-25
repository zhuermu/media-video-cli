/**
 * @module core/whiteboard-video/config
 *
 * 一次白板视频渲染的全部输入，**一处声明**。
 *
 * 早先这些值散在 demo 脚本的顶层：素材目录写死成相对 `import.meta.url` 的
 * 路径，帧目录/产物名走 `process.env`，体裁和字幕开关走 `process.argv`。
 * 三种传参机制混在一起的直接后果是：调用方（CLI、测试、别的 agent）没法
 * 知道有哪些旋钮，也没法在同一个进程里跑两次不同配置。
 *
 * 所以这里把它收成一个显式的 `WhiteboardVideoRequest`：
 * - **必填只有一项**（文章路径），其余全部可省；
 * - 省略时的默认值都从**文章名**派生，不是固定常量 —— 两条视频并行渲染
 *   时固定的 `frames-pipeline` 会互相 `rm -rf`（实测丢过 3804 帧，而日志
 *   显示"成功"，ffmpeg 只报 `No such file or directory`，极难查）；
 * - 素材根目录可配置，默认指向仓库的 `assets/`（与 `core/whiteboard/sfx.ts`
 *   读 `assets/sfx/manifest.json` 的约定一致）。
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { VideoKind } from "./article";
import { DEFAULT_ARM_MODE } from "./hand";
import type { ArmMode } from "./hand";

/** 素材库根目录（各库自带索引文件，见 assets/ASSETS.md）. */
export interface AssetPaths {
  /** Sparkol 手势库；期望其下有 `hands-index.json`. */
  hands: string;
  /** ManyPixels 插画库；期望其下有 `index.json` 与 `svg/<style>/`. */
  illustrations: string;
}

/** 完整解析后的渲染请求（所有路径均为绝对路径）. */
export interface WhiteboardVideoRequest {
  /** 文章 Markdown 的绝对路径. */
  articlePath: string;
  /** 产物目录（mp4 / srt / 中间音轨）. */
  outDir: string;
  /** 帧序列目录（`p-%05d.png`）. */
  framesDir: string;
  /** 关键帧目录（`--stills` 用）. */
  stillsDir: string;
  /** TTS 落盘缓存目录. */
  cacheDir: string;
  /** 产物文件名前缀. */
  tag: string;
  assets: AssetPaths;
  /** 手势 persona（`assets/sparkol/<persona>/`）. */
  persona: string;
  /** 笔迹主色. */
  ink: string;
  /** 强调色（标题下划线、打勾、点指光环）. */
  accent: string;
  /** 强制体裁；省略则按实测配音总时长自动判定. */
  kind?: VideoKind;
  /** 手臂怎么收尾（袖口切断 / 接出画面），见 {@link ArmMode}. */
  armMode: ArmMode;
  /** 字幕烧进帧里（SRT 始终旁挂输出）. */
  burnSubtitles: boolean;
  /** 从零重渲；默认续跑（已存在的帧跳过）. */
  fresh: boolean;
}

/** 调用方视角的可选项：只有 `articlePath` 必填. */
export interface WhiteboardVideoOptions extends Partial<
  Omit<WhiteboardVideoRequest, "articlePath" | "assets">
> {
  articlePath: string;
  assets?: Partial<AssetPaths>;
}

/** 仓库自带的素材根（`<repo>/assets`）. */
export function repoAssetsRoot(): string {
  return new URL("../../../assets/", import.meta.url).pathname;
}

/** 默认素材库位置. */
export function defaultAssetPaths(): AssetPaths {
  const root = repoAssetsRoot();
  return {
    hands: join(root, "sparkol"),
    illustrations: join(root, "manypixels"),
  };
}

/** 文章名（不含扩展名）—— 所有按文章区分的默认值都从它派生. */
export function articleSlug(articlePath: string): string {
  return basename(articlePath).replace(/\.md$/i, "");
}

const DEFAULT_INK = "#22262b";
const DEFAULT_ACCENT = "#c8483a";
const DEFAULT_PERSONA = "suneeta";

/**
 * 补齐默认值并把相对路径转成绝对路径。
 *
 * 工作目录默认落在**文章所在目录**下，而不是进程的 cwd：文章、它引用的
 * 图片、以及渲出来的产物属于同一件事，散在两处会让"这条视频的东西在哪"
 * 变成需要查文档的问题。
 */
export function resolveRequest(
  opts: WhiteboardVideoOptions,
): WhiteboardVideoRequest {
  const articlePath = resolve(opts.articlePath);
  const slug = articleSlug(articlePath);
  const base = dirname(articlePath);
  const abs = (p: string | undefined, fallback: string): string =>
    p === undefined ? join(base, fallback) : isAbsolute(p) ? p : resolve(p);
  const defaults = defaultAssetPaths();

  const request: WhiteboardVideoRequest = {
    articlePath,
    outDir: abs(opts.outDir, "out"),
    framesDir: abs(opts.framesDir, `frames-${slug}`),
    stillsDir: abs(opts.stillsDir, "stills"),
    cacheDir: abs(opts.cacheDir, "cache/tts"),
    tag: opts.tag ?? slug,
    assets: {
      hands: opts.assets?.hands ?? defaults.hands,
      illustrations: opts.assets?.illustrations ?? defaults.illustrations,
    },
    persona: opts.persona ?? DEFAULT_PERSONA,
    ink: opts.ink ?? DEFAULT_INK,
    accent: opts.accent ?? DEFAULT_ACCENT,
    burnSubtitles: opts.burnSubtitles ?? true,
    fresh: opts.fresh ?? false,
    armMode: opts.armMode ?? DEFAULT_ARM_MODE,
  };
  if (opts.kind !== undefined) request.kind = opts.kind;
  return request;
}
