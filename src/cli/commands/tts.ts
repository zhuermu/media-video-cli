/**
 * @module cli/commands/tts
 *
 * `vagent tts run <slug> [--backend --voice --fresh]` — U2 delegation: 前置
 * stepDone("script") 校验 → createTtsBackend → synthesizeScript →
 * mergeAudio → markStep("tts").
 *
 * Boundary rules honored here:
 * - 前置校验 (services.md 编排模型): script 未完成 → ValidationError with
 *   下一步提示; stepDone 的不变式破坏 (IoError) 原样上抛.
 * - --backend/--voice override config (CommandSpec 参数面); backend enum
 *   violations → ValidationError (校验逻辑: 枚举值域).
 * - loadConfig happens here (not for registry-only commands): the ffmpeg
 *   probe is a real precondition of this pipeline step.
 *
 * ## 换声音必须是显式动作（--fresh）
 *
 * BR-U2-2 规定已存在的 `seg-NN.mp3` 永不重合成——这条不变式让中断续跑很便宜，
 * 但也意味着"换个后端再跑一遍"会是一次静默空转：命令成功退出，音频还是旧的。
 * 收费后端（minimax）让这个坑变得更糟：用户以为换了音色，实际什么也没变，或者
 * 反过来——为了换音色重跑，却在不知情的情况下把整条片子重新计费一次。
 *
 * 所以这里把它变成一次显式选择：**后端或音色与上次不同时必须给 `--fresh`**，
 * 否则报错并把两次的取值都写进报错信息。给了 `--fresh` 就先清空 `audio/`
 * 再全量重合成。
 */

import { join } from "node:path";

import {
  PAID_TTS_BACKENDS,
  TTS_BACKEND_NAMES,
  defaultVoiceFor,
  isTtsBackendName,
  loadConfig,
  type AppConfig,
  type TtsBackendName,
} from "@core/config";
import { ValidationError } from "@core/errors";
import { validateScript } from "@core/script";
import {
  clearAudio,
  createTtsBackend,
  mergeAudio,
  synthesizeScript,
  type MergeAudioOptions,
  type SynthesizeScriptOptions,
  type TtsBackend,
} from "@core/tts";
import { load, markStep, stepDone } from "@core/workdir";

import type { CommandResult } from "../envelope";

/** Parsed argv surface of `tts run`. */
export interface TtsRunArgs {
  slug: string;
  backend?: string;
  voice?: string;
  fresh?: boolean;
  videosRoot?: string;
}

/** Injectable seams for offline tests. */
export interface TtsRunSeams {
  /** Pre-resolved config (skips loadConfig + ffmpeg probe). */
  config?: AppConfig;
  /** Backend factory. Default: the real registry {@link createTtsBackend}. */
  backendFactory?: (name: TtsBackendName) => TtsBackend;
  synthesizeOptions?: Omit<SynthesizeScriptOptions, "voice">;
  mergeOptions?: MergeAudioOptions;
}

/** state.json 里上一次 tts 步骤记的后端与音色（没有就都是 undefined）. */
function previousRun(meta: Record<string, unknown> | undefined): {
  backend?: string;
  voice?: string;
} {
  const backend = meta?.["backend"];
  const voice = meta?.["voice"];
  return {
    ...(typeof backend === "string" ? { backend } : {}),
    ...(typeof voice === "string" ? { voice } : {}),
  };
}

/**
 * Runs `tts run` (U2 workflows 1+2, assembled).
 *
 * @throws ValidationError script step not done, bad --backend value, or a
 *         voice/backend change without --fresh.
 * @throws IoError stepDone invariant breach (--rebuild-state hint).
 * @throws TtsError subclasses / FfmpegError from U2.
 */
export async function runTtsRun(
  args: TtsRunArgs,
  seams: TtsRunSeams = {},
): Promise<CommandResult> {
  const dir = await load(args.slug, { videosRoot: args.videosRoot });

  if (!stepDone(dir, "script")) {
    throw new ValidationError(
      `步骤 script 未完成: 请先运行 vagent script validate ${args.slug}` +
        "（停点 1 人工审核通过后再继续）",
    );
  }

  const config = seams.config ?? (await loadConfig());

  const backendName = args.backend ?? config.ttsBackend;
  if (!isTtsBackendName(backendName)) {
    throw new ValidationError(
      `--backend 值非法: "${backendName}"（允许: ${TTS_BACKEND_NAMES.join(" | ")}）`,
    );
  }
  // Voice resolution: explicit flag > 同后端的配置值 > 后端默认音色。
  // minimax 的默认音色允许用 MINIMAX_VOICE 单独钉住，这样"定稿音色"能写进
  // .env，而默认后端仍然是免费的 edge（收费永远不会被隐式选中）。
  const voice =
    args.voice ??
    (backendName === config.ttsBackend
      ? config.ttsVoice
      : defaultVoiceFor(backendName));

  // 换后端/换音色必须显式 --fresh，否则旧音频会被原样留下（BR-U2-2）
  const last = previousRun(dir.state.steps.tts?.meta);
  const changed =
    last.backend !== undefined &&
    (last.backend !== backendName || last.voice !== voice);
  if (changed && args.fresh !== true) {
    throw new ValidationError(
      `音频已用「${last.backend} / ${last.voice ?? "?"}」合成过，本次要求` +
        `「${backendName} / ${voice}」。已存在的 seg-NN.mp3 不会被重合成` +
        `（BR-U2-2），直接重跑等于空转。\n` +
        `确认要重合成请加 --fresh（会先清空 audio/ 下的分段与合并音轨` +
        `${PAID_TTS_BACKENDS.has(backendName) ? "；minimax 为收费后端，全片将重新计费" : ""}）`,
    );
  }

  const cleared = args.fresh === true ? clearAudio(dir) : [];

  const script = await validateScript(join(dir.paths.script, "script.json"));

  const backend = (seams.backendFactory ?? createTtsBackend)(backendName);
  const segments = await synthesizeScript(script, backend, dir, {
    voice,
    ...seams.synthesizeOptions,
  });
  const track = await mergeAudio(segments, dir, seams.mergeOptions);

  // 收费后端把账单口径写进 state.json：下次再跑时能看出上一次花了多少
  const usage = backend.usage;
  const paid = PAID_TTS_BACKENDS.has(backendName);

  await markStep(dir, "tts", {
    backend: backendName,
    voice,
    segments: segments.length,
    durationSec: track.durationSec,
    ...(usage === undefined ? {} : { billedCharacters: usage.characters }),
  });

  const usageLine =
    usage === undefined
      ? ""
      : `计费字符 ${usage.characters}（${usage.requests} 次请求，收费后端 ${backendName}）\n`;

  return {
    step: "tts",
    data: {
      mergedPath: track.path,
      durationSec: track.durationSec,
      segments: segments.length,
      backend: backendName,
      voice,
      paid,
      ...(cleared.length === 0 ? {} : { cleared }),
      ...(usage === undefined
        ? {}
        : {
            billedCharacters: usage.characters,
            billedRequests: usage.requests,
          }),
    },
    text:
      (cleared.length === 0
        ? ""
        : `♻️ --fresh: 已清空 audio/ 下 ${cleared.length} 个旧产物\n`) +
      `✅ TTS 完成（${segments.length} 段，合并音轨 ` +
      `${track.durationSec.toFixed(1)}s）: ${track.path}\n` +
      usageLine +
      `下一步: vagent compose run ${args.slug}\n`,
  };
}
