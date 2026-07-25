/**
 * PoC: 流水线素材匹配段 —— 关键词 → 扁平插画
 *
 * `assets/manypixels/index.json` 有 2362 条，每条带 `name / category /
 * keywords`，文件落在 `svg/<style>/<slug>.svg`。这一段的任务是把"这一屏要
 * 讲什么"变成"用哪张图"。
 *
 * ## 查询词由上游给，不在这里猜
 *
 * 素材库的关键词是英文，文章是中文。这里**不做**中英映射：那需要词表或
 * 模型，两者都属于上游（LLM 拆分章节时顺手输出英文检索词，它本来就在读
 * 全文，比事后猜关键词准得多）。所以 `Section` 带的是一串英文查询词，
 * 本模块只负责"给定查询词，从 2362 条里挑最合适的一条"。
 *
 * 早先的 demo 是按 `il-0${idx}.svg` 顺序取图 —— 讲"配音说了算"配了张打棒球
 * 的插画。观众不会觉得这是随机，只会觉得这个作者不用心。
 *
 * ## 风格必须锁一种
 *
 * 五种画风（Azureline / Birdview / …）线宽和配色体系都不同，同一条视频里
 * 混用会像拼贴。默认锁 `Azureline`（线条 + 少量填色，最接近白板手绘）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 索引里的一条插画. */
interface IndexEntry {
  slug: string;
  name: string;
  category: string;
  style: string;
  keywords?: string[];
}

/** 匹配结果. */
export interface IllustrationMatch {
  path: string;
  slug: string;
  name: string;
  /** 命中分（调试用：分低说明查询词和库对不上，该换词或换库）. */
  score: number;
}

/** 默认画风（见模块注释：同片必须锁一种）. */
export const DEFAULT_STYLE = "Azureline";

let cache: IndexEntry[] | null = null;

function loadIndex(dir: string): IndexEntry[] {
  if (cache !== null) return cache;
  const p = join(dir, "index.json");
  if (!existsSync(p)) {
    cache = [];
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(p, "utf8")) as IndexEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

/** slug 尾部的数字是库里的编号，不是语义，评分时要剥掉. */
function slugWords(slug: string): string[] {
  return slug
    .replace(/-\d+$/, "")
    .split("-")
    .filter((w) => w !== "");
}

/**
 * 按查询词挑一张插画。
 *
 * 评分（越具体的命中给越高分，避免"technology"这种大词把所有科技图都拉平）：
 * - 查询词等于某个 keyword / slug 词：+4
 * - 查询词是 name（小写）的子串：+3
 * - 查询词是某个 keyword 的子串（或反之）：+2
 * - 查询词等于 category：+1
 *
 * 同分按 slug 字典序取首个 —— 同一份输入每次跑必须挑到同一张图，否则
 * 没法判断画面变化是改对了还是素材漂了。
 *
 * @returns null = 一条都没命中（调用方应退化为纯文字版式，不要硬塞一张图）
 */
export function matchIllustration(
  dir: string,
  queries: readonly string[],
  style: string = DEFAULT_STYLE,
): IllustrationMatch | null {
  const entries = loadIndex(dir);
  if (entries.length === 0 || queries.length === 0) return null;
  const qs = queries.map((q) => q.trim().toLowerCase()).filter((q) => q !== "");
  if (qs.length === 0) return null;

  let best: IllustrationMatch | null = null;
  for (const e of entries) {
    if (e.style !== style) continue;
    const path = join(dir, "svg", e.style, `${e.slug}.svg`);
    if (!existsSync(path)) continue;

    const name = e.name.toLowerCase();
    const kws = (e.keywords ?? []).map((k) => k.toLowerCase());
    const words = slugWords(e.slug);
    let score = 0;
    for (const q of qs) {
      if (kws.includes(q) || words.includes(q)) score += 4;
      else if (name.includes(q)) score += 3;
      else if (kws.some((k) => k.includes(q) || q.includes(k))) score += 2;
      else if (e.category.toLowerCase() === q) score += 1;
    }
    if (score === 0) continue;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && e.slug < best.slug)
    ) {
      best = { path, slug: e.slug, name: e.name, score };
    }
  }
  return best;
}
