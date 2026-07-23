/**
 * Tests for @core/config — defaults table, .env merge precedence (env wins),
 * ffmpeg probe failure -> NotFoundError, redact masking, enum validation,
 * and the in-house dotenv parser (Workflow 4, BR-U1-7).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TTS_VOICES,
  loadConfig,
  parseEnvFile,
  redact,
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
