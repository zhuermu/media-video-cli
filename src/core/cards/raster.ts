/**
 * @module @core/cards (raster)
 *
 * rasterize — SVG string → PNG file via @resvg/resvg-js (the single new
 * npm rendering dependency, pinned exactly per BR-U4-12 / lockfile
 * mandate).
 *
 * Font strategy: prefer the macOS system PingFang (matches the default
 * template's fontFamily, zero distribution burden); when that file is
 * absent (non-macOS dev box), fall back to loadSystemFonts so rendering
 * still works with whatever CJK font the host has.
 *
 * Boundary rules honored here:
 * - BR-U4-9 (shape): resvg failures → RenderError carrying the svg length
 *   and the page identifier (output file name).
 * - ADR-004: PNG is written `.tmp` then atomically renamed.
 */

import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { IoError, RenderError } from "@core/errors";

import type { PngFile } from "./types";

/** macOS system PingFang collection (default template's fontFamily). */
export const PINGFANG_FONT_PATH = "/System/Library/Fonts/PingFang.ttc";

/** Options for {@link rasterize}. */
export interface RasterizeOptions {
  /** Preferred font file. Default: {@link PINGFANG_FONT_PATH}. */
  fontPath?: string;
}

/**
 * Rasterizes an SVG string to a PNG at `outPath` (atomic `.tmp` → rename).
 *
 * @throws RenderError on any resvg failure (carries svg length + page id).
 * @throws IoError when the rendered PNG cannot be written.
 */
export async function rasterize(
  svg: string,
  outPath: string,
  options: RasterizeOptions = {},
): Promise<PngFile> {
  const fontPath = options.fontPath ?? PINGFANG_FONT_PATH;

  let png: Uint8Array;
  let width: number;
  let height: number;
  try {
    const resvg = new Resvg(svg, {
      font: existsSync(fontPath)
        ? { fontFiles: [fontPath], loadSystemFonts: false }
        : { loadSystemFonts: true },
    });
    const rendered = resvg.render();
    width = rendered.width;
    height = rendered.height;
    png = rendered.asPng();
  } catch (cause) {
    throw new RenderError(
      `SVG 栅格化失败: ${basename(outPath)}（svg 长度 ${svg.length} 字符）`,
      { cause },
    );
  }

  const tmp = `${outPath}.tmp`;
  try {
    await writeFile(tmp, png);
    await rename(tmp, outPath);
  } catch (cause) {
    throw new IoError(`PNG 写入失败: ${outPath}`, { cause });
  }

  return { path: outPath, width, height };
}
