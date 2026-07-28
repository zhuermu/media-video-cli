/**
 * @module @core/config
 *
 * Application configuration: .env loading (dotenv-style, parsed in-house,
 * zero dependencies), defaults table, ffmpeg executable probe, and the
 * credential redaction helper.
 *
 * Boundary rules honored here:
 * - Workflow 4 (loadConfig): .env merge never overrides existing
 *   environment variables; missing values fall back to the defaults table.
 * - BR-U1-7 / NFR-6: credential values live only in memory; any message
 *   headed for logs/errors must pass through {@link redact} which replaces
 *   registered credential values with `***`.
 * - ffmpeg probe failure is a typed {@link NotFoundError} with an
 *   actionable hint (brew install ffmpeg).
 */

import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NotFoundError, ValidationError } from "@core/errors";

/**
 * Supported TTS backends — the single fact source of the enum value domain
 * (consumed by loadConfig, the CLI route table, and the backend registry).
 *
 * `edge` / `say` are free (C6 free toolchain). `minimax` is **paid** and
 * therefore never a default: it exists for the one job the free backends
 * cannot do — re-synthesizing the FINAL cut with a broadcast-grade voice
 * after the script has been reviewed and the draft audio approved.
 */
export const TTS_BACKEND_NAMES = ["edge", "say", "minimax"] as const;

/** Supported TTS backends (`edge`/`say` free, `minimax` paid). */
export type TtsBackendName = (typeof TTS_BACKEND_NAMES)[number];

/** Backends that bill real money — the CLI must never select one implicitly. */
export const PAID_TTS_BACKENDS: ReadonlySet<TtsBackendName> = new Set([
  "minimax",
]);

/** Resolved application configuration (defaults table in domain-entities). */
export interface AppConfig {
  ttsBackend: TtsBackendName;
  ttsVoice: string;
  cardTemplate: string;
  videosRoot: string;
  dataRoot: string;
  ffmpegPath: string;
}

/** Per-backend default voice, used when TTS_VOICE is not set. */
export const DEFAULT_TTS_VOICES: Record<TtsBackendName, string> = {
  edge: "zh-CN-XiaoxiaoNeural",
  say: "Tingting",
  // 精英青年音色 — MiniMax system voice id (see MINIMAX_VOICE in .env.example
  // for the shortlist; full table: platform.minimaxi.com/docs/faq/system-voice-id)
  minimax: "male-qn-jingying",
};

/** Returns true when `name` is inside the {@link TTS_BACKEND_NAMES} domain. */
export function isTtsBackendName(name: string): name is TtsBackendName {
  return (TTS_BACKEND_NAMES as readonly string[]).includes(name);
}

/**
 * Default voice of a backend, honoring the per-backend env override.
 *
 * `minimax` gets its own `MINIMAX_VOICE` key on purpose: it lets the final
 * voice be pinned in `.env` WITHOUT making the paid backend the default one
 * (`TTS_BACKEND=minimax` would do exactly that). Resolving the voice must
 * not require the API key — only synthesis does.
 */
export function defaultVoiceFor(
  backend: TtsBackendName,
  env: Record<string, string | undefined> = process.env,
): string {
  if (backend === "minimax") {
    const pinned = env["MINIMAX_VOICE"]?.trim();
    if (pinned !== undefined && pinned.length > 0) return pinned;
  }
  return DEFAULT_TTS_VOICES[backend];
}

/** Keys whose values are credentials and must never reach any output. */
const CREDENTIAL_KEY_PATTERN =
  /(API[_-]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** In-memory registry of credential values to be masked by {@link redact}. */
const secretValues = new Set<string>();

/**
 * Shortest value worth masking.
 *
 * A one- or two-character "secret" would match ordinary prose and turn every
 * diagnostic into confetti (`key sk-...` → `***ey s***-...`), which hides the
 * actual failure instead of protecting anything. Real credentials are long;
 * anything this short is a placeholder or a misconfiguration.
 */
const MIN_SECRET_LENGTH = 8;

/** Returns true when an env key names a credential (value must be masked). */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

/**
 * Registers a credential value so {@link redact} masks it from then on.
 * Values shorter than {@link MIN_SECRET_LENGTH} are ignored (see above).
 * Exposed for adapters (e.g. paid TTS backends) that obtain credentials
 * outside loadConfig.
 */
export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) secretValues.add(value);
}

