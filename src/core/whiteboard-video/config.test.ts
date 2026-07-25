/**
 * @module core/whiteboard-video/config.test
 *
 * 默认值的回归网。
 *
 * 这些断言不是形式主义：帧目录和产物名的默认值曾经是固定常量
 * （`frames-pipeline` / 按体裁命名），两条视频并行渲染时后启动的那一轮会
 * `rm -rf` 掉前一轮的帧 —— 实测丢了 3804 帧，而日志显示"16137 帧"成功，
 * ffmpeg 只报 `No such file or directory`。默认值本身必须是安全的。
 */

import { describe, expect, test } from "bun:test";
import { basename, dirname, isAbsolute } from "node:path";

import {
  articleSlug,
  defaultAssetPaths,
  repoAssetsRoot,
  resolveRequest,
} from "./config";

describe("resolveRequest 默认值", () => {
  test("帧目录按文章名派生（并行渲染不互相清理）", () => {
    const a = resolveRequest({ articlePath: "/tmp/quick-sso.md" });
    const b = resolveRequest({ articlePath: "/tmp/lark-quick.md" });
    expect(basename(a.framesDir)).toBe("frames-quick-sso");
    expect(basename(b.framesDir)).toBe("frames-lark-quick");
    expect(a.framesDir).not.toBe(b.framesDir);
  });

  test("产物名前缀也按文章名派生（后完成的不覆盖先完成的）", () => {
    const a = resolveRequest({ articlePath: "/tmp/quick-sso.md" });
    const b = resolveRequest({ articlePath: "/tmp/lark-quick.md" });
    expect(a.tag).toBe("quick-sso");
    expect(b.tag).toBe("lark-quick");
  });

  test("工作目录落在文章所在目录下", () => {
    const r = resolveRequest({ articlePath: "/tmp/videos/demo.md" });
    expect(dirname(r.outDir)).toBe("/tmp/videos");
    expect(dirname(r.framesDir)).toBe("/tmp/videos");
    expect(r.cacheDir).toBe("/tmp/videos/cache/tts");
  });

  test("所有路径都解析成绝对路径", () => {
    const r = resolveRequest({
      articlePath: "src/core/whiteboard-video/../x.md",
    });
    for (const p of [
      r.articlePath,
      r.outDir,
      r.framesDir,
      r.stillsDir,
      r.cacheDir,
      r.assets.hands,
      r.assets.illustrations,
    ]) {
      expect(isAbsolute(p)).toBe(true);
    }
    expect(r.articlePath).not.toContain("..");
  });

  test("默认续跑、默认烧字幕、默认不强制体裁", () => {
    const r = resolveRequest({ articlePath: "/tmp/a.md" });
    expect(r.fresh).toBe(false);
    expect(r.burnSubtitles).toBe(true);
    expect(r.kind).toBeUndefined();
  });

  test("显式传入的值一律优先，且只覆盖传了的那一项", () => {
    const r = resolveRequest({
      articlePath: "/tmp/a.md",
      framesDir: "/var/frames",
      kind: "long",
      fresh: true,
      persona: "matt",
      assets: { hands: "/custom/hands" },
    });
    expect(r.framesDir).toBe("/var/frames");
    expect(r.kind).toBe("long");
    expect(r.fresh).toBe(true);
    expect(r.persona).toBe("matt");
    expect(r.assets.hands).toBe("/custom/hands");
    // 没传的那个库仍走默认
    expect(r.assets.illustrations).toBe(defaultAssetPaths().illustrations);
    // 没传的目录仍按文章名派生
    expect(basename(r.outDir)).toBe("out");
  });
});

describe("articleSlug", () => {
  test("剥掉 .md 扩展名（大小写都认）", () => {
    expect(articleSlug("/a/b/quick-sso.md")).toBe("quick-sso");
    expect(articleSlug("/a/b/Quick.MD")).toBe("Quick");
  });

  test("没有扩展名时原样返回", () => {
    expect(articleSlug("/a/b/plain")).toBe("plain");
  });
});

describe("素材根", () => {
  test("指向仓库自带的 assets/（与 core/whiteboard/sfx.ts 的约定一致）", () => {
    expect(isAbsolute(repoAssetsRoot())).toBe(true);
    expect(repoAssetsRoot().endsWith("/assets/")).toBe(true);
  });

  test("两个库按约定的子目录名找", () => {
    const p = defaultAssetPaths();
    expect(basename(p.hands)).toBe("sparkol");
    expect(basename(p.illustrations)).toBe("manypixels");
  });
});
