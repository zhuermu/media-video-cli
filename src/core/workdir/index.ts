/**
 * @module @core/workdir
 *
 * Working-directory layout, state.json index, and idempotence checks for a
 * single video pipeline run (`videos/<slug>/`).
 *
 * Boundary rules honored here:
 * - BR-U1-1: slug must match `^[a-z0-9][a-z0-9-]{1,63}$`.
 * - BR-U1-2 (Q2=A): existing target directory is rejected, never renamed.
 * - BR-U1-3 (ADR-004): every state.json write is `.tmp` then atomic rename.
 * - BR-U1-4 (Q1=A): a step recorded in state.json with missing artifacts is
 *   an invariant breach -> IoError suggesting `--rebuild-state`.
 * - BR-U1-5 (ADR-004): rebuildState trusts artifact existence only
 *   (products are the truth; state.json is just an index).
 * - BR-U1-8: all path construction converges here via `VideoDir.paths`;
 *   other modules never string-concat paths.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { IoError, NotFoundError, ValidationError } from "@core/errors";

// ---- Locked type contracts (component-methods.md 核心类型定义) ----

/** Pipeline steps — the enum domain of idempotence checks (FR-5.2). */
export type Step = "script" | "tts" | "compose" | "package";

/** Per-step completion record inside state.json. */
export interface StepRecord {
  completedAt: string;
  meta: Record<string, unknown>;
}

/** state.json shape — an index over artifacts, never the source of truth. */
export interface StateJson {
  slug: string;
  createdAt: string; // ISO 8601
  steps: Partial<Record<Step, StepRecord>>;
}

/** A video's workspace locator: the single source of all pipeline paths. */
export interface VideoDir {
  slug: string;
  root: string;
  paths: {
    input: string;
    script: string;
    audio: string;
    cards: string;
    video: string;
    pkg: string;
  };
  state: StateJson;
}

/** Source material reference consumed by {@link initVideo}. */
export interface InputRef {
  kind: "article" | "topic";
  ref: string;
}

// ---- Constants ----

/** BR-U1-1: kebab-case slug, 2-64 chars, no leading hyphen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const STATE_FILE = "state.json";

/** Common options: where video workspaces live (defaults align with config). */
export interface WorkdirOptions {
  /** Root directory holding `videos/<slug>/`. Default: $VIDEOS_ROOT or ./videos. */
  videosRoot?: string;
}

function resolveVideosRoot(options?: WorkdirOptions): string {
  return resolve(
    options?.videosRoot ?? process.env["VIDEOS_ROOT"] ?? "./videos",
  );
}

function buildVideoDir(slug: string, root: string, state: StateJson): VideoDir {
  return {
    slug,
    root,
    paths: {
      input: join(root, "input"),
      script: join(root, "script"),
      audio: join(root, "audio"),
      cards: join(root, "cards"),
      video: join(root, "video"),
      pkg: join(root, "package"),
    },
    state,
  };
}

// ---- Atomic write (BR-U1-3) ----

/** Writes JSON via `.tmp` + atomic rename (ADR-004 half-write protection). */
async function writeStateAtomic(root: string, state: StateJson): Promise<void> {
  const target = join(root, STATE_FILE);
  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  } catch (cause) {
    throw new IoError(`state.json 写入失败: ${target}`, { cause });
  }
}

// ---- Artifact checklists (Workflow 2 product manifests) ----

/**
 * Returns the missing-artifact list for `step` assuming it were complete.
 * Empty array means the step's product checklist is fully satisfied.
 *
 * Checklist (business-logic-model Workflow 2):
 * - script:  script/script.json + script/script.md
 * - tts:     audio/durations.json + audio/merged.m4a + seg-*.mp3 (>=1;
 *            per-segment count validation is owned by U2's durations.json)
 * - compose: video/video.mp4
 * - package: package/manifest.json + package/SUMMARY.md
 */
