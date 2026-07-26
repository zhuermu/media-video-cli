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

import { ValidationError } from "@core/errors";

import type { VideoKind } from "./article";
import type { BoardBackground } from "./board";
import type { ArmMode, CursorKind } from "./hand";
import { PALETTE } from "./palette";

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
  /** 手势 persona（`assets/sparkol/<persona>/`）；`cursor: "pen"` 时不用. */
  persona: string;
  /**
   * 画笔光标：`"hand"` 手拿笔（默认），`"pen"` 只有一支笔。
   *
   * 默认是手拿笔——真人感更强。关键是**把手放得足够大**：手小了，那条渐尖收笔的
   * 前臂就断在画板中间，观感很假；放大到手臂直接伸出画幅之外，就没有"手臂断在
   * 哪里"这个问题了（画板可以理解成一块 iPad 画布，手搭在上面、手臂在屏幕外）。
   * 尺寸见 `LANDSCAPE_HAND_SIZE`，收尾方式见 `armModeFor`（横版 extend）。
   *
   * `"pen"` 只留一支笔，适合不想有人手出现的场合；代价是没有擦除/搬运/点指
   * 三种手势贴图。
   */
  cursor: CursorKind;
  /** 笔迹主色. */
  ink: string;
  /** 强调色（标题下划线、打勾、点指光环）. */
  accent: string;
  /** 板面背景样式（设计稿 §2）. */
  background: BoardBackground;
  /** 强制体裁；省略则按实测配音总时长自动判定. */
  kind?: VideoKind;
  /**
   * 手臂怎么收尾（袖口切断 / 接出画面），见 {@link ArmMode}。
   * 省略 = 按画幅朝向自动选（横版 extend / 竖版 cuff，见 `armModeFor`）。
   */
  armMode?: ArmMode;
  /** 字幕烧进帧里（SRT 始终旁挂输出）. */
  burnSubtitles: boolean;
  /** 从零重渲；默认续跑（已存在的帧跳过）. */
  fresh: boolean;
  /**
   * 只渲开头这么多秒（试看档）。省略 = 整片。
   *
   * 整片一万多帧、近一小时，而"配音好不好听、音效对不对、字幕认不认得出"这类
   * 问题在前半分钟就能判断。试看档把帧、旁白轨、音效、字幕**同一个上限**截断，
   * 所以听到的和整片是同一条时间轴，不是另做一版。
   *
   * 产物名和帧目录都会带 `-preview` 后缀：试看帧是**不完整的序列**，混进整片的
   * 帧目录会让后续续跑以为已经渲过（默认续跑跳过已存在的帧），成片就少了后面
   * 那一大段。
   */
  previewSec?: number;
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

/**
 * 笔迹主色与强调色的默认值取自设计稿 §8 六色板（见 palette.ts）。
 *
 * 强调色由早先的砖红 `#c8483a` 改为蓝 `#4A90E2`：设计稿全篇的强调件（标题
 * 下划线、板块标签、流程箭头）都是蓝色，红色在六色板里专职表示"风险/错误"。
 * 用红色做通用强调，会让每一个标题下划线都自带一层警告意味。
 */
const DEFAULT_INK = PALETTE.ink;
const DEFAULT_ACCENT = PALETTE.primary;
/**
 * 默认手势 persona 换成 `matt`：它的手臂**更窄**（`matt-white-pencil` 宽高比 0.474，
 * suneeta 的马克笔是 0.635）。手宽 = 手臂高度 × 这个比例，而要让手臂伸出竖版
 * 1920 高的画幅，手臂高度得给到 1800——suneeta 会算出 104% 画宽的手（比屏幕还宽），
 * matt 只有 77%。参考图（`assets/design/竖屏手比例.jpeg`）里的手正是这个量级。
 */
const DEFAULT_PERSONA = "matt";
/** 默认背景：设计稿 §2 的纯白（纹理由调用方按题材选）. */
const DEFAULT_BACKGROUND: BoardBackground = "plain";

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
    cursor: opts.cursor ?? "hand",
    ink: opts.ink ?? DEFAULT_INK,
    accent: opts.accent ?? DEFAULT_ACCENT,
    background: opts.background ?? DEFAULT_BACKGROUND,
    burnSubtitles: opts.burnSubtitles ?? true,
    fresh: opts.fresh ?? false,
  };
  if (opts.previewSec !== undefined) {
    if (!Number.isFinite(opts.previewSec) || opts.previewSec <= 0) {
      throw new ValidationError(
        `--preview 需要一个正数秒数，得到 "${String(opts.previewSec)}"`,
      );
    }
    request.previewSec = opts.previewSec;
    request.tag = `${request.tag}-preview`;
    request.framesDir = `${request.framesDir}-preview`;
  }
  if (opts.kind !== undefined) request.kind = opts.kind;
  // armMode 刻意不给默认值：留 undefined 让 pipeline 在知道画幅之后按朝向决定
  if (opts.armMode !== undefined) request.armMode = opts.armMode;
  return request;
}
