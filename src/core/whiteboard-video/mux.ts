/**
 * @module core/whiteboard-video/mux
 *
 * 音轨与合成：逐句旁白入轨 → 叠音效 → 帧序列 + 音轨 → mp4。
 *
 * 旁白不是一整条音频，而是**每句一个文件**（换人要换音色，同人换句要有停顿）。
 * 所以入轨走 `adelay` + `amix`：每句延迟到它在全片时间轴上的绝对位置。
 */

import { writeFile } from "node:fs/promises";

import { buildSfxMixArgs, hasSfxWork } from "../../adapters/ffmpeg/mix";
import type { CueKind } from "../../adapters/ffmpeg/mix";
import { RenderError } from "../errors/index";
import { loadSfxManifest, mergeSpans } from "../whiteboard/index";
import type { PenActiveSpan, SfxId, SfxManifest } from "../whiteboard/index";
import type { Storyboard } from "./compose";
import type { Log } from "./log";
import { silent } from "./log";
import type { SpokenSection } from "./compose";
import { toSrt } from "./subtitle";

/** 相邻笔迹区间合并的容差（比这更近的两段算连续书写）. */
const PEN_SPAN_MERGE_SEC = 0.4;
/** 短于这个的笔迹区间不配音效（噪点）. */
const PEN_SPAN_MIN_SEC = 0.3;

/** 跑一次 ffmpeg；失败时把 stderr 尾部带进异常. */
export async function ffmpeg(argv: string[], what: string): Promise<void> {
  const proc = Bun.spawn({ cmd: argv, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new RenderError(`ffmpeg ${what} 失败: ${stderr.slice(-1500)}`);
  }
}

export interface NarrationTrackOpts {
  storyboard: Storyboard;
  spoken: readonly SpokenSection[];
  /** 输出 m4a 路径. */
  output: string;
  totalSec: number;
  log?: Log;
}

/**
 * 全片旁白轨。
 *
 * `apad` + `-t` 把轨道补到全片长度：混音器以旁白轨为时长锚，短一点点都会
 * 让成片被截掉尾巴。
 */
export async function buildNarrationTrack(
  opts: NarrationTrackOpts,
): Promise<string> {
  const log = opts.log ?? silent;
  const clips: Array<{ path: string; at: number }> = [];
  for (const p of opts.storyboard.placed) {
    for (const line of opts.spoken[p.index]!.lines) {
      clips.push({ path: line.narration.path, at: p.start + line.offset });
    }
  }
  if (clips.length === 0) {
    throw new RenderError("没有任何旁白可入轨：文章里每段都需要至少一句台词");
  }

  const argv = ["ffmpeg", "-y", "-v", "error"];
  for (const c of clips) argv.push("-i", c.path);
  const graph = clips.map((c, i) => {
    const ms = Math.round(c.at * 1000);
    return `[${i}:a]adelay=${ms}|${ms}[n${i}]`;
  });
  graph.push(
    `${clips.map((_, i) => `[n${i}]`).join("")}` +
      `amix=inputs=${clips.length}:duration=longest:normalize=0,apad[out]`,
  );
  argv.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-t",
    opts.totalSec.toFixed(3),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    opts.output,
  );
  await ffmpeg(argv, "旁白入轨");
  log(`  旁白 ${clips.length} 句入轨`);
  return opts.output;
}

/** 笔在板上的区间（writing 音效的铺垫依据）. */
export function penActiveSpans(
  storyboard: Storyboard,
  totalSec: number,
): PenActiveSpan[] {
  return mergeSpans(
    storyboard.penElements
      .map((e) => ({ t0: e.t0, t1: Math.min(e.t1, totalSec) }))
      .filter((s) => s.t1 > s.t0)
      .sort((a, b) => a.t0 - b.t0),
    PEN_SPAN_MERGE_SEC,
  ).filter((s) => s.t1 - s.t0 >= PEN_SPAN_MIN_SEC);
}

/**
 * 语义点位 + 清单 → 混音器的 cue 表。
 *
 * 缺素材的那一类静默跳过（音效是可降级的：纯口播也是完整成片），但**挂钩本身
 * 在类型里列全**，所以新加一条素材只需要在这张表里加一行。
 */