export function missingArtifacts(dir: VideoDir, step: Step): string[] {
  const missing: string[] = [];
  const require = (path: string): void => {
    if (!existsSync(path)) missing.push(path);
  };

  switch (step) {
    case "script":
      require(join(dir.paths.script, "script.json"));
      require(join(dir.paths.script, "script.md"));
      break;
    case "tts": {
      require(join(dir.paths.audio, "durations.json"));
      require(join(dir.paths.audio, "merged.m4a"));
      if (listSegmentAudioFiles(dir).length === 0) {
        missing.push(join(dir.paths.audio, "seg-*.mp3"));
      }
      break;
    }
    case "compose":
      require(join(dir.paths.video, "video.mp4"));
      break;
    case "package":
      require(join(dir.paths.pkg, "manifest.json"));
      require(join(dir.paths.pkg, "SUMMARY.md"));
      break;
  }
  return missing;
}

function listSegmentAudioFiles(dir: VideoDir): string[] {
  if (!existsSync(dir.paths.audio)) return [];
  return readdirSync(dir.paths.audio).filter((name) =>
    /^seg-.+\.mp3$/.test(name),
  );
}

// ---- Public API (component-methods.md workdir table) ----

/**
 * Creates `videos/<slug>/` layout and persists the input material
 * (Workflow 1). Validation happens before any directory is created so a
 * rejected call leaves no residue.
 *
 * @throws ValidationError invalid slug (BR-U1-1), existing directory
 *         (BR-U1-2, Q2=A), non-.md article ref, or empty topic.
 * @throws NotFoundError article file does not exist.
 */
export async function initVideo(
  slug: string,
  input: InputRef,
  options?: WorkdirOptions,
): Promise<VideoDir> {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError(
      `slug 非法: "${slug}"（要求 kebab-case，匹配 ${SLUG_PATTERN}）`,
    );
  }

  const root = resolve(resolveVideosRoot(options), slug);
  if (existsSync(root)) {
    throw new ValidationError(
      `工作目录已存在: ${root}。请使用 load 载入，或换一个 slug（不自动改名）`,
    );
  }

  // InputRef validation (FR-1 AC-3 的 U1 半边) — before mkdir, fail fast.
  if (input.kind === "article") {
    if (!input.ref.endsWith(".md")) {
      throw new ValidationError(`article 素材必须是 .md 文件: ${input.ref}`);
    }
    if (!existsSync(input.ref)) {
      throw new NotFoundError(`article 素材文件不存在: ${input.ref}`);
    }
  } else if (input.ref.trim().length === 0) {
    throw new ValidationError("topic 不能为空");
  }

  const state: StateJson = {
    slug,
    createdAt: new Date().toISOString(),
    steps: {},
  };
  const dir = buildVideoDir(slug, root, state);

  try {
    await Promise.all(
      Object.values(dir.paths).map((p) => mkdir(p, { recursive: true })),
    );
    if (input.kind === "article") {
      // Preserve the original file name inside input/ (data-transformation rule).
      copyFileSync(input.ref, join(dir.paths.input, basename(input.ref)));
    } else {
      await writeFile(
        join(dir.paths.input, "topic.txt"),
        `${input.ref}\n`,
        "utf8",
      );
    }
  } catch (cause) {
    throw new IoError(`工作目录初始化失败: ${root}`, { cause });
  }

  await writeStateAtomic(root, state);
  return dir;
}

/**
 * Loads an existing working directory and its state.json.
 *
 * @throws NotFoundError directory or state.json missing.
 * @throws IoError state.json unreadable/unparseable (suggests --rebuild-state).
 */
export async function load(
  slug: string,
  options?: WorkdirOptions,
): Promise<VideoDir> {
  const root = resolve(resolveVideosRoot(options), slug);
  const statePath = join(root, STATE_FILE);
  if (!existsSync(root) || !existsSync(statePath)) {
    throw new NotFoundError(`工作目录不存在: ${root}（先 init，或检查 slug）`);
  }

  let state: StateJson;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as StateJson;
  } catch (cause) {
    throw new IoError(
      `state.json 解析失败: ${statePath}。可运行 --rebuild-state 依产物重建`,
      { cause },
    );
  }
  return buildVideoDir(slug, root, state);
}

