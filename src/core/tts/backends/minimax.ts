/**
 * @module @core/tts/backends/minimax
 *
 * MinimaxTtsBackend — MiniMax 语音合成（**收费**后端，最终定稿才用）。
 *
 * ## 为什么用同步 HTTP `/v1/t2a_v2`，而不是异步 `t2a_async_v2`
 *
 * 异步接口是给长文本（整本书，单次上限 100 万字符）设计的：建任务 → 轮询状态 →
 * files/retrieve 拿下载链接 → 下载**结果包**（音频 + 句级字幕 + 元数据，且链接
 * 9 小时后失效）。而本项目的 TTS 端口是**按段**合成的（`synthesize(text, voice)`
 * → 一段口播，通常几十字），同步接口单次上限 10,000 字符，一次请求直接返回音频
 * （hex），无轮询、无解包、无链接过期。两者计费都按字符，价格没有差别。
 *
 * 也就是说：异步接口的能力在这里全是负担，失败面却大得多（轮询超时、任务过期、
 * 解包）。所以这里走同步接口。真需要单段超过 1 万字符时再加异步路径。
 *
 * THIN external-call adapter — excluded from the coverage denominator
 * (bunfig coveragePathIgnorePatterns: `src/core/tts/backends/**`).
 *
 * Error classification (FR-2.1)：MiniMax 的失败有两层，HTTP 状态码 **和** 200
 * 响应体里的 `base_resp.status_code`（错误码表见 api-reference/errorcode），
 * 两层都必须查——只看 HTTP 状态会把「余额不足」当成成功。
 * - 传输失败 / 超时 / 5xx / 1000,1001,1024,1033 → TTSNetworkError（可重试）
 * - 429 / 1002,1041,2045,2056                   → TTSRateLimitError
 * - 空音频或非法 hex                            → TTSMalformedOutputError
 * - 其余（1004 鉴权、1008 余额不足、1026/1027 涉敏、2013 参数…） → TTSBackendError
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TTS_VOICES,
  redact,
  registerSecret,
  resolveMinimaxConfig,
  type MinimaxConfig,
} from "@core/config";
import {
  TTSBackendError,
  TTSMalformedOutputError,
  TTSNetworkError,
  TTSRateLimitError,
  TtsError,
} from "@core/errors";

import type { AudioFile, TtsBackend, TtsUsage, VoiceOpts } from "../types";

/** 单段合成预算（同步接口，几十字的段远在此之内）. */
const REQUEST_TIMEOUT_MS = 120_000;

/** 同步接口的文本上限（api-reference: text 长度 < 10000 字符）. */
export const MINIMAX_TEXT_LIMIT = 10_000;

/** 音频参数：mp3 单声道（下游 mergeAudio 会归一化成 48kHz 立体声 aac）. */
const AUDIO_SETTING = {
  sample_rate: 44_100,
  bitrate: 128_000,
  format: "mp3",
  channel: 1,
} as const;

/** 可重试的服务端错误码（未知/超时/内部错误/下游错误）. */
const RETRYABLE_CODES = new Set([1000, 1001, 1024, 1033]);
/** 限流类错误码（频率/连接数/增长/Token Plan 资源）. */
const RATE_LIMIT_CODES = new Set([1002, 1041, 2045, 2056]);

/** 错误码 → 可操作提示（照抄错误码表的「解决方法」列）. */
const CODE_HINTS: Record<number, string> = {
  1004: "未授权/Token 不匹配：检查 MINIMAX_API_KEY",
  1008: "账户余额不足：充值后重试（草稿阶段可先用 --backend edge）",
  1026: "输入内容涉敏：调整口播文案",
  1027: "输出内容涉敏：调整口播文案",
  1042: "不可见字符/非法字符超过 10%：检查 script.json 文本",
  2013: "参数错误：检查 model / voice_id / audio_setting",
  20132: "voice_id 参数错误：核对系统音色表（docs/faq/system-voice-id）",
  2049: "无效的 API Key：检查 MINIMAX_API_KEY",
};

/** 构造参数（测试注入用；缺省从环境解析）. */
export interface MinimaxTtsBackendOptions {
  /** 预解析配置，跳过环境读取与校验. */
  config?: MinimaxConfig;
  /** HTTP 执行器，默认全局 fetch. */
  fetchFn?: typeof fetch;
}

/** MiniMax `/v1/t2a_v2` 成功响应的关心字段. */
interface T2aResponse {
  data?: { audio?: string; status?: number } | null;
  extra_info?: { usage_characters?: number; audio_length?: number };
  trace_id?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

export class MinimaxTtsBackend implements TtsBackend {
  readonly id = "minimax";
  readonly defaultVoice: string;
  /** 累计计费字符与请求数（`tts run` 跑完后报给用户）. */
  readonly usage: TtsUsage = { characters: 0, requests: 0 };

  private readonly config: MinimaxConfig;
  private readonly fetchFn: typeof fetch;

