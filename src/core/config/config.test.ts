/**
 * Tests for @core/config — defaults table, .env merge precedence (env wins),
 * ffmpeg probe failure -> NotFoundError, redact masking, enum validation,
 * the in-house dotenv parser (Workflow 4, BR-U1-7), and the paid MiniMax
 * backend's settings resolver (fail-fast before any billable call).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TTS_VOICES,
  MINIMAX_DEFAULTS,
  defaultVoiceFor,
  envOrUndefined,
  isTtsBackendName,
  loadConfig,
  parseEnvFile,
  redact,
  registerSecret,
  resolveMinimaxConfig,
} from "@core/config";
import { NotFoundError, ValidationError } from "@core/errors";

const MANAGED_KEYS = [
  "TTS_BACKEND",
  "TTS_VOICE",
  "CARD_TEMPLATE",
  "VIDEOS_ROOT",
  "DATA_ROOT",
  "FFMPEG_PATH",
  "FAKE_TTS_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_MODEL",
  "MINIMAX_VOICE",
  "MINIMAX_SPEED",
  "MINIMAX_BASE_URL",
  "MINIMAX_GROUP_ID",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(async () => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Deterministic probe target: /bin/ls exists and is executable on macOS/Linux.
  process.env["FFMPEG_PATH"] = "/bin/ls";
  tempDir = await mkdtemp(join(tmpdir(), "config-test-"));
});

afterEach(async () => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("@core/config", () => {
  test("defaults table applies when no .env and no env vars are set", async () => {
    const config = await loadConfig({ envPath: join(tempDir, ".env") });
    expect(config.ttsBackend).toBe("edge");
    expect(config.ttsVoice).toBe(DEFAULT_TTS_VOICES.edge);
    expect(config.cardTemplate).toBe("default");
    expect(config.videosRoot).toBe("./videos");
    expect(config.dataRoot).toBe("./data");
    expect(config.ffmpegPath).toBe("/bin/ls"); // set by the test harness
  });

  test(".env values are used when env vars are not set", async () => {
    const envPath = join(tempDir, ".env");
    await writeFile(
      envPath,
      "TTS_BACKEND=say\nVIDEOS_ROOT=/tmp/vids\nDATA_ROOT=/tmp/data\n",
      "utf8",
    );
    const config = await loadConfig({ envPath });
    expect(config.ttsBackend).toBe("say");
    expect(config.ttsVoice).toBe(DEFAULT_TTS_VOICES.say); // backend default voice
    expect(config.videosRoot).toBe("/tmp/vids");
    expect(config.dataRoot).toBe("/tmp/data");
  });

  test("existing env vars take precedence over .env values", async () => {
    process.env["TTS_VOICE"] = "from-env";
    const envPath = join(tempDir, ".env");
    await writeFile(envPath, "TTS_VOICE=from-file\n", "utf8");
    const config = await loadConfig({ envPath });
    expect(config.ttsVoice).toBe("from-env");
    expect(process.env["TTS_VOICE"]).toBe("from-env"); // never overridden
  });

  test("invalid TTS_BACKEND is rejected with ValidationError", async () => {
    process.env["TTS_BACKEND"] = "polly";
    expect(loadConfig({ envPath: join(tempDir, ".env") })).rejects.toThrow(
      ValidationError,
    );
  });

  test("minimax is a legal TTS_BACKEND with its own default voice", async () => {
    process.env["TTS_BACKEND"] = "minimax";
    const config = await loadConfig({ envPath: join(tempDir, ".env") });
    expect(config.ttsBackend).toBe("minimax");
    expect(config.ttsVoice).toBe(DEFAULT_TTS_VOICES.minimax);
    expect(isTtsBackendName("minimax")).toBe(true);
    expect(isTtsBackendName("azure")).toBe(false);
  });

  test("TTS_BACKEND 报错信息列出完整值域（含 minimax）", async () => {
    process.env["TTS_BACKEND"] = "polly";
    try {
      await loadConfig({ envPath: join(tempDir, ".env") });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("edge | say | minimax");
    }
  });

  test("ffmpeg probe failure raises NotFoundError with brew hint", async () => {
    process.env["FFMPEG_PATH"] = join(tempDir, "no-such-ffmpeg");
    expect(loadConfig({ envPath: join(tempDir, ".env") })).rejects.toThrow(
      NotFoundError,
    );
    try {
      await loadConfig({ envPath: join(tempDir, ".env") });
    } catch (err) {
      expect((err as Error).message).toContain("brew install ffmpeg");
    }

    // Bare command name goes through PATH lookup and must also fail typed.
    process.env["FFMPEG_PATH"] = "definitely-not-a-real-binary-xyz";
    expect(loadConfig({ envPath: join(tempDir, ".env") })).rejects.toThrow(
      NotFoundError,
    );
  });

  test("credential values loaded from .env are masked by redact()", async () => {
    const envPath = join(tempDir, ".env");
    await writeFile(
      envPath,
      "FAKE_TTS_API_KEY=super-secret-value-42\n",
      "utf8",
    );
    await loadConfig({ envPath });
    const message = "request failed with key super-secret-value-42 (401)";
    expect(redact(message)).toBe("request failed with key *** (401)");
    expect(redact(message)).not.toContain("super-secret-value-42");
  });

  test("直接拷 .env.example（每个键都留空）不能把 CLI 卡住", async () => {
    // 这正是 README 教的第一步。留空的 TTS_BACKEND 曾经让 loadConfig 直接
    // 报「TTS_BACKEND 值非法: ""」——空值必须等价于"没配"。
    const example = await readFile(
      new URL("../../../.env.example", import.meta.url),
      "utf8",
    );
    const envPath = join(tempDir, ".env");
    await writeFile(envPath, example, "utf8");

    const config = await loadConfig({ envPath });
    expect(config.ttsBackend).toBe("edge");
    expect(config.ttsVoice).toBe(DEFAULT_TTS_VOICES.edge);
    expect(config.videosRoot).toBe("./videos");
    expect(config.dataRoot).toBe("./data");
    // 留空的 MINIMAX_API_KEY 同样等价于没配：收费后端照旧报可操作错误
    expect(() => resolveMinimaxConfig()).toThrow(/MINIMAX_API_KEY/);
  });

  test("envOrUndefined: 空串与纯空白都等价于没配", () => {
    expect(envOrUndefined("K", { K: "" })).toBeUndefined();
    expect(envOrUndefined("K", { K: "   " })).toBeUndefined();
    expect(envOrUndefined("K", {})).toBeUndefined();
    expect(envOrUndefined("K", { K: " v " })).toBe("v");
  });

  test("过短的值不进掩码表（否则每条诊断都会被打成马赛克）", () => {
    registerSecret("k");
    registerSecret("abc");
    expect(redact("key sk-1 abc")).toBe("key sk-1 abc");
    registerSecret("long-enough-secret");
    expect(redact("token=long-enough-secret")).toBe("token=***");
  });

  test("parseEnvFile handles comments, quotes, export prefix, and junk lines", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=value",
        'DOUBLE="quoted value"',
        "SINGLE='single quoted'",
        "export EXPORTED=yes",
        "SPACED = padded ",
        "not a valid line",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "value",
      DOUBLE: "quoted value",
      SINGLE: "single quoted",
      EXPORTED: "yes",
      SPACED: "padded",
    });
  });
});

describe("resolveMinimaxConfig（收费后端配置）", () => {
  test("只给 API Key 时其余走默认值", () => {
    const config = resolveMinimaxConfig({
      MINIMAX_API_KEY: "fake-key-defaults",
    });
    expect(config.apiKey).toBe("fake-key-defaults");
    expect(config.baseUrl).toBe(MINIMAX_DEFAULTS.baseUrl);
    expect(config.model).toBe(MINIMAX_DEFAULTS.model);
    expect(config.speed).toBe(1);
    expect(config.voice).toBe(DEFAULT_TTS_VOICES.minimax);
    expect(config.groupId).toBeUndefined();
  });

  test("缺 API Key 时报错，并指向免费后端", () => {
    expect(() => resolveMinimaxConfig({})).toThrow(ValidationError);
    try {
      resolveMinimaxConfig({ MINIMAX_API_KEY: "   " });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("MINIMAX_API_KEY");
      expect((err as Error).message).toContain("--backend edge");
    }
  });

  test("API Key 解析后即进入 redact 掩码表", () => {
    resolveMinimaxConfig({ MINIMAX_API_KEY: "sk-minimax-abcdef-123456" });
    expect(redact("Authorization: Bearer sk-minimax-abcdef-123456")).toBe(
      "Authorization: Bearer ***",
    );
  });

  test("覆盖值生效；baseUrl 末尾斜杠被去掉", () => {
    const config = resolveMinimaxConfig({
      MINIMAX_API_KEY: "fake-key-overrides",
      MINIMAX_MODEL: "speech-2.8-hd",
      MINIMAX_VOICE: "Chinese (Mandarin)_Gentleman",
      MINIMAX_SPEED: "1.1",
      MINIMAX_BASE_URL: "https://api.minimax.io///",
      MINIMAX_GROUP_ID: "1900000001",
    });
    expect(config.model).toBe("speech-2.8-hd");
    expect(config.voice).toBe("Chinese (Mandarin)_Gentleman");
    expect(config.speed).toBe(1.1);
    expect(config.baseUrl).toBe("https://api.minimax.io");
    expect(config.groupId).toBe("1900000001");
  });

  test("非法 model / speed / baseUrl 都在解析期报错", () => {
    expect(() =>
      resolveMinimaxConfig({
        MINIMAX_API_KEY: "fake-key-model",
        MINIMAX_MODEL: "speech-9",
      }),
    ).toThrow(/MINIMAX_MODEL/);
    expect(() =>
      resolveMinimaxConfig({
        MINIMAX_API_KEY: "fake-key-fast",
        MINIMAX_SPEED: "3",
      }),
    ).toThrow(/MINIMAX_SPEED/);
    expect(() =>
      resolveMinimaxConfig({
        MINIMAX_API_KEY: "fake-key-nan",
        MINIMAX_SPEED: "abc",
      }),
    ).toThrow(/MINIMAX_SPEED/);
    expect(() =>
      resolveMinimaxConfig({
        MINIMAX_API_KEY: "fake-key-url",
        MINIMAX_BASE_URL: "ftp://nope",
      }),
    ).toThrow(/MINIMAX_BASE_URL/);
  });

  test("空字符串的可选项回落默认值（.env 里留空是常态）", () => {
    const config = resolveMinimaxConfig({
      MINIMAX_API_KEY: "fake-key-blanks",
      MINIMAX_SPEED: "",
      MINIMAX_VOICE: "",
      MINIMAX_GROUP_ID: "",
    });
    expect(config.speed).toBe(1);
    expect(config.voice).toBe(DEFAULT_TTS_VOICES.minimax);
    expect(config.groupId).toBeUndefined();
  });
});

describe("defaultVoiceFor", () => {
  test("MINIMAX_VOICE 只钉住 minimax 的默认音色，不影响免费后端", () => {
    const env = { MINIMAX_VOICE: "female-yujie" };
    expect(defaultVoiceFor("minimax", env)).toBe("female-yujie");
    expect(defaultVoiceFor("edge", env)).toBe(DEFAULT_TTS_VOICES.edge);
    expect(defaultVoiceFor("say", env)).toBe(DEFAULT_TTS_VOICES.say);
  });

  test("没配 MINIMAX_VOICE 时回落到后端默认音色", () => {
    expect(defaultVoiceFor("minimax", {})).toBe(DEFAULT_TTS_VOICES.minimax);
    expect(defaultVoiceFor("minimax", { MINIMAX_VOICE: "  " })).toBe(
      DEFAULT_TTS_VOICES.minimax,
    );
  });
});
