/**
 * @module @core/errors
 *
 * Typed error hierarchy shared by the whole project (U1 owns all error
 * paths — cross-cutting concern per unit-of-work story map).
 *
 * Boundary rules honored here:
 * - BR-U1-9: every failure uses a typed error class carrying enough context
 *   to be self-explanatory; bare `throw new Error(...)` is forbidden.
 * - BR-U1-10: the exit-code table (2-10) is locked here; the CLI (U6) is the
 *   only `process.exit` call site and maps errors via {@link EXIT_CODES}.
 * - Subprocess failures MUST carry argv + stderr (team-practices fail-fast
 *   discipline); TTS failures carry backend + segmentIndex.
 */

/**
 * Abstract base for every application error. Carries a human-readable
 * message plus an optional `cause` (the underlying error, if any).
 */
export abstract class AppError extends Error {
  /** Process exit code the CLI maps this error to (locked table, 2-10). */
  abstract readonly exitCode: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid input, schema violation, or slug conflict. Exit code 2. */
export class ValidationError extends AppError {
  readonly exitCode = 2;
}

/** Working directory or file missing. Exit code 3. */
export class NotFoundError extends AppError {
  readonly exitCode = 3;
}

/** Restricted content domain hit (C7 red line). Exit code 4. */
export class DomainGuardError extends AppError {
  readonly exitCode = 4;
}

/** Disk read/write failure (incl. state invariant breakage). Exit code 5. */
export class IoError extends AppError {
  readonly exitCode = 5;
}

/**
 * Abstract base for child-process failures. Always carries the full argv
 * and captured stderr so the error is diagnosable from the message alone.
 */
export abstract class SubprocessError extends AppError {
  readonly argv: string[];
  readonly stderr: string;

  constructor(
    message: string,
    details: { argv: string[]; stderr: string; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.argv = details.argv;
    this.stderr = details.stderr;
  }
}

/** FFmpeg/ffprobe subprocess failure. Exit code 6. */
export class FfmpegError extends SubprocessError {
  readonly exitCode = 6;
}

/**
 * Abstract base for TTS failures. Carries the backend name and the
 * zero-based segment index being synthesized when the failure occurred.
 */
export abstract class TtsError extends AppError {
  readonly backend: string;
  readonly segmentIndex: number;

  constructor(
    message: string,
    details: { backend: string; segmentIndex: number; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.backend = details.backend;
    this.segmentIndex = details.segmentIndex;
  }
}

/** Network failure talking to a TTS backend (retryable). Exit code 7. */
export class TTSNetworkError extends TtsError {
  readonly exitCode = 7;
}

/** TTS backend rate limit; optionally carries retry-after seconds. Exit code 7. */
export class TTSRateLimitError extends TtsError {
  readonly exitCode = 7;
  readonly retryAfter?: number;

  constructor(
    message: string,
    details: {
      backend: string;
      segmentIndex: number;
      retryAfter?: number;
      cause?: unknown;
    },
  ) {
    super(message, details);
    this.retryAfter = details.retryAfter;
  }
}

/** TTS backend returned unusable/malformed audio output. Exit code 7. */
export class TTSMalformedOutputError extends TtsError {
  readonly exitCode = 7;
}

/** Any other TTS backend failure. Exit code 7. */
export class TTSBackendError extends TtsError {
  readonly exitCode = 7;
}

/** SVG rasterization failure. Exit code 8. */
export class RenderError extends AppError {
  readonly exitCode = 8;
}

/** One publish-package contract violation (FR-4.2 itemized report). */
export interface ContractViolation {
  field: string;
  problem: string;
}

/** Publish-package contract violated; carries the itemized list. Exit code 9. */
export class ContractViolationError extends AppError {
  readonly exitCode = 9;
  readonly violations: ContractViolation[];

  constructor(
    message: string,
    details: { violations: ContractViolation[]; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.violations = details.violations;
  }
}

/** Not enough baseline data for the requested report. Exit code 10. */
export class InsufficientDataError extends AppError {
  readonly exitCode = 10;
  readonly platform: string;
  readonly weeksFound: number;
  readonly weeksRequired: number;

  constructor(
    message: string,
    details: {
      platform: string;
      weeksFound: number;
      weeksRequired: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.platform = details.platform;
    this.weeksFound = details.weeksFound;
    this.weeksRequired = details.weeksRequired;
  }
}

/**
 * Locked exit-code table (domain-entities; consumed by the U6 CLI as the
 * single process.exit point per BR-U1-10). Exit code 1 is reserved for
 * unexpected/untyped failures; 0 is success.
 */
export const EXIT_CODES = {
  ValidationError: 2,
  NotFoundError: 3,
  DomainGuardError: 4,
  IoError: 5,
  FfmpegError: 6,
  TTSNetworkError: 7,
  TTSRateLimitError: 7,
  TTSMalformedOutputError: 7,
  TTSBackendError: 7,
  RenderError: 8,
  ContractViolationError: 9,
  InsufficientDataError: 10,
} as const;
