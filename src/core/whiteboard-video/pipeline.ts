/**
 * @module core/whiteboard-video/pipeline
 *
 * 端到端：一篇 Markdown → 一条白板视频。
 *
 * ```
 * article.md
 *   → parseArticle()        分镜 + cast（谁说话）+ format 指令
 *   → speakSection()        Edge TTS 逐句合成（可多人对话）+ 词级时间戳 + 落盘缓存
 *   → resolveFormat()       按实测总时长定体裁：<3min 竖版短片 / ≥3min 横版长教程
 *   → composeStoryboard()   匹配素材 → 白板版式 → 时间轴（写/搬/擦/指 + 整板擦净）
 *   → renderFrames()        resvg 逐帧
 *   → buildNarrationTrack() 逐句 adelay 入轨 → mixSfx() 叠 writing/whoosh
 *   → muxVideo()            ffmpeg → mp4（+ 旁挂 SRT）
 * ```
 *
 * 体裁按**实测配音总时长**判，不用字数估算：同样的字数，播报腔和快语速差
 * 出小一半时长，跨过 3 分钟这条线就会选错版式（竖版短片和横版长教程的版式
 * 不是等比缩放关系）。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { parseArticle } from "./article";
import type { Article } from "./article";
import { composeStoryboard } from "./compose";
import type { SpokenSection, Storyboard } from "./compose";
import { resolveRequest } from "./config";
import type { WhiteboardVideoOptions, WhiteboardVideoRequest } from "./config";
import { resolveFormat } from "./format";
import type { FormatSpec } from "./format";
import { listGestures, loadHandKit } from "./gestures";
import type { HandKit } from "./gestures";
import type { Log } from "./log";
import { silent } from "./log";
import {
  assertFramesComplete,
  frameSvgFactory,
  renderFrames,
  renderStills,
} from "./render";
import { buildNarrationTrack, mixSfx, muxVideo, writeSrt } from "./mux";
import { speakSection } from "./narrate";
import { findVoice } from "./voices";

/** 「分镜 + 配音 + 体裁 + 手势 + 时间轴」—— 渲染前的全部准备结果. */
export interface PreparedVideo {
  request: WhiteboardVideoRequest;
  article: Article;
  spoken: SpokenSection[];
  format: FormatSpec;
  kit: HandKit;
  storyboard: Storyboard;
  frameSvg: (t: number) => string;
}

/**
 * 跑到"时间轴已就绪、还没渲帧"为止。
 *
 * 单独暴露这一步是因为它便宜（几秒）而渲帧很贵（一小时）：关键帧目视复核、
 * 版式快照测试、以及"先看看排片对不对"都只需要到这里。
 */
