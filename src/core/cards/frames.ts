/**
 * @module @core/cards (frames)
 *
 * renderCards — frame-sequence generation (Workflow 3): for every segment
 * and subtitle page, layout → SVG → rasterize (idempotent skip), allocate
 * per-frame display durations, persist `cards/frames.json`.
 *
 * Boundary rules honored here:
 * - BR-U4-5: Σ page durations = measured segment duration ±0.05s; the
 *   remainder folds into the LAST page. Violation = RenderError.
 * - BR-U4-6 (shape): callers must pass durations.json 实测值 — this module
 *   takes the measured numbers, never an estimate.
 * - BR-U4-10: stable frame naming `card-<seg>-<page>.png` (segment index
 *   zero-padded to 2 digits so (segment, page) lexicographic order holds
 *   for the whole 3-20 segment domain) — existing file = skip (FR-5.2).
 * - ADR-004: frames.json is written `.tmp` then atomically renamed; the
 *   persisted content equals the returned RenderFrame[] (idempotent re-run
 *   and human review anchor).
 * - 背景照片幂等提醒（可接受的简化，文档化取舍）：带 backgroundImage 的
 *   段，其 PNG 内容还取决于照片文件本身，但跳过判定仍只看
 *   card-NN-*.png 是否存在——更换/修改照片文件后需手动删除受影响的
 *   card-NN-*.png 再重跑才能生效。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { IoError, NotFoundError, RenderError, ValidationError } from "@core/errors";
import type { RenderFrame } from "@core/render";
import type { Script } from "@core/script";
import type { VideoDir } from "@core/workdir";

import { layoutCard } from "./layout";
import { rasterize } from "./raster";
import { buildCardSvg } from "./svg";
import type { CardLayout, CardTemplate, PngFile } from "./types";

/** Persisted frame table file name (inside `VideoDir.paths.cards`). */
export const FRAMES_FILE = "frames.json";

/** BR-U4-5: |Σ page durations − segment duration| tolerance (seconds). */
export const FRAME_SUM_TOLERANCE_SEC = 0.05;

/** Injectable seams for {@link renderCards} (offline unit tests). */
export interface RenderCardsOptions {
  /** Rasterizer. Default: the real resvg-backed {@link rasterize}. */
  rasterizeFn?: (svg: string, outPath: string) => Promise<PngFile>;
}

/** Stable frame file name (BR-U4-10): card-<seg 2 位>-<page>.png. */
export function frameFileName(segmentIndex: number, pageIndex: number): string {
  return `card-${String(segmentIndex).padStart(2, "0")}-${pageIndex}.png`;
}

/**
 * Resolves a segment's backgroundImage to an absolute path: 绝对路径原样
 * 通过；相对路径按 `<workdir>/input/images/` 解析（schema 契约，
 * script/types.ts Segment.backgroundImage）.
 */
export function resolveBackgroundImagePath(raw: string, dir: VideoDir): string {
  return isAbsolute(raw) ? raw : join(dir.paths.input, "images", raw);
}

