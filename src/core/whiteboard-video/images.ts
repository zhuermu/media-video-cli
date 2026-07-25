/**
 * @module core/whiteboard-video/images
 *
 * 装载期的图片处理：外部位图 → 内联 data URI，以及给版式用的真实宽高比。
 *
 * 两条约束决定了这个模块必须存在：
 *
 * 1. **不能给 resvg 传 `resourcesDir`**（实测每帧 75ms → 608ms，见
 *    assets/ASSETS.md），所以图片只能内联进 SVG；
 * 2. 直接内联原图意味着 resvg **每帧**都要重解一张 1400×580 的 PNG，而且
 *    每帧 SVG 里都背着几百 KB base64。
 *
 * 于是在装载期缩一次、缓存住，之后一万多帧都省下来。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { pngSize } from "./hand";
import type { Log } from "./log";

/** 原图不比显示尺寸大这么多就直接用（放大只会更糊、更慢）. */
const UPSCALE_TOLERANCE = 1.15;

/** 读不出尺寸时的退化宽高比. */
const FALLBACK_ASPECT = 1.6;

/**
 * 图片装载器：同一路径 + 同一目标宽度只解一次。
 *
 * 做成实例而不是模块级 Map，是为了让同一进程里的两次渲染互不干扰 ——
 * 模块级缓存在单次 CLI 调用里没问题，但测试和批量渲染会串味。
 */
export class ImageLoader {
  private readonly cache = new Map<string, string>();

  constructor(private readonly log: Log = () => {}) {}

  /** 缩到 `targetW` 后的 data URI. */
  uri(path: string, targetW: number): string {
    const key = `${path}@${Math.round(targetW)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const size = isPng(path) ? pngSize(path) : null;
    const mime = isPng(path) ? "image/png" : "image/jpeg";
    const raw = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
    if (size === null || size.w <= targetW * UPSCALE_TOLERANCE) {
      this.cache.set(key, raw);
      return raw;
    }

    const w = Math.round(targetW);
    const h = Math.max(1, Math.round((size.h * w) / size.w));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<image href="${raw}" x="0" y="0" width="${w}" height="${h}"/></svg>`;
    const png = new Resvg(svg, { font: { loadSystemFonts: false } })
      .render()
      .asPng();
    const out = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    this.log(
      `    图片缩放 ${basename(path)} ${size.w}×${size.h} → ${w}×${h}` +
        `（${kb(raw)} → ${kb(out)} base64）`,
    );
    this.cache.set(key, out);
    return out;
  }
}

/**
 * 图片宽高比。
 *
 * 必须按真实比例给框，不能用固定值：架构图是 2.1–2.5 的宽图，照片是 1.5 的
 * 横图，用同一个框会让其中一类在框里留出大片空白 —— 而框是画出来的，空白
 * 很显眼。PNG 直接读 IHDR；其他格式读不出就退化。
 */
export function imageAspect(path: string): number {
  const size = isPng(path) ? pngSize(path) : null;
  return size === null ? FALLBACK_ASPECT : size.w / size.h;
}

function isPng(path: string): boolean {
  return /\.png$/i.test(path);
}

function kb(dataUri: string): string {
  return `${(dataUri.length / 1024).toFixed(0)}KB`;
}