/**
 * Replaces every registered credential value inside `text` with `***`.
 * All log/error message paths must run through this before output
 * (BR-U1-7: zero credential leakage surface).
 */
export function redact(text: string): string {
  let out = text;
  for (const secret of secretValues) {
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Parses dotenv-style content: `KEY=VALUE` lines, optional `export ` prefix,
 * `#` comments, single/double quoted values. No interpolation, no escapes —
 * intentionally minimal (fail-fast over clever).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Path to the .env file. Default: `<cwd>/.env`. */
  envPath?: string;
}

/**
 * Reads an env var, treating blank values as unset.
 *
 * `.env.example` ships every key with an empty value (`TTS_BACKEND=`), and
 * copying it to `.env` is the documented first step — so `""` must mean
 * "not configured", not "configured to the empty string". Without this the
 * copy alone breaks every command with `TTS_BACKEND 值非法: ""`.
 */
export function envOrUndefined(
  key: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Loads application configuration (Workflow 4):
 * 1. Reads .env (when present) and merges into process.env WITHOUT
 *    overriding variables that are already set (env takes precedence).
 * 2. Fills missing (or blank) values from the defaults table.
 * 3. Validates ttsBackend enum and probes ffmpeg executability.
 * 4. Registers credential-key values with the redaction filter.
 *
 * @throws ValidationError when TTS_BACKEND is outside {@link TTS_BACKEND_NAMES}.
 * @throws NotFoundError when the ffmpeg executable cannot be resolved.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<AppConfig> {
  const envPath = options.envPath ?? resolve(process.cwd(), ".env");

  let fileContent: string | undefined;
  try {
    fileContent = await readFile(envPath, "utf8");
  } catch {
    fileContent = undefined; // .env is optional (Workflow 4 step 1: 存在时)
  }

  if (fileContent !== undefined) {
    const parsed = parseEnvFile(fileContent);
    for (const [key, value] of Object.entries(parsed)) {
      // Blank .env values mean "not configured" (`.env.example` ships every
      // key empty). They must NOT land in process.env: other modules read
      // some of these keys directly with `?? default`, and `""` would win
      // that fallback — a blank FFMPEG_PATH became an empty argv[0].
      if (value.trim().length === 0) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value; // never override existing env vars
      }
      if (isCredentialKey(key)) {
        // Register both the file value and the effective value: whichever
        // wins the precedence rule must never leak (BR-U1-7).
        registerSecret(value);
        registerSecret(process.env[key] ?? "");
      }
    }
  }

  const ttsBackendRaw = envOrUndefined("TTS_BACKEND") ?? "edge";
  if (!isTtsBackendName(ttsBackendRaw)) {
    throw new ValidationError(
      `TTS_BACKEND 值非法: "${ttsBackendRaw}"（允许: ${TTS_BACKEND_NAMES.join(" | ")}）`,
    );
  }
  const ttsBackend: TtsBackendName = ttsBackendRaw;

  const config: AppConfig = {
    ttsBackend,
    ttsVoice: envOrUndefined("TTS_VOICE") ?? defaultVoiceFor(ttsBackend),
    cardTemplate: envOrUndefined("CARD_TEMPLATE") ?? "default",
    videosRoot: envOrUndefined("VIDEOS_ROOT") ?? "./videos",
    dataRoot: envOrUndefined("DATA_ROOT") ?? "./data",
    ffmpegPath: envOrUndefined("FFMPEG_PATH") ?? "ffmpeg",
  };

  probeExecutable(config.ffmpegPath);

  return config;
}

/**
 * Asserts that `command` resolves to an executable: PATH lookup for bare
 * names (Bun.which), X_OK access check for explicit paths.
 *
 * @throws NotFoundError with an install hint when the probe fails.
 */
function probeExecutable(command: string): void {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return;
    } catch (cause) {
      throw new NotFoundError(
        `ffmpeg 不可执行: ${command}。请检查 FFMPEG_PATH，或安装: brew install ffmpeg`,
        { cause },
      );
    }
  }
  if (Bun.which(command) === null) {
    throw new NotFoundError(
      `PATH 中未找到 ffmpeg（查找名: ${command}）。请安装: brew install ffmpeg`,
    );
  }
}

