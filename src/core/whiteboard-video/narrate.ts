/**
 * PoC: 流水线配音段 —— Edge TTS（免费）+ 词级时间戳
 *
 * 用 `msedge-tts` 直接调，而不是走 `@core/tts` 的 `EdgeTtsBackend`，只为一
 * 件事：**要词边界**。核心那个 backend 把 `metadataStream` 丢掉了（它只需
 * 要音频），而白板视频的字幕和板书节奏都想踩在"这个词正被念出来"的时刻上。
 * 拿不到词边界就只能按字数比例摊，字幕会整体飘半秒左右——一眼能看出来。
 *
 * 词边界的单位是 100ns tick（Azure 语音服务的惯例），换算成秒要除 1e7。
 *
 * ## 音色
 *
 * 默认 `zh-CN-YunjianNeural`（男声，偏叙述/纪录片腔，语速稳）。可选的几个
 * 中文音色各自的适用场景：
 * - `zh-CN-YunjianNeural` 男声，沉稳，适合讲道理/技术叙述 ← 默认
 * - `zh-CN-YunxiNeural`   男声，年轻些，节奏更快，适合科普短视频
 * - `zh-CN-XiaoxiaoNeural` 女声，通用，最"标准"也最容易听出是 TTS
 * - `zh-CN-XiaoyiNeural`  女声，活泼，适合口播带货那种语气
 *
 * 白板讲解片我选云健：它的句间停顿比晓晓长一点，正好给笔留出写字的时间，
 * 不需要额外插空白。
 *
 * ## 缓存
 *
 * 合成结果按 `hash(voice + rate + text)` 落盘。改版式、调音效、重渲帧都不该
 * 重新过一遍网络——一次全片合成十几秒，迭代二十次就是几分钟纯等待。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

import type { Emotion, Prosody } from "./voices";
import { findVoice, voiceProsody } from "./voices";

/** 默认音色（见模块注释里的挑选理由）. */
export const DEFAULT_VOICE = "zh-CN-YunjianNeural";

/** 一个词（或标点组）在音频里的位置. */
export interface WordMark {
  /** 词文本. */
  text: string;
  /** 起始秒. */
  t: number;
  /** 时长秒. */
  dur: number;
  /** 该词在原文里的起始字符下标（用于"板书踩词"对齐）. */
  charIndex: number;
}

export interface Narration {
  text: string;
  /** mp3 绝对路径. */
  path: string;
  /** ffprobe 实测时长（秒）—— 不用 TTS 自报的值. */
  durationSec: number;
  words: WordMark[];
}

interface CachePayload {
  durationSec: number;
  words: WordMark[];
}

/** Azure 时间单位（100ns tick）→ 秒. */
const TICKS_PER_SEC = 1e7;

function ffprobeDuration(path: string): number {
  const p = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    path,
  ]);
  const out = new TextDecoder().decode(p.stdout).trim();
  const v = Number.parseFloat(out);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`ffprobe 读不出时长: ${path}（输出 "${out}"）`);
  }
  return v;
}

/**
 * 解析词边界事件流。
 *
 * 服务端一条消息里可能带多个事件，且 JSON 之间没有分隔符保证，所以逐块
 * 累积后用 `Metadata` 数组解析；解析不出来就返回空表（字幕退化成按字数
 * 摊，不影响出片）。
 */
function parseWordMarks(chunks: string[], text: string): WordMark[] {
  const marks: WordMark[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    const list = (parsed as { Metadata?: unknown }).Metadata;
    if (!Array.isArray(list)) continue;
    for (const ev of list) {
      const data = (ev as { Data?: Record<string, unknown> }).Data;
      const info = data?.["text"] as Record<string, unknown> | undefined;
      if (info === undefined) continue;
      if (info["BoundaryType"] !== "WordBoundary") continue;
      const word = String(info["Text"] ?? "");
      if (word === "") continue;
      // 在原文里顺序定位这个词，拿到字符下标（服务端返回的词序与原文一致）
      const at = text.indexOf(word, cursor);
      if (at >= 0) cursor = at + word.length;
      marks.push({
        text: word,
        t: Number(data?.["Offset"] ?? 0) / TICKS_PER_SEC,
        dur: Number(data?.["Duration"] ?? 0) / TICKS_PER_SEC,
        charIndex: at >= 0 ? at : cursor,
      });
    }
  }
  return marks;
}

export interface SynthesizeOpts {
  /** 后端音色名（Edge ShortName）. */
  voice?: string;
  /** 韵律（见 voices.ts：免费通道的"情绪"只能靠这个 + 选音色）. */
  prosody?: Prosody;
  /** 缓存目录. */
  cacheDir: string;
}

/**
 * 合成一段口播（带词级时间戳），结果落盘缓存。
 *
 * @throws Error 网络/服务失败，或返回空音频
 */
