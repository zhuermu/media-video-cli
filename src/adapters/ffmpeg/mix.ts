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
 * - 点状音效（whoosh / ding / pop / page / sparkle）每类一个输入，
 *   asplit 出 M 份，逐个 adelay 到位 + 各自音量；
 * - amix normalize=0（不自动压低口播）。
 */

import { ValidationError } from "@core/errors";

/** writing 铺垫音量（相对原始素材）. */
export const WRITING_VOLUME = 0.16;

/** whoosh 点缀音量. */
export const WHOOSH_VOLUME = 0.32;

/**
 * 点状音效的默认音量。
 *
 * 都明显低于 whoosh：转场一次只响一下，而打勾/入场这类点位一段里有三五个，
 * 同样音量叠起来会盖住口播。ding 比 pop 略响——它标记的是"这条确认了"，
 * pop 只是元素出现的一点质感。
 */
export const CUE_VOLUME = {
  whoosh: WHOOSH_VOLUME,
  ding: 0.2,
  pop: 0.14,
  page: 0.26,
  sparkle: 0.18,
} as const;

/** 点状音效类目. */
export type CueKind = keyof typeof CUE_VOLUME;

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
  /**
   * 其余点状音效：类目 → { 文件, 点位 }。缺项 = 不混这一类。
   *
   * 做成一张表而不是继续加 `dingFile`/`dingTimes` 这样的字段对：每加一类音效
   * 都要改 job 形状、hasSfxWork、输入编号三处，漏一处就是"素材在库里但一声
   * 不响"（whoosh 挂钩失效过一次，正是这个形状造成的）。
   */
  cues?: Partial<Record<CueKind, { file: string; times: readonly number[] }>>;
  /** 输出 m4a 路径. */
  output: string;
}

/** 点状音效的规范化列表（whoosh 的独立字段并进同一张表）. */
function pointCues(
  job: SfxMixJob,
): Array<{ kind: CueKind; file: string; times: number[] }> {
  const out: Array<{ kind: CueKind; file: string; times: number[] }> = [];
  if (job.whooshFile !== undefined && job.whooshTimes.length > 0) {
    out.push({
      kind: "whoosh",
      file: job.whooshFile,
      times: [...job.whooshTimes],
    });
  }
  for (const [kind, cue] of Object.entries(job.cues ?? {})) {
    if (cue === undefined || cue.times.length === 0) continue;
    if (kind === "whoosh") continue; // 走上面的独立字段，避免重复入轨
    out.push({ kind: kind as CueKind, file: cue.file, times: [...cue.times] });
  }
  return out;
}

/** 是否存在任何可混的事件（无事件时调用方应跳过混音）. */
export function hasSfxWork(job: SfxMixJob): boolean {
  return (
    (job.writingFile !== undefined && job.writingSpans.length > 0) ||
    pointCues(job).length > 0
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
  const cues = pointCues(job);
  if (writingSpans.length > SFX_EVENTS_MAX) {
    throw new ValidationError(
      `音效事件超上限 ${SFX_EVENTS_MAX}（writing ${writingSpans.length}）`,
    );
  }
  for (const c of cues) {
    if (c.times.length > SFX_EVENTS_MAX) {
      throw new ValidationError(
        `音效事件超上限 ${SFX_EVENTS_MAX}（${c.kind} ${c.times.length}）`,
      );
    }
    if (c.times.some((t) => t < 0 || !Number.isFinite(t))) {
      throw new ValidationError(`${c.kind} 点位非法: [${c.times.join(", ")}]`);
    }
  }
  for (const s of writingSpans) {
    if (!(s.t1 > s.t0) || s.t0 < 0) {
      throw new ValidationError(`writing 区间非法: [${s.t0}, ${s.t1}]`);
    }
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
  let nextInput = 1;
  if (job.writingFile !== undefined && writingSpans.length > 0) {
    writingInput = nextInput++;
    argv.push("-stream_loop", "-1", "-i", job.writingFile);
  }
  const cueInputs = cues.map((c) => {
    argv.push("-i", c.file);
    return { ...c, input: nextInput++ };
  });

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
  for (const [ci, cue] of cueInputs.entries()) {
    const tag = `c${ci}`;
    const outs = cue.times.map((_, k) => `[${tag}_${k}]`).join("");
    graph.push(`[${cue.input}:a]asplit=${cue.times.length}${outs}`);
    cue.times.forEach((t, k) => {
      const delay = ms(t);
      graph.push(
        `[${tag}_${k}]adelay=${delay}|${delay},volume=${CUE_VOLUME[cue.kind]}[${tag}s${k}]`,
      );
      mixLabels.push(`[${tag}s${k}]`);
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
