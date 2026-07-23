/**
 * @module cli/envelope
 *
 * JsonEnvelope — the `--json` stdout contract (domain-entities.md, Q2=A)
 * plus the internal CommandResult shape every command function returns.
 *
 * Boundary rules honored here:
 * - BR-U6-2: stdout=结果 / stderr=进度诊断; with `--json` stdout carries
 *   exactly one JsonEnvelope line — skills parse stdout only.
 * - Error payloads carry type + message + context so skills can转述 the
 *   failure without re-deriving anything (BR-U6-6 呈现半边).
 */

import { AppError } from "@core/errors";
import type { Step } from "@core/workdir";

/** The `--json` stdout contract (locked shape, domain-entities.md Q2=A). */
export interface JsonEnvelope {
  ok: boolean;
  /** 关联流水线步骤（有则填）. */
  step?: Step;
  /** 成功载荷（各命令的结构化结果）. */
  data?: object;
  /** 失败载荷. */
  error?: { type: string; message: string; context: object };
}

/**
 * What every command function returns to the thin main entry: structured
 * data (envelope payload), human-readable stdout text, optional pipeline
 * step, and an optional non-zero exit code for commands that fail without
 * throwing (check 门禁, BR-U6-9).
 */
export interface CommandResult {
  step?: Step;
  data: object;
  /** Human-readable stdout 结果 text (NOT progress — that goes to stderr). */
  text: string;
  /** Exit code override (default 0). Only check uses this (BR-U6-9). */
  exitCode?: number;
}

/** Builds the success envelope. */
export function ok(data?: object, step?: Step): JsonEnvelope {
  const envelope: JsonEnvelope = { ok: true };
  if (step !== undefined) envelope.step = step;
  if (data !== undefined) envelope.data = data;
  return envelope;
}

/** Own-property keys that never belong in the error context. */
const EXCLUDED_CONTEXT_KEYS = new Set(["name", "message", "stack"]);

/**
 * Builds the failure envelope from any thrown value. AppError instances
 * contribute their class name as `type` and their enumerable own fields
 * (exitCode, violations, argv/stderr, backend/segmentIndex, ...) as
 * `context` — the skills-facing diagnostic surface.
 */
export function err(error: unknown): JsonEnvelope {
  if (error instanceof AppError) {
    const context: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(error)) {
      if (EXCLUDED_CONTEXT_KEYS.has(key) || typeof value === "function") {
        continue;
      }
      context[key] = value;
    }
    return {
      ok: false,
      error: { type: error.name, message: error.message, context },
    };
  }
  return {
    ok: false,
    error: {
      type: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      context: {},
    },
  };
}
