/**
 * @module @core/whiteboard (sfx)
 *
 * 音效体系（Q6=C 裁定）：音效文件来自免版税库、人工挑选入库，
 * `assets/sfx/manifest.json` 是**授权追溯契约**——每条必须带非空
 * source + license（C12 红线：素材逐条可追溯），缺清单 = 纯口播，
 * 不是错误。BGM 不入库（发布时平台曲库人工配）。
 *
 * 本模块管：清单加载/校验（I/O 收敛在 loadSfxManifest）+ 混音事件
 * 规划（纯函数：笔活跃区间合并 → writing 铺垫段；运镜起点 → whoosh
 * 点位）。ffmpeg 混音 argv 由 @adapters/ffmpeg (mix) 生成。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NotFoundError, ValidationError } from "@core/errors";

import type { PenActiveSpan, WhiteboardPlan } from "./types";

/** 随仓库分发的默认清单位置（文件可以不存在——纯口播回退）. */
export const DEFAULT_SFX_MANIFEST_PATH = fileURLToPath(
  new URL("../../../assets/sfx/manifest.json", import.meta.url),
);

/**
 * 引擎消费的音效挂钩。
 *
 * 每一个都对应画面上一件**看得见**的事，声音只是它的听觉标记：
 * writing = 笔在板上、whoosh = 镜头平移、ding = 打勾、pop = 图形块入场、
 * page-turn = 收尾拉远看全景、sparkle = 强调标记（划掉 / 问号 / 圈出）。
 * 清单里其余 id（bell / click / writing-alt-blackboard）是库存备选。
 */
export const SFX_HOOK_IDS = [
  "writing",
  "whoosh",
  "ding",
  "pop",
  "page-turn",
  "sparkle",
] as const;

export type SfxId = (typeof SFX_HOOK_IDS)[number];

/** 一条入库音效（file 相对清单所在目录解析；id 任意非空，挂钩见 SfxId）. */
export interface SfxEntry {
  id: string;
  file: string;
  /** 来源（库名 + 页面/条目链接），非空——C12 追溯. */
  source: string;
  /** 许可证（如 CC0、Pixabay License），非空——C12 追溯. */
  license: string;
}

/** 解析后的清单：id → 绝对路径条目. */
export interface SfxManifest {
  entries: SfxEntry[];
  /** id 索引（重复 id 取首条）. */
  byId: Partial<Record<SfxId, SfxEntry>>;
}

/**
 * 加载音效清单。文件不存在 → undefined（合法：纯口播）。
 *
 * @throws ValidationError JSON/shape/授权字段缺失（列全所有问题）.
 * @throws NotFoundError 清单里引用的音效文件不存在.
 */
export async function loadSfxManifest(
  path: string = DEFAULT_SFX_MANIFEST_PATH,
): Promise<SfxManifest | undefined> {
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ValidationError(`音效清单不是合法 JSON: ${path}`, { cause });
  }

  const violations: string[] = [];
  const entries: SfxEntry[] = [];
  const rawEntries = (raw as Record<string, unknown>)?.["entries"];
  if (!Array.isArray(rawEntries)) {
    violations.push("entries: 必须为数组");
  } else {
    for (const [i, rawEntry] of rawEntries.entries()) {
      const at = `entries[${i}]`;
      if (typeof rawEntry !== "object" || rawEntry === null) {
        violations.push(`${at}: 必须为对象 { id, file, source, license }`);
        continue;
      }
      const e = rawEntry as Record<string, unknown>;
      if (typeof e["id"] !== "string" || e["id"].trim().length === 0) {
        violations.push(
          `${at}.id: 必须为非空字符串（"writing"/"whoosh" 为引擎挂钩，其余为库存素材）`,
        );
        continue;
      }
      for (const field of ["file", "source", "license"] as const) {
        if (typeof e[field] !== "string" || e[field].trim().length === 0) {
          violations.push(
            `${at}.${field}: 必须为非空字符串` +
              (field === "file" ? "" : "（C12 素材可追溯，缺授权不入库）"),
          );
        }
      }
      if (
        typeof e["file"] === "string" &&
        e["file"].length > 0 &&
        typeof e["source"] === "string" &&
        e["source"].trim().length > 0 &&
        typeof e["license"] === "string" &&
        e["license"].trim().length > 0
      ) {
        const resolved = isAbsolute(e["file"])
          ? e["file"]
          : join(dirname(path), e["file"]);
        entries.push({
          id: e["id"],
          file: resolved,
          source: e["source"],
          license: e["license"],
        });
      }
    }
  }
  if (violations.length > 0) {
    throw new ValidationError(
      `音效清单校验失败（${violations.length} 处）:\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
  }

  const byId: SfxManifest["byId"] = {};
  for (const entry of entries) {
    if (!existsSync(entry.file)) {
      throw new NotFoundError(
        `音效文件不存在: ${entry.file}（清单 ${path} 的 "${entry.id}"）`,
      );
    }
    if ((SFX_HOOK_IDS as readonly string[]).includes(entry.id)) {
      byId[entry.id as SfxId] ??= entry;
    }
  }
  return { entries, byId };
}

/** writing 铺垫段合并阈值：间隔小于该值的相邻笔活跃区间并为一段. */
export const WRITING_MERGE_GAP_SEC = 0.4;

/** 混音事件：writing 铺垫段（已合并）+ whoosh 点位（秒）. */
export interface SfxEvents {
  writingSpans: PenActiveSpan[];
  whooshTimes: number[];
}

/** 相邻区间合并（纯函数；输入须按 t0 升序）. */
export function mergeSpans(
  spans: readonly PenActiveSpan[],
  maxGap: number,
): PenActiveSpan[] {
  const out: PenActiveSpan[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && span.t0 - last.t1 <= maxGap) {
      last.t1 = Math.max(last.t1, span.t1);
    } else {
      out.push({ t0: span.t0, t1: span.t1 });
    }
  }
  return out;
}

/**
 * 由渲染规划推导混音事件（纯函数）：
 * - writing：penActive 合并（≤0.4s 间隔）后、且长度 ≥0.3s 的段；
 * - whoosh：每次运镜起点（含收尾 zoom-out）。
 */
export function planSfxEvents(plan: WhiteboardPlan): SfxEvents {
  const merged = mergeSpans(plan.penActive, WRITING_MERGE_GAP_SEC).filter(
    (s) => s.t1 - s.t0 >= 0.3 && s.t0 < plan.totalSec,
  );
  for (const span of merged) span.t1 = Math.min(span.t1, plan.totalSec);
  return {
    writingSpans: merged,
    whooshTimes: plan.camMoves
      .map((m) => m.t0)
      .filter((t) => t >= 0 && t < plan.totalSec),
  };
}
