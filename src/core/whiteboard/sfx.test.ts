/**
 * @core/whiteboard sfx 单测：清单加载（缺省/坏 JSON/授权字段缺失/缺文件）、
 * 区间合并、事件规划。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotFoundError, ValidationError } from "@core/errors";

import { planWhiteboard } from "./scene";
import {
  loadSfxManifest,
  mergeSpans,
  planSfxEvents,
  WRITING_MERGE_GAP_SEC,
} from "./sfx";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wb-sfx-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(content: unknown): Promise<string> {
  const path = join(dir, "manifest.json");
  await writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
  return path;
}

describe("loadSfxManifest", () => {
  test("文件不存在 → undefined（纯口播合法回退）", async () => {
    expect(await loadSfxManifest(join(dir, "absent.json"))).toBeUndefined();
  });

  test("坏 JSON / entries 非数组被拒", async () => {
    expect(loadSfxManifest(await writeManifest("{oops"))).rejects.toThrow(
      ValidationError,
    );
    expect(loadSfxManifest(await writeManifest({}))).rejects.toThrow(
      "entries: 必须为数组",
    );
  });

  test("缺 source/license → 授权追溯违规（C12）", async () => {
    const path = await writeManifest({
      entries: [{ id: "writing", file: "w.wav", source: "", license: "CC0" }],
    });
    expect(loadSfxManifest(path)).rejects.toThrow("素材可追溯");
  });

  test("引用的音效文件不存在 → NotFoundError", async () => {
    const path = await writeManifest({
      entries: [
        {
          id: "whoosh",
          file: "missing.wav",
          source: "pixabay",
          license: "CC0",
        },
      ],
    });
    expect(loadSfxManifest(path)).rejects.toThrow(NotFoundError);
  });

  test("合法清单：相对路径按清单目录解析，byId 索引就位", async () => {
    await writeFile(join(dir, "w.wav"), "wav");
    const path = await writeManifest({
      entries: [
        { id: "writing", file: "w.wav", source: "pixabay#1", license: "CC0" },
      ],
    });
    const manifest = await loadSfxManifest(path);
    expect(manifest).toBeDefined();
    expect(manifest!.byId.writing!.file).toBe(join(dir, "w.wav"));
    expect(manifest!.byId.whoosh).toBeUndefined();
  });
});

describe("mergeSpans / planSfxEvents", () => {
  test("间隔 ≤ 阈值的相邻区间合并", () => {
    const merged = mergeSpans(
      [
        { t0: 0, t1: 1 },
        { t0: 1.2, t1: 2 },
        { t0: 3.5, t1: 4 },
      ],
      WRITING_MERGE_GAP_SEC,
    );
    expect(merged).toEqual([
      { t0: 0, t1: 2 },
      { t0: 3.5, t1: 4 },
    ]);
  });

  test("planSfxEvents：writing 段非空、whoosh 对齐运镜起点且都在片内", () => {
    const plan = planWhiteboard(
      [
        { elements: [{ type: "title", text: "开场" }] },
        { elements: [{ type: "icon", name: "check" }] },
        { elements: [{ type: "text", text: "收尾" }] },
      ],
      [5, 5, 6],
    );
    const events = planSfxEvents(plan);
    expect(events.writingSpans.length).toBeGreaterThan(0);
    for (const s of events.writingSpans) {
      expect(s.t1).toBeGreaterThan(s.t0);
      expect(s.t1).toBeLessThanOrEqual(plan.totalSec);
    }
    expect(events.whooshTimes).toEqual(plan.camMoves.map((m) => m.t0));
    for (const t of events.whooshTimes) {
      expect(t).toBeLessThan(plan.totalSec);
    }
  });
});