export async function synthesize(
  text: string,
  o: SynthesizeOpts,
): Promise<Narration> {
  const voice = o.voice ?? DEFAULT_VOICE;
  const prosody = o.prosody ?? {};
  // 缓存键要含韵律：同一句话不同语速是两份不同的音频
  const key = createHash("sha256")
    .update(
      `${voice}\u0000${prosody.rate ?? ""}\u0000${prosody.pitch ?? ""}\u0000${prosody.volume ?? ""}\u0000${text}`,
    )
    .digest("hex")
    .slice(0, 16);
  mkdirSync(o.cacheDir, { recursive: true });
  const mp3 = join(o.cacheDir, `${key}.mp3`);
  const meta = join(o.cacheDir, `${key}.json`);

  if (existsSync(mp3) && existsSync(meta)) {
    try {
      const cached = JSON.parse(readFileSync(meta, "utf8")) as CachePayload;
      return { text, path: mp3, ...cached };
    } catch {
      // 缓存坏了就重合成
    }
  }

  const tts = new MsEdgeTTS();
  let audio: Buffer;
  let metaChunks: string[] = [];
  try {
    await tts.setMetadata(
      voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
      {
        wordBoundaryEnabled: true,
        sentenceBoundaryEnabled: false,
      },
    );
    const hasProsody =
      prosody.rate !== undefined ||
      prosody.pitch !== undefined ||
      prosody.volume !== undefined;
    const { audioStream, metadataStream } = tts.toStream(
      text,
      hasProsody ? prosody : undefined,
    );
    const chunks: string[] = [];
    metadataStream?.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? c : c.toString("utf8"));
    });
    const bufs: Buffer[] = [];
    for await (const c of audioStream) {
      bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    }
    // 元数据帧可能比音频流末尾晚一点到，给它一个很短的收尾窗口
    await new Promise((r) => setTimeout(r, 250));
    audio = Buffer.concat(bufs);
    metaChunks = chunks;
  } finally {
    try {
      tts.close();
    } catch {
      // socket 可能从未打开，关闭是 best-effort
    }
  }
  if (audio.byteLength === 0) throw new Error(`TTS 返回空音频: "${text}"`);

  writeFileSync(mp3, audio);
  const payload: CachePayload = {
    // 时长一律 ffprobe 实测：TTS 自报值不可信，音画对齐全靠这个数
    durationSec: ffprobeDuration(mp3),
    words: parseWordMarks(metaChunks, text),
  };
  writeFileSync(meta, JSON.stringify(payload));
  return { text, path: mp3, ...payload };
}

/**
 * 原文字符下标 → 音频时刻（秒）。
 *
 * 用来让板书踩在词上：某个要点的关键词在口播第 N 个字，那一笔就从那一刻
 * 开始写。没有词边界时线性插值兜底。
 */
export function timeAtChar(n: Narration, charIndex: number): number {
  if (n.words.length === 0) {
    const ratio = n.text.length === 0 ? 0 : charIndex / n.text.length;
    return ratio * n.durationSec;
  }
  let last = 0;
  for (const w of n.words) {
    if (w.charIndex >= charIndex) return w.t;
    last = w.t + w.dur;
  }
  return Math.min(last, n.durationSec);
}

// ---- 多人对话 ----

/** 一句待配音的台词. */
export interface Cue {
  /** 角色名（对应 cast 表；单人片就是"旁白"）. */
  speaker: string;
  text: string;
  /** 情绪（免费通道靠韵律近似，见 voices.ts）. */
  emotion?: Emotion;
}

/** 一句台词的合成结果 + 它在本段内的偏移. */
export interface SpokenLine {
  speaker: string;
  /** 该句用的音色库 id（写进日志便于核对"这句为什么是这个声音"）. */
  voiceId: string;
  narration: Narration;
  /** 相对本段起点的偏移（秒）. */
  offset: number;
}

/** 同一个人连续两句之间的停顿. */
const SAME_SPEAKER_GAP = 0.26;

/**
 * 换人说话时的停顿。
 *
 * 明显长于同一人的换句停顿：真实对话里接话有个反应时间，没有这个间隙，
 * 两个音色会像被硬剪在一起，听着像同一个人突然变声。
 */
const SPEAKER_SWITCH_GAP = 0.48;

/**
 * 合成一段（可能多人）的全部台词，返回各句在段内的偏移与总时长。
 *
 * @param cast 角色名 → 音色库 id
 * @throws Error cast 里缺角色，或 TTS 失败
 */
export async function speakSection(
  cues: readonly Cue[],
  cast: Record<string, string>,
  o: { cacheDir: string },
): Promise<{ lines: SpokenLine[]; durationSec: number }> {
  const lines: SpokenLine[] = [];
  let cursor = 0;
  let prevSpeaker: string | null = null;
  for (const cue of cues) {
    const voiceId = cast[cue.speaker];
    if (voiceId === undefined) {
      throw new Error(
        `角色 "${cue.speaker}" 不在 cast 表里（已配置：${Object.keys(cast).join("、") || "无"}）`,
      );
    }
    const spec = findVoice(voiceId);
    if (prevSpeaker !== null) {
      cursor +=
        prevSpeaker === cue.speaker ? SAME_SPEAKER_GAP : SPEAKER_SWITCH_GAP;
    }
    const narration = await synthesize(cue.text, {
      voice: spec.shortName,
      prosody: voiceProsody(spec, cue.emotion ?? "neutral"),
      cacheDir: o.cacheDir,
    });
    lines.push({ speaker: cue.speaker, voiceId, narration, offset: cursor });
    cursor += narration.durationSec;
    prevSpeaker = cue.speaker;
  }
  return { lines, durationSec: cursor };
}
