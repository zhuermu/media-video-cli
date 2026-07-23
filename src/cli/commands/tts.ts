/**
 * @module cli/commands/tts
 *
 * `vagent tts run <slug> [--backend --voice]` — U2 delegation: 前置
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
 */

import { join } from "node:path";

import {
  DEFAULT_TTS_VOICES,
  loadConfig,
  type AppConfig,
  type TtsBackendName,
} from "@core/config";
import { ValidationError } from "@core/errors";
import { validateScript } from "@core/script";
import {
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

/**
 * Runs `tts run` (U2 workflows 1+2, assembled).
 *
 * @throws ValidationError script step not done, or bad --backend value.
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
  if (backendName !== "edge" && backendName !== "say") {
    throw new ValidationError(
      `--backend 值非法: "${backendName}"（允许: edge | say）`,
    );
  }
  // Voice resolution: explicit flag > config (same backend) > backend默认.
  const voice =
    args.voice ??
    (backendName === config.ttsBackend
      ? config.ttsVoice
      : DEFAULT_TTS_VOICES[backendName]);

  const script = await validateScript(join(dir.paths.script, "script.json"));

  const backend = (seams.backendFactory ?? createTtsBackend)(backendName);
  const segments = await synthesizeScript(script, backend, dir, {
    voice,
    ...seams.synthesizeOptions,
  });
  const track = await mergeAudio(segments, dir, seams.mergeOptions);

  await markStep(dir, "tts", {
    backend: backendName,
    voice,
    segments: segments.length,
    durationSec: track.durationSec,
  });

  return {
    step: "tts",
    data: {
      mergedPath: track.path,
      durationSec: track.durationSec,
      segments: segments.length,
      backend: backendName,
      voice,
    },
    text:
      `✅ TTS 完成（${segments.length} 段，合并音轨 ` +
      `${track.durationSec.toFixed(1)}s）: ${track.path}\n` +
      `下一步: vagent compose run ${args.slug}\n`,
  };
}