function cueTable(
  sfx: SfxManifest,
  storyboard: Storyboard,
  totalSec: number,
): Partial<Record<CueKind, { file: string; times: number[] }>> {
  const map: Array<[CueKind, SfxId, readonly number[]]> = [
    ["ding", "ding", storyboard.sfxCues.ding],
    ["pop", "pop", storyboard.sfxCues.pop],
    ["page", "page-turn", storyboard.sfxCues.page],
    ["sparkle", "sparkle", storyboard.sfxCues.sparkle],
  ];
  const out: Partial<Record<CueKind, { file: string; times: number[] }>> = {};
  for (const [kind, id, times] of map) {
    const entry = sfx.byId[id];
    const within = times.filter((t) => t >= 0 && t < totalSec);
    if (entry === undefined || within.length === 0) continue;
    out[kind] = { file: entry.file, times: within };
  }
  return out;
}

export interface SfxMixOpts {
  narrationTrack: string;
  storyboard: Storyboard;
  totalSec: number;
  /** 混音输出路径. */
  output: string;
  log?: Log;
}

/**
 * 叠音效：writing 铺在笔迹区间上，whoosh 打在每次擦板的起点。
 *
 * 没有音效清单就原样返回旁白轨（纯口播也是完整成片，不该因为缺素材失败）。
 */
export async function mixSfx(opts: SfxMixOpts): Promise<string> {
  const log = opts.log ?? silent;
  const sfx = await loadSfxManifest();
  if (sfx === undefined) {
    log("  无音效清单 → 纯口播");
    return opts.narrationTrack;
  }
  const job = {
    narration: opts.narrationTrack,
    writingFile: sfx.byId.writing?.file,
    writingSpans: penActiveSpans(opts.storyboard, opts.totalSec),
    whooshFile: sfx.byId.whoosh?.file,
    // 打在**每次运镜的起点**：转场的听觉标记要和视觉动作同时发生。
    //
    // 早先挂的是擦板起点（`p.wipe`），但无限画布把翻页式擦板换成了镜头平移，
    // 于是 wipe 恒为 null——挂钩静默失效，整片一声 whoosh 都没有。运镜列表
    // 同时覆盖段间平移和收尾拉远，正是需要声音标记的两处。
    whooshTimes: opts.storyboard.camMoves
      .map((m) => m.t0)
      // 收尾拉远由 page-turn 标记，这里剔掉，否则两个音同时响
      .filter(
        (t) => t < opts.totalSec && !opts.storyboard.sfxCues.page.includes(t),
      ),
    // 其余点状音效：语义由 compose 声明（见 Storyboard.sfxCues），
    // 这里只负责"有素材 + 有点位就混进去"
    cues: cueTable(sfx, opts.storyboard, opts.totalSec),
    output: opts.output,
  };
  if (!hasSfxWork(job)) return opts.narrationTrack;
  await ffmpeg(buildSfxMixArgs(job), "音效混音");
  log(
    `  混音：writing ${job.writingSpans.length} 段 / whoosh ${job.whooshTimes.length} 点` +
      Object.entries(job.cues ?? {})
        .map(([k, c]) => ` / ${k} ${c?.times.length ?? 0} 点`)
        .join(""),
  );
  return opts.output;
}

export interface MuxOpts {
  /** `ffmpeg -i` 的帧序列模式（`renderFrames` 的返回值里有）. */
  framePattern: string;
  fps: number;
  audioTrack: string;
  output: string;
}

/** 帧序列 + 音轨 → mp4（H.264 / yuv420p / faststart）. */
export async function muxVideo(opts: MuxOpts): Promise<string> {
  await ffmpeg(
    [
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-framerate",
      String(opts.fps),
      "-i",
      opts.framePattern,
      "-i",
      opts.audioTrack,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      opts.output,
    ],
    "合成",
  );
  return opts.output;
}

/**
 * 旁挂 SRT。
 *
 * 本机 ffmpeg 既没编 libass 也没编 freetype（`-filters | grep subtitles`
 * 为空），所以字幕是画进帧里的；SRT 仍然要出，播放器和后续再剪都要用。
 */
export async function writeSrt(
  storyboard: Storyboard,
  path: string,
): Promise<string> {
  await writeFile(path, toSrt(storyboard.subtitles), "utf8");
  return path;
}