  /**
   * @throws ValidationError 缺 MINIMAX_API_KEY 或配置值非法（收费后端选中却
   *         没有凭据时，必须在花掉第一分钱之前就失败）.
   */
  constructor(options: MinimaxTtsBackendOptions = {}) {
    this.config = options.config ?? resolveMinimaxConfig();
    this.fetchFn = options.fetchFn ?? fetch;
    this.defaultVoice = this.config.voice || DEFAULT_TTS_VOICES.minimax;
    // Also register when the config was injected (tests / callers that resolve
    // it themselves): every error path below echoes vendor response bodies, and
    // those must never be able to carry the key through (BR-U1-7).
    registerSecret(this.config.apiKey);
  }

  async synthesize(text: string, voice: VoiceOpts): Promise<AudioFile> {
    const ctx = { backend: this.id, segmentIndex: voice.segmentIndex ?? -1 };
    if (text.trim().length === 0) {
      throw new TTSBackendError("TTS 输入文本为空", ctx);
    }
    if (voice.name.trim().length === 0) {
      throw new TTSBackendError("voice 名不能为空", ctx);
    }
    if ([...text].length > MINIMAX_TEXT_LIMIT) {
      throw new TTSBackendError(
        `单段文本 ${[...text].length} 字符，超过同步接口上限 ${MINIMAX_TEXT_LIMIT}：请把这一段拆短`,
        ctx,
      );
    }

    const url =
      `${this.config.baseUrl}/v1/t2a_v2` +
      (this.config.groupId === undefined
        ? ""
        : `?GroupId=${encodeURIComponent(this.config.groupId)}`);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          text,
          stream: false,
          output_format: "hex",
          language_boost: "auto",
          subtitle_enable: false,
          voice_setting: {
            voice_id: voice.name,
            speed: this.config.speed,
            vol: 1,
            pitch: 0,
          },
          audio_setting: AUDIO_SETTING,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // 传输层失败（DNS/连接/超时/中断）一律按网络类处理 → 可重试
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new TTSNetworkError(
        redact(`minimax 请求失败（${this.config.model}）: ${message}`),
        { ...ctx, cause },
      );
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw classifyHttp(response.status, bodyText, this.config.model, ctx);
    }

    let parsed: T2aResponse;
    try {
      parsed = JSON.parse(bodyText) as T2aResponse;
    } catch (cause) {
      throw new TTSMalformedOutputError(
        `minimax 响应不是合法 JSON: ${bodyText.slice(0, 300)}`,
        { ...ctx, cause },
      );
    }

    const code = parsed.base_resp?.status_code ?? 0;
    if (code !== 0) throw classifyApiCode(code, parsed, ctx);

    const hex = parsed.data?.audio ?? "";
    if (hex.length === 0) {
      throw new TTSMalformedOutputError(
        `minimax 返回空音频（trace_id=${parsed.trace_id ?? "无"}）`,
        ctx,
      );
    }
    const audio = Buffer.from(hex, "hex");
    if (audio.byteLength === 0) {
      throw new TTSMalformedOutputError(
        `minimax 音频 hex 解码为空（trace_id=${parsed.trace_id ?? "无"}）`,
        ctx,
      );
    }

    // 计费只在拿到可用音频之后累计：失败的请求不该记进账单口径
    this.usage.characters += parsed.extra_info?.usage_characters ?? 0;
    this.usage.requests += 1;

    // mp3 natively (no transcode); orchestrator moves it into place.
    const dir = mkdtempSync(join(tmpdir(), "mva-minimax-"));
    const outPath = join(dir, "tts.mp3");
    writeFileSync(outPath, audio);
    return { path: outPath, durationSec: 0 }; // measured later (BR-U2-3)
  }
}

/** HTTP 状态码（非 2xx）→ FR-2.1 分类. */
function classifyHttp(
  status: number,
  body: string,
  model: string,
  ctx: { backend: string; segmentIndex: number },
): TtsError {
  const tail = redact(body.slice(0, 300));
  if (status === 429) {
    return new TTSRateLimitError(
      `minimax 限流（HTTP 429, ${model}）: ${tail}`,
      ctx,
    );
  }
  if (status >= 500) {
    return new TTSNetworkError(
      `minimax 服务端错误（HTTP ${status}, ${model}）: ${tail}`,
      ctx,
    );
  }
  return new TTSBackendError(
    `minimax 请求被拒（HTTP ${status}, ${model}）: ${tail}`,
    ctx,
  );
}

/** `base_resp.status_code` → FR-2.1 分类（HTTP 200 也可能是失败）. */
function classifyApiCode(
  code: number,
  parsed: T2aResponse,
  ctx: { backend: string; segmentIndex: number },
): TtsError {
  const msg = parsed.base_resp?.status_msg ?? "";
  const hint = CODE_HINTS[code];
  const detail = redact(
    `minimax 错误码 ${code}${msg === "" ? "" : `（${msg}）`}` +
      `${hint === undefined ? "" : `：${hint}`}` +
      `${parsed.trace_id === undefined ? "" : ` [trace_id=${parsed.trace_id}]`}`,
  );
  if (RATE_LIMIT_CODES.has(code)) return new TTSRateLimitError(detail, ctx);
  if (RETRYABLE_CODES.has(code)) return new TTSNetworkError(detail, ctx);
  return new TTSBackendError(detail, ctx);
}