/**
 * Idempotence check (Workflow 2, FR-5.2): is this step already done with a
 * complete product checklist?
 *
 * Truth table:
 * - not recorded in state            -> false (caller executes the step)
 * - recorded + all artifacts present -> true  (caller skips the step)
 * - recorded + artifacts missing     -> IoError (invariant breach, Q1=A;
 *                                       message suggests --rebuild-state)
 */
export function stepDone(dir: VideoDir, step: Step): boolean {
  if (dir.state.steps[step] === undefined) return false;

  const missing = missingArtifacts(dir, step);
  if (missing.length > 0) {
    throw new IoError(
      `state.json 声明步骤 "${step}" 已完成，但产物缺失: ${missing.join(
        ", ",
      )}。state 与磁盘不一致，请运行 --rebuild-state 重建状态索引`,
    );
  }
  return true;
}

/**
 * Records a completed step into state.json (atomic write, BR-U1-3) and
 * updates the in-memory VideoDir.
 *
 * @throws IoError on write failure.
 */
export async function markStep(
  dir: VideoDir,
  step: Step,
  meta: Record<string, unknown>,
): Promise<void> {
  const record: StepRecord = { completedAt: new Date().toISOString(), meta };
  const nextState: StateJson = {
    ...dir.state,
    steps: { ...dir.state.steps, [step]: record },
  };
  await writeStateAtomic(dir.root, nextState);
  dir.state = nextState;
}

/**
 * Asserts the state invariant over every recorded step: recorded => product
 * checklist complete (state ⊆ artifacts; state may under-record, never
 * over-record).
 *
 * @throws IoError listing every breach, suggesting --rebuild-state (BR-U1-4).
 */
export function verifyState(dir: VideoDir): void {
  const breaches: string[] = [];
  for (const step of Object.keys(dir.state.steps) as Step[]) {
    const missing = missingArtifacts(dir, step);
    if (missing.length > 0) {
      breaches.push(`步骤 "${step}" 缺产物: ${missing.join(", ")}`);
    }
  }
  if (breaches.length > 0) {
    throw new IoError(
      `state.json 不变式破坏（state 声明完成但产物缺失）：${breaches.join(
        "；",
      )}。请运行 --rebuild-state 重建状态索引`,
    );
  }
}

/** Rebuild summary returned by {@link rebuildState}. */
export interface RebuildResult {
  state: StateJson;
  /** Steps judged complete by the artifact scan. */
  rebuiltSteps: Step[];
}

/**
 * Rebuilds state.json from artifact existence alone (Workflow 3, BR-U1-5:
 * products are the truth). completedAt = latest mtime among the step's
 * checklist artifacts; meta = { rebuilt: true }. Atomic write-back.
 */
export async function rebuildState(dir: VideoDir): Promise<RebuildResult> {
  const steps: Partial<Record<Step, StepRecord>> = {};
  const rebuiltSteps: Step[] = [];

  for (const step of ["script", "tts", "compose", "package"] as Step[]) {
    if (missingArtifacts(dir, step).length > 0) continue;
    steps[step] = {
      completedAt: latestArtifactMtime(dir, step).toISOString(),
      meta: { rebuilt: true },
    };
    rebuiltSteps.push(step);
  }

  const nextState: StateJson = { ...dir.state, steps };
  await writeStateAtomic(dir.root, nextState);
  dir.state = nextState;
  return { state: nextState, rebuiltSteps };
}

/** Latest mtime among a (complete) step's checklist artifacts. */
function latestArtifactMtime(dir: VideoDir, step: Step): Date {
  const files: string[] = [];
  switch (step) {
    case "script":
      files.push(
        join(dir.paths.script, "script.json"),
        join(dir.paths.script, "script.md"),
      );
      break;
    case "tts":
      files.push(
        join(dir.paths.audio, "durations.json"),
        join(dir.paths.audio, "merged.m4a"),
      );
      break;
    case "compose":
      files.push(join(dir.paths.video, "video.mp4"));
      break;
    case "package":
      files.push(
        join(dir.paths.pkg, "manifest.json"),
        join(dir.paths.pkg, "SUMMARY.md"),
      );
      break;
  }
  let latest = new Date(0);
  for (const file of files) {
    const mtime = statSync(file).mtime;
    if (mtime > latest) latest = mtime;
  }
  return latest;
}
