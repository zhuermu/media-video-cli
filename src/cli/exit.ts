/**
 * @module cli/exit
 *
 * AppError → process exit-code mapping (ExitCodeMap, domain-entities.md).
 *
 * Boundary rules honored here:
 * - BR-U1-10: the exit-code table (2-10) is locked in @core/errors; every
 *   AppError subclass carries its own exitCode — this module is the single
 *   assembly-side consumer.
 * - BR-U6-1: this module only MAPS; the one and only process.exit call
 *   site is main.ts (不变式 2: 任何错误都有且仅有一次出口转换).
 */

import { AppError } from "@core/errors";

/**
 * Maps a thrown value to the process exit code: typed AppError → its
 * locked exitCode (2-10); anything else → 1 (未捕获异常兜底); success is 0.
 */
export function mapExitCode(error: unknown): number {
  return error instanceof AppError ? error.exitCode : 1;
}