// ---- MiniMax (paid TTS backend) ------------------------------------------
//
// Kept in @core/config rather than inside the backend so that "where do
// settings come from" stays answerable in one file, and so the resolver is
// unit-testable while the backend itself (thin HTTP glue) is not.

/** Documented MiniMax T2A model ids (api-reference/speech-t2a-http). */
export const MINIMAX_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;

/** MiniMax T2A model id. */
export type MinimaxModel = (typeof MINIMAX_MODELS)[number];

/** MiniMax defaults: China-mainland host, HD tier, neutral pacing. */
export const MINIMAX_DEFAULTS = {
  /** 国内站；国际站是 https://api.minimax.io（MINIMAX_BASE_URL 覆盖）. */
  baseUrl: "https://api.minimaxi.com",
  model: "speech-2.6-hd" as MinimaxModel,
  speed: 1,
} as const;

/** Resolved MiniMax settings (credentials never logged — see {@link redact}). */
export interface MinimaxConfig {
  /** Bearer token. Registered with {@link redact} on resolution. */
  apiKey: string;
  baseUrl: string;
  model: MinimaxModel;
  /** System voice id, e.g. `male-qn-jingying`. */
  voice: string;
  /** Speech rate multiplier, [0.5, 2]. */
  speed: number;
  /** Legacy account scoping; appended as a query param only when set. */
  groupId?: string;
}

/**
 * Resolves the MiniMax settings from the environment (`.env`已由 loadConfig
 * 合并进 process.env 时同样可见).
 *
 * Fails fast and actionably: a paid backend selected without a key must not
 * turn into a mid-pipeline HTTP 401 after the first segments were already
 * billed.
 *
 * @throws ValidationError missing MINIMAX_API_KEY, unknown MINIMAX_MODEL,
 *         out-of-range MINIMAX_SPEED, or a non-http(s) MINIMAX_BASE_URL.
 */
export function resolveMinimaxConfig(
  env: Record<string, string | undefined> = process.env,
): MinimaxConfig {
  const apiKey = envOrUndefined("MINIMAX_API_KEY", env);
  if (apiKey === undefined) {
    throw new ValidationError(
      "MINIMAX_API_KEY 未设置：minimax 是收费后端，需要在 .env 里配置 API Key" +
        "（平台 > 账户管理 > 接口密钥）。草稿阶段请用免费后端: --backend edge",
    );
  }
  // The key may come straight from the shell (loadConfig only registers keys
  // it read out of .env), so register it here too — zero leakage surface.
  registerSecret(apiKey);

  const model = envOrUndefined("MINIMAX_MODEL", env) ?? MINIMAX_DEFAULTS.model;
  if (!(MINIMAX_MODELS as readonly string[]).includes(model)) {
    throw new ValidationError(
      `MINIMAX_MODEL 值非法: "${model}"（允许: ${MINIMAX_MODELS.join(" | ")}）`,
    );
  }

  const baseUrl = (
    envOrUndefined("MINIMAX_BASE_URL", env) ?? MINIMAX_DEFAULTS.baseUrl
  ).replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(baseUrl)) {
    throw new ValidationError(
      `MINIMAX_BASE_URL 不是合法的 http(s) 地址: "${baseUrl}"`,
    );
  }

  const speedRaw = envOrUndefined("MINIMAX_SPEED", env);
  const speed =
    speedRaw === undefined ? MINIMAX_DEFAULTS.speed : Number(speedRaw);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new ValidationError(
      `MINIMAX_SPEED 需在 [0.5, 2] 之间，得到 "${String(speedRaw)}"`,
    );
  }

  const groupId = envOrUndefined("MINIMAX_GROUP_ID", env);

  return {
    apiKey,
    baseUrl,
    model: model as MinimaxModel,
    voice: envOrUndefined("MINIMAX_VOICE", env) ?? DEFAULT_TTS_VOICES.minimax,
    speed,
    ...(groupId === undefined ? {} : { groupId }),
  };
}
