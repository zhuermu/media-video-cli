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

/** Supported TTS backends (free tier, ADR/C6). */
export type TtsBackendName = "edge" | "say";

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
};

/** Keys whose values are credentials and must never reach any output. */
const CREDENTIAL_KEY_PATTERN =
  /(API[_-]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** In-memory registry of credential values to be masked by {@link redact}. */
const secretValues = new Set<string>();

/** Returns true when an env key names a credential (value must be masked). */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

/**
 * Registers a credential value so {@link redact} masks it from then on.
 * Exposed for adapters (e.g. paid TTS backends) that obtain credentials
 * outside loadConfig.
 */
export function registerSecret(value: string): void {
  if (value.length > 0) secretValues.add(value);
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
 * Loads application configuration (Workflow 4):
 * 1. Reads .env (when present) and merges into process.env WITHOUT
 *    overriding variables that are already set (env takes precedence).
 * 2. Fills missing values from the defaults table.
 * 3. Validates ttsBackend enum and probes ffmpeg executability.
 * 4. Registers credential-key values with the redaction filter.
 *
 * @throws ValidationError when TTS_BACKEND is outside the "edge"|"say" enum.
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

  const ttsBackendRaw = process.env["TTS_BACKEND"] ?? "edge";
  if (ttsBackendRaw !== "edge" && ttsBackendRaw !== "say") {
    throw new ValidationError(
      `TTS_BACKEND 值非法: "${ttsBackendRaw}"（允许: edge | say）`,
    );
  }
  const ttsBackend: TtsBackendName = ttsBackendRaw;

  const config: AppConfig = {
    ttsBackend,
    ttsVoice: process.env["TTS_VOICE"] ?? DEFAULT_TTS_VOICES[ttsBackend],
    cardTemplate: process.env["CARD_TEMPLATE"] ?? "default",
    videosRoot: process.env["VIDEOS_ROOT"] ?? "./videos",
    dataRoot: process.env["DATA_ROOT"] ?? "./data",
    ffmpegPath: process.env["FFMPEG_PATH"] ?? "ffmpeg",
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