export async function prepareVideo(
  opts: WhiteboardVideoOptions & { log?: Log },
): Promise<PreparedVideo> {
  const log = opts.log ?? silent;
  const request = resolveRequest(opts);

  // ── 1. 分镜 ──
  const article = parseArticle(request.articlePath);
  log(
    `分镜 ${article.sections.length} 段：` +
      article.sections.map((s) => s.title).join(" / "),
  );
  log(
    `角色：${Object.entries(article.cast)
      .map(([role, id]) => `${role}=${id}(${findVoice(id).shortName})`)
      .join("  ")}`,
  );

  // ── 2. 配音（逐句、可多人、含词级时间戳） ──
  const spoken: SpokenSection[] = [];
  for (const [i, s] of article.sections.entries()) {
    const r = await speakSection(s.cues, article.cast, {
      cacheDir: request.cacheDir,
    });
    spoken.push(r);
    const who = [...new Set(r.lines.map((l) => `${l.speaker}/${l.voiceId}`))];
    log(
      `  配音 ${i} ${r.durationSec.toFixed(2)}s，${r.lines.length} 句，` +
        who.join(" + "),
    );
  }
  const narrationTotal = spoken.reduce((a, s) => a + s.durationSec, 0);

  // ── 3. 定体裁（短竖 / 长横） ──
  const format = resolveFormat(request.kind ?? article.kind, narrationTotal);
  const L = format.layout;
  log(
    `体裁 ${format.kind}（配音总 ${narrationTotal.toFixed(1)}s）→ ` +
      `${L.width}×${L.height}${format.chrome ? "，带页眉" : ""}`,
  );

  // ── 4. 手势四件套 ──
  const kit = loadHandKit(
    listGestures(request.assets.hands),
    request.persona,
    request.ink,
    {
      canvasWidth: L.width,
      canvasHeight: L.height,
      armMode: request.armMode,
    },
  );
  log(
    `手势 ${request.persona}: write=${kit.write?.asset.slug ?? "—"} ` +
      `erase=${kit.erase?.asset.slug ?? "—"} ` +
      `carry=${kit.carry?.asset.slug ?? "—"} ` +
      `point=${kit.point?.asset.slug ?? "—"}`,
  );

  // ── 5. 版式 + 排片 ──
  const storyboard = composeStoryboard({
    article,
    spoken,
    format,
    kit,
    ink: request.ink,
    accent: request.accent,
    illustrationsDir: request.assets.illustrations,
    log,
  });
  log(
    `全片 ${storyboard.totalSec.toFixed(2)}s，元素 ${storyboard.elements.length}，` +
      `字幕 ${storyboard.subtitles.length} 行`,
  );

  const frameSvg = frameSvgFactory({
    storyboard,
    format,
    kit,
    title: article.title,
    ink: request.ink,
    accent: request.accent,
    burnSubtitles: request.burnSubtitles,
  });

  return { request, article, spoken, format, kit, storyboard, frameSvg };
}

/** 一次成片的产物清单. */
export interface WhiteboardVideoResult {
  mp4: string;
  srt: string;
  kind: FormatSpec["kind"];
  width: number;
  height: number;
  durationSec: number;
  sections: number;
  totalFrames: number;
  renderedFrames: number;
  reusedFrames: number;
}

/** 端到端出片. */
export async function renderWhiteboardVideo(
  opts: WhiteboardVideoOptions & { log?: Log },
): Promise<WhiteboardVideoResult> {
  const prepared = await prepareVideo(opts);
  const { request, storyboard, format } = prepared;
  const log = opts.log ?? silent;

  await mkdir(request.outDir, { recursive: true });

  const frames = await renderFrames({
    framesDir: request.framesDir,
    totalSec: storyboard.totalSec,
    frameSvg: prepared.frameSvg,
    fresh: request.fresh,
    log,
  });
  assertFramesComplete(request.framesDir, frames.totalFrames);

  const narrationTrack = await buildNarrationTrack({
    storyboard,
    spoken: prepared.spoken,
    output: join(request.outDir, `${request.tag}-narration.m4a`),
    totalSec: storyboard.totalSec,
    log,
  });
  const audioTrack = await mixSfx({
    narrationTrack,
    storyboard,
    totalSec: storyboard.totalSec,
    output: join(request.outDir, `${request.tag}-audio.m4a`),
    log,
  });

  const srt = await writeSrt(
    storyboard,
    join(request.outDir, `${request.tag}.srt`),
  );
  const mp4 = await muxVideo({
    framePattern: frames.pattern,
    fps: frames.fps,
    audioTrack,
    output: join(request.outDir, `${request.tag}.mp4`),
  });

  return {
    mp4,
    srt,
    kind: format.kind,
    width: format.layout.width,
    height: format.layout.height,
    durationSec: storyboard.totalSec,
    sections: prepared.article.sections.length,
    totalFrames: frames.totalFrames,
    renderedFrames: frames.rendered,
    reusedFrames: frames.skipped,
  };
}

/** 只出关键帧（目视复核用，几秒出结果）. */
export async function renderWhiteboardStills(
  opts: WhiteboardVideoOptions & { log?: Log },
): Promise<string[]> {
  const prepared = await prepareVideo(opts);
  return renderStills({
    stillsDir: prepared.request.stillsDir,
    tag: prepared.request.tag,
    storyboard: prepared.storyboard,
    sectionAudioSec: prepared.spoken.map((s) => s.durationSec),
    frameSvg: prepared.frameSvg,
    log: opts.log ?? silent,
  });
}
