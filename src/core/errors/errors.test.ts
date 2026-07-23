/**
 * Tests for @core/errors — hierarchy instanceof, locked exit-code table,
 * context payloads (argv/stderr, backend/segmentIndex, violations, baseline
 * fields), cause chaining, and redact() interaction (BR-U1-7/BR-U1-9/BR-U1-10).
 */
import { describe, expect, test } from "bun:test";

import {
  AppError,
  ContractViolationError,
  DomainGuardError,
  EXIT_CODES,
  FfmpegError,
  InsufficientDataError,
  IoError,
  NotFoundError,
  RenderError,
  SubprocessError,
  TTSBackendError,
  TTSMalformedOutputError,
  TTSNetworkError,
  TTSRateLimitError,
  TtsError,
  ValidationError,
} from "@core/errors";
import { redact, registerSecret } from "@core/config";

describe("@core/errors", () => {
  test("simple errors are instances of AppError and Error with correct name", () => {
    const errors = [
      new ValidationError("v"),
      new NotFoundError("n"),
      new DomainGuardError("d"),
      new IoError("i"),
      new RenderError("r"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(err.constructor.name);
    }
  });

  test("every concrete error's exitCode matches the locked EXIT_CODES table", () => {
    const instances: Record<keyof typeof EXIT_CODES, AppError> = {
      ValidationError: new ValidationError("m"),
      NotFoundError: new NotFoundError("m"),
      DomainGuardError: new DomainGuardError("m"),
      IoError: new IoError("m"),
      FfmpegError: new FfmpegError("m", { argv: ["ffmpeg"], stderr: "" }),
      TTSNetworkError: new TTSNetworkError("m", {
        backend: "edge",
        segmentIndex: 0,
      }),
      TTSRateLimitError: new TTSRateLimitError("m", {
        backend: "edge",
        segmentIndex: 0,
      }),
      TTSMalformedOutputError: new TTSMalformedOutputError("m", {
        backend: "edge",
        segmentIndex: 0,
      }),
      TTSBackendError: new TTSBackendError("m", {
        backend: "say",
        segmentIndex: 1,
      }),
      RenderError: new RenderError("m"),
      ContractViolationError: new ContractViolationError("m", {
        violations: [],
      }),
      InsufficientDataError: new InsufficientDataError("m", {
        platform: "douyin",
        weeksFound: 1,
        weeksRequired: 4,
      }),
    };
    for (const [name, err] of Object.entries(instances)) {
      expect(err.exitCode).toBe(EXIT_CODES[name as keyof typeof EXIT_CODES]);
    }
    // Spot-check the locked values themselves (domain-entities table).
    expect(EXIT_CODES.ValidationError).toBe(2);
    expect(EXIT_CODES.TTSBackendError).toBe(7);
    expect(EXIT_CODES.InsufficientDataError).toBe(10);
  });

  test("FfmpegError is a SubprocessError carrying argv + stderr", () => {
    const err = new FfmpegError("compose failed", {
      argv: ["ffmpeg", "-i", "in.mp4"],
      stderr: "muxer error",
    });
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.argv).toEqual(["ffmpeg", "-i", "in.mp4"]);
    expect(err.stderr).toBe("muxer error");
    expect(err.exitCode).toBe(6);
  });

  test("TTS errors carry backend + segmentIndex; rate limit carries retryAfter", () => {
    const rate = new TTSRateLimitError("throttled", {
      backend: "edge",
      segmentIndex: 3,
      retryAfter: 12,
    });
    expect(rate).toBeInstanceOf(TtsError);
    expect(rate.backend).toBe("edge");
    expect(rate.segmentIndex).toBe(3);
    expect(rate.retryAfter).toBe(12);

    const net = new TTSNetworkError("offline", {
      backend: "say",
      segmentIndex: 0,
    });
    expect(net).toBeInstanceOf(TtsError);
    expect(net.backend).toBe("say");
    expect(net.exitCode).toBe(7);
  });

  test("ContractViolationError and InsufficientDataError carry their payloads", () => {
    const contract = new ContractViolationError("package invalid", {
      violations: [{ field: "aigc-declaration.md", problem: "missing" }],
    });
    expect(contract.violations).toHaveLength(1);
    expect(contract.violations[0]?.field).toBe("aigc-declaration.md");
    expect(contract.exitCode).toBe(9);

    const data = new InsufficientDataError("need 4 weeks", {
      platform: "shipinhao",
      weeksFound: 2,
      weeksRequired: 4,
    });
    expect(data.platform).toBe("shipinhao");
    expect(data.weeksFound).toBe(2);
    expect(data.weeksRequired).toBe(4);
    expect(data.exitCode).toBe(10);
  });

  test("cause is preserved through the hierarchy", () => {
    const underlying = new Error("ENOENT");
    const io = new IoError("write failed", { cause: underlying });
    expect(io.cause).toBe(underlying);

    const ffmpeg = new FfmpegError("spawn failed", {
      argv: ["ffmpeg"],
      stderr: "",
      cause: underlying,
    });
    expect(ffmpeg.cause).toBe(underlying);
  });

  test("error messages containing credentials are masked by redact() (BR-U1-7)", () => {
    registerSecret("sk-verysecret-123");
    const err = new TTSBackendError("auth failed for key sk-verysecret-123", {
      backend: "edge",
      segmentIndex: 0,
    });
    expect(redact(err.message)).toBe("auth failed for key ***");
    expect(redact(err.message)).not.toContain("sk-verysecret-123");
  });
});
