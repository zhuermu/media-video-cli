/**
 * @module @adapters/ffmpeg (mix)
 *
 * buildSfxMixArgs — 口播 + 音效混音的纯 argv 构建器（BR-U2-7 同款：
 * 只产 argv 数组，不碰磁盘/子进程）。
 *
 * 图结构：
 * - 输入 0 = 口播 merged 音轨（amix duration=first 的时长锚——混音
 *   永不改变成片时长，backend 的音画 probe 自检不受影响）；
 * - writing 输入以 -stream_loop -1 无限循环，按事件表 asplit 出 N 份，
 *   逐段 atrim 到段长 + adelay 到位 + 低音量（铺垫感）；
 * - whoosh 输入 asplit 出 M 份，逐个 adelay + 中音量；
 * - amix normalize=0（不自动压低口播）。
 */

import { ValidationError } from "@core/errors";

/** writing 铺垫音量（相对原始素材）. */
export const WRITING_VOLUME = 0.16;

/** whoosh 点缀音量. */
export const WHOOSH_VOLUME = 0.32;

/** 单事件类目上限（防御：filtergraph 规模失控）. */
export const SFX_EVENTS_MAX = 80;

/** 混音任务（纯值）. */
export interface SfxMixJob {
  /** 口播 merged 音轨（时长锚）. */
  narration: string;
  /** writing 音效文件（可缺省 = 无书写铺垫）. */
  writingFile?: string;
  writingSpans: ReadonlyArray<{ t0: number; t1: number }>;
  /** whoosh 音效文件（可缺省 = 无转场点缀）. */
  whooshFile?: string;
  whooshTimes: readonly number[];
  /** 输出 m4a 路径. */
  output: string;
}

/** 是否存在任何可混的事件（无事件时调用方应跳过混音）. */
export function hasSfxWork(job: SfxMixJob): boolean {
  return (
    (job.writingFile !== undefined && job.writingSpans.length > 0) ||
    (job.whooshFile !== undefined && job.whooshTimes.length > 0)
  );
}

const ms = (sec: number): number => Math.max(0, Math.round(sec * 1000));

/**
 * 构建混音 argv（纯函数）。
 *
 * @throws ValidationError 无事件可混、事件超上限、或时间非法.
 */
export function buildSfxMixArgs(
  job: SfxMixJob,
  options: { ffmpegPath?: string } = {},
): string[] {
  if (!hasSfxWork(job)) {
    throw new ValidationError("混音任务没有任何音效事件（调用方应跳过混音）");
  }
  const writingSpans =
    job.writingFile !== undefined ? [...job.writingSpans] : [];
  const whooshTimes = job.whooshFile !== undefined ? [...job.whooshTimes] : [];
  if (
    writingSpans.length > SFX_EVENTS_MAX ||
    whooshTimes.length > SFX_EVENTS_MAX
  ) {
    throw new ValidationError(
      `音效事件超上限 ${SFX_EVENTS_MAX}（writing ${writingSpans.length} / whoosh ${whooshTimes.length}）`,
    );
  }
  for (const s of writingSpans) {
    if (!(s.t1 > s.t0) || s.t0 < 0) {
      throw new ValidationError(`writing 区间非法: [${s.t0}, ${s.t1}]`);
    }
  }
  if (whooshTimes.some((t) => t < 0 || !Number.isFinite(t))) {
    throw new ValidationError(`whoosh 点位非法: [${whooshTimes.join(", ")}]`);
  }

  // 输入表：0 = 口播；writing/whoosh 依存在性顺序编号
  const argv: string[] = [
    options.ffmpegPath ?? "ffmpeg",
    "-y",
    "-v",
    "error",
    "-i",
    job.narration,
  ];
  let writingInput = -1;
  let whooshInput = -1;
  if (job.writingFile !== undefined && writingSpans.length > 0) {
    writingInput = 1;
    argv.push("-stream_loop", "-1", "-i", job.writingFile);
  }
  if (job.whooshFile !== undefined && whooshTimes.length > 0) {
    whooshInput = writingInput === -1 ? 1 : 2;
    argv.push("-i", job.whooshFile);
  }

  const graph: string[] = [];
  const mixLabels: string[] = ["[0:a]"];

  if (writingInput !== -1) {
    const outs = writingSpans.map((_, k) => `[w${k}]`).join("");
    graph.push(`[${writingInput}:a]asplit=${writingSpans.length}${outs}`);
    writingSpans.forEach((span, k) => {
      const delay = ms(span.t0);
      graph.push(
        `[w${k}]atrim=0:${(span.t1 - span.t0).toFixed(3)},adelay=${delay}|${delay},volume=${WRITING_VOLUME}[ws${k}]`,
      );
      mixLabels.push(`[ws${k}]`);
    });
  }
  if (whooshInput !== -1) {
    const outs = whooshTimes.map((_, k) => `[x${k}]`).join("");
    graph.push(`[${whooshInput}:a]asplit=${whooshTimes.length}${outs}`);
    whooshTimes.forEach((t, k) => {
      const delay = ms(t);
      graph.push(
        `[x${k}]adelay=${delay}|${delay},volume=${WHOOSH_VOLUME}[xs${k}]`,
      );
      mixLabels.push(`[xs${k}]`);
    });
  }
  graph.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0[mix]`,
  );

  argv.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[mix]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    job.output,
  );
  return argv;
}