/** backgroundImage 扩展名 → data URI mime（扩展名域已由 validateScript 限定）. */
function mimeFromExtension(path: string): string {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

/**
 * Loads a (resolved, absolute) background image as a base64 data URI,
 * cached by path — 同一照片被多段引用时只读一次文件.
 *
 * @throws NotFoundError when the file does not exist (message lists the
 *         expected images directory so the fix is actionable).
 * @throws IoError when the file exists but cannot be read.
 */
async function loadBackgroundImageDataUri(
  resolved: string,
  raw: string,
  segmentIndex: number,
  dir: VideoDir,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(resolved);
  if (cached !== undefined) return cached;

  if (!existsSync(resolved)) {
    throw new NotFoundError(
      `段 ${segmentIndex} 背景图不存在: ${resolved}` +
        `（backgroundImage "${raw}"；相对路径请把图片放进 ` +
        `${join(dir.paths.input, "images")}，或改用绝对路径）`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (cause) {
    throw new IoError(`段 ${segmentIndex} 背景图读取失败: ${resolved}`, {
      cause,
    });
  }
  const dataUri = `data:${mimeFromExtension(resolved)};base64,${bytes.toString("base64")}`;
  cache.set(resolved, dataUri);
  return dataUri;
}

/** Code-point count of one subtitle page (its lines joined). */
function pageCharCount(page: string[]): number {
  return page.reduce((sum, line) => sum + [...line].length, 0);
}

/** Rounds to 0.01s (决策树: 帧时长精度规则). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 决策树: allocates one segment's measured duration across its subtitle
 * pages by character share (0.01s rounding, remainder folded into the last
 * page). n=1 → the full segment duration.
 *
 * @throws RenderError when the BR-U4-5 invariant breaks (defensive: the
 *         remainder rule makes the sum exact by construction) or a page
 *         would get a non-positive duration.
 */
export function allocatePageDurations(
  layout: CardLayout,
  segmentDuration: number,
  segmentIndex: number,
): number[] {
  const pages = layout.subtitlePages;
  if (pages.length === 1) return [round2(segmentDuration)];

  const counts = pages.map(pageCharCount);
  const total = counts.reduce((a, b) => a + b, 0);
  const durations: number[] = [];
  let allocated = 0;
  for (let p = 0; p < pages.length - 1; p++) {
    const share = round2(segmentDuration * (counts[p]! / total));
    durations.push(share);
    allocated = round2(allocated + share);
  }
  durations.push(round2(segmentDuration - allocated)); // 余数并入末页

  const sum = durations.reduce((a, b) => round2(a + b), 0);
  if (Math.abs(sum - segmentDuration) > FRAME_SUM_TOLERANCE_SEC) {
    throw new RenderError(
      `帧时长不变式破坏（BR-U4-5）: 段 ${segmentIndex} Σ页时长 ${sum}s ≠ 段实测 ${segmentDuration}s（容差 ±${FRAME_SUM_TOLERANCE_SEC}s）`,
    );
  }
  if (durations.some((d) => d <= 0)) {
    throw new RenderError(
      `帧时长分配异常: 段 ${segmentIndex} 出现非正页时长 [${durations.join(", ")}]`,
    );
  }
  return durations;
}

/**
 * Workflow 3: full-script card frame rendering (idempotent).
 *
 * For segment i, page p: skip when `card-<i>-<p>.png` exists; otherwise
 * layoutCard → buildCardSvg → rasterize (atomic write inside). Display
 * durations always come from `segmentDurations` (measured), recomputed on
 * every run so a re-run with fresh durations updates frames.json even when
 * every PNG is skipped.
 *
 * 背景照片：segment.backgroundImage 在此解析为绝对路径（相对 →
 * input/images/），并在该段确有页面需要渲染时读文件 + base64 一次
 * （按路径缓存），经 layout.backgroundImageDataUri 送入 buildCardSvg——
 * SVG 生成保持纯函数（BR-U4-8）。全部页面已存在（幂等跳过）时不读照片，
 * 见模块头的幂等提醒。
 *
 * @param segmentDurations durations.json 实测逐段秒数（BR-U4-6 — 禁用估算值）.
 * @throws ValidationError on segment/duration mismatch or non-positive durations.
 * @throws NotFoundError when a segment's background image file is missing.
 * @throws RenderError from rasterization or the BR-U4-5 invariant.
 * @throws IoError when frames.json cannot be written or a background image
 *         cannot be read.
 */
export async function renderCards(
  script: Script,
  segmentDurations: number[],
  template: CardTemplate,
  dir: VideoDir,
  options: RenderCardsOptions = {},
): Promise<RenderFrame[]> {
  if (segmentDurations.length !== script.segments.length) {
    throw new ValidationError(
      `segmentDurations 长度 ${segmentDurations.length} ≠ 段数 ${script.segments.length}（须来自 durations.json 实测，BR-U4-6）`,
    );
  }
  for (const [i, duration] of segmentDurations.entries()) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ValidationError(
        `segmentDurations[${i}] 非法: ${duration}（要求正的有限秒数）`,
      );
    }
  }

  const rasterizeFn = options.rasterizeFn ?? rasterize;
  const cardsDir = dir.paths.cards;
  try {
    await mkdir(cardsDir, { recursive: true });
  } catch (cause) {
    throw new IoError(`cards 目录创建失败: ${cardsDir}`, { cause });
  }

  const frames: RenderFrame[] = [];
  const backgroundDataUriCache = new Map<string, string>();
  for (const [i, segment] of script.segments.entries()) {
    const layout = layoutCard(segment, segment.text, template);
    if (layout.backgroundImage !== undefined) {
      layout.backgroundImage = resolveBackgroundImagePath(
        layout.backgroundImage,
        dir,
      );
    }
    const pageDurations = allocatePageDurations(
      layout,
      segmentDurations[i]!,
      i,
    );

    for (let p = 0; p < layout.subtitlePages.length; p++) {
      const path = join(cardsDir, frameFileName(i, p));
      if (!existsSync(path)) {
        // 惰性读照片：该段首个需渲染的页面触发一次（跨段按路径缓存）。
        if (
          layout.backgroundImage !== undefined &&
          layout.backgroundImageDataUri === undefined
        ) {
          layout.backgroundImageDataUri = await loadBackgroundImageDataUri(
            layout.backgroundImage,
            segment.backgroundImage!,
            i,
            dir,
            backgroundDataUriCache,
          );
        }
        const svg = buildCardSvg(layout, p, template);
        await rasterizeFn(svg, path);
      }
      frames.push({ path, displaySec: pageDurations[p]! });
    }
  }

  // Persist the frame table (same content as the return value, ADR-004).
  const framesPath = join(cardsDir, FRAMES_FILE);
  const tmp = `${framesPath}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(frames, null, 2)}\n`, "utf8");
    await rename(tmp, framesPath);
  } catch (cause) {
    throw new IoError(`frames.json 写入失败: ${framesPath}`, { cause });
  }

  return frames;
}
