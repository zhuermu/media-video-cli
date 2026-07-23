/**
 * @module @adapters/ffmpeg (run)
 *
 * THIN subprocess executor — deliberately logic-free glue around Bun.spawn.
 * Excluded from the coverage denominator (bunfig coveragePathIgnorePatterns:
 * `src/adapters/**\/run*.ts`) per team.md Testing Posture; exercised by the
 * integration smoke tests when ffmpeg is installed.
 *
 * Boundary rules honored here:
 * - BR-U2-7: spawn takes argv ARRAYS only, never a shell string; every
 *   FfmpegError carries the full argv + the stderr tail (last 4KB).
 * - BR-U2-8: caller passes the per-operation timeout (compose 300s /
 *   concat 60s / probe 10s, see FFMPEG_TIMEOUTS); on timeout the process
 *   is killed and the error message says so.
 */

import { FfmpegError, ValidationError } from "@core/errors";

import { FFMPEG_TIMEOUTS } from "./types";

/** Kept stderr tail size — enough to diagnose, bounded in memory. */
const STDERR_TAIL_BYTES = 4096;

/** Execution options for {@link runFfmpeg} / {@link runCaptureStdout}. */
export interface RunOptions {
  /** Kill the subprocess after this many seconds (BR-U2-8). */
  timeoutSec: number;
}

/**
 * Executes an ffmpeg argv (from a pure builder) to completion, discarding
 * stdout. Defaults to the compose timeout (the largest in the locked table)
 * when no options are given, honoring the locked one-arg signature.
 *
 * @throws FfmpegError on spawn failure, non-zero exit, or timeout (killed).
 */
export async function runFfmpeg(
  argv: string[],
  options: RunOptions = { timeoutSec: FFMPEG_TIMEOUTS.composeSec },
): Promise<void> {
  await execute(argv, options, false);
}

/**
 * Executes an argv and returns captured stdout text (ffprobe JSON path).
 *
 * @throws FfmpegError on spawn failure, non-zero exit, or timeout (killed).
 */
export async function runCaptureStdout(
  argv: string[],
  options: RunOptions = { timeoutSec: FFMPEG_TIMEOUTS.probeSec },
): Promise<string> {
  return execute(argv, options, true);
}

async function execute(
  argv: string[],
  options: RunOptions,
  captureStdout: boolean,
): Promise<string> {
  if (argv.length === 0 || argv[0]!.length === 0) {
    throw new ValidationError("子进程 argv 为空");
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: argv,
      stdin: "ignore",
      stdout: captureStdout ? "pipe" : "ignore",
      stderr: "pipe",
    });
  } catch (cause) {
    throw new FfmpegError(`子进程启动失败: ${argv[0]}`, {
      argv,
      stderr: "",
      cause,
    });
  }

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutSec * 1000);

  try {
    const stderrPromise = readTail(
      proc.stderr as ReadableStream<Uint8Array> | undefined,
    );
    const stdoutPromise = captureStdout
      ? new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      : Promise.resolve("");

    const exitCode = await proc.exited;
    const stderr = await stderrPromise;
    const stdout = await stdoutPromise;

    if (timedOut) {
      throw new FfmpegError(
        `${argv[0]} 超时（${options.timeoutSec}s 上限，进程已 kill，BR-U2-8）`,
        { argv, stderr },
      );
    }
    if (exitCode !== 0) {
      throw new FfmpegError(`${argv[0]} 退出码 ${exitCode}`, { argv, stderr });
    }
    return stdout;
  } finally {
    clearTimeout(killTimer);
  }
}

/** Streams stderr keeping only the last {@link STDERR_TAIL_BYTES} bytes. */
async function readTail(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (stream === undefined) return "";
  let tail = new Uint8Array(0);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(tail.length + value.length);
    joined.set(tail);
    joined.set(value, tail.length);
    tail =
      joined.length > STDERR_TAIL_BYTES
        ? joined.slice(joined.length - STDERR_TAIL_BYTES)
        : joined;
  }
  return new TextDecoder().decode(tail);
}
