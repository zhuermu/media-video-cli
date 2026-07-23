/**
 * Fixture end-to-end smoke test (NFR-4, Bolt 收口判据; plan Step 7):
 * init → script validate → tts (SIMULATED, see below) → compose run
 * (REAL resvg + REAL ffmpeg) → metadata 五件 → package assemble +
 * validate → golden case (删 aigc-declaration.md → ContractViolationError)
 * → register add → report weekly，全链跑在 mkdtemp 的 VIDEOS_ROOT/DATA_ROOT
 * 里（hermetic，零残留）。
 *
 * TTS simulation note: the tts step is NOT run through a real TTS backend —
 * three tiny sine-wave mp3s are generated directly with ffmpeg as
 * seg-00..02.mp3, then @core/tts mergeAudio produces durations.json +
 * merged.m4a from real ffprobe measurements. This keeps the e2e chain
 * deterministic and offline (no network TTS); the backend synthesis paths
 * (retry policy, idempotence, error taxonomy) are covered by the U2 unit
 * tests. markStep("tts") is called manually to stand in for runTtsRun's
 * marking half.
 *
 * Skipped entirely when ffmpeg/ffprobe are not on PATH (BR-U6-3 的烟雾守护
 * 只在真实工具链可用时有意义). Budget: < 60s total (1.2s/段 fixtures).
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probe, runFfmpeg } from "@adapters/ffmpeg";
import { ContractViolationError } from "@core/errors";
import { mergeAudio, segmentFileName, type SegmentAudio } from "@core/tts";
import { load, markStep } from "@core/workdir";

import { runComposeRun } from "./commands/compose";
import { runInit } from "./commands/init";
import { runMetricsAdd } from "./commands/metrics";
import { runPackageAssemble, runPackageValidate } from "./commands/package";
import { runRegisterAdd } from "./commands/register";
import { runReportWeekly } from "./commands/report";
import { runScriptValidate } from "./commands/script";

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

const videosRoot = mkdtempSync(join(tmpdir(), "e2e-videos-"));
const dataRoot = mkdtempSync(join(tmpdir(), "e2e-data-"));
afterAll(() => {
  rmSync(videosRoot, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

const SLUG = "e2e-demo";

/** Compliant 3-segment script.json (embedded-schema shape, SKILL.md 步骤 3). */
function fixtureScript(articlePath: string): object {
  return {
    title: "bun 上手三步走",
    topic: "bun 运行时快速上手",
    segments: [
      { text: "bun 是一个很快的运行时", cardText: "bun 很快" },
      {
        text: "一条命令安装完就能用",
        cardText: "一条命令安装",
        emphasis: ["安装"],
      },
      { text: "自带测试器无需再配置", cardText: "自带测试器" },
    ],
    source: { kind: "article", ref: articlePath },
  };
}

/** Platform metadata file content with compliant frontmatter (titles 恰 3). */
function platformMetadata(platform: string): string {
  return [
    "---",
    "titles:",
    `  - bun 上手三步走（${platform}）`,
    "  - 三分钟学会 bun",
    "  - bun 快速入门",
    "tags: [bun, 教程]",
    "description: bun 运行时快速上手三步走",
    "---",
    "",
    `${platform} 正文文案：bun 上手三步走。`,
    "",
  ].join("\n");
}

describe.skipIf(!hasFfmpeg)(
  "e2e fixture pipeline (real ffmpeg + resvg)",
  () => {
    test("init → script → tts(simulated) → compose → package → golden case → register → report", async () => {
      // ---- init (U1 via CLI command) --------------------------------------
      const articlePath = join(videosRoot, "article.md");
      writeFileSync(
        articlePath,
        "# bun 上手小抄\n\nbun 是一个快速的 JavaScript 运行时。\n",
      );
      await runInit({ slug: SLUG, article: articlePath, videosRoot });

      // ---- script validate: script.md written + step marked ---------------
      const dir = await load(SLUG, { videosRoot });
      writeFileSync(
        join(dir.paths.script, "script.json"),
        JSON.stringify(fixtureScript(articlePath)),
      );
      const scriptResult = await runScriptValidate({ slug: SLUG, videosRoot });
      expect(scriptResult.step).toBe("script");
      expect(existsSync(join(dir.paths.script, "script.md"))).toBe(true);
      expect(
        (await load(SLUG, { videosRoot })).state.steps.script,
      ).toBeDefined();

      // ---- tts SIMULATION (see module header): sine mp3s + real mergeAudio -
      const segments: SegmentAudio[] = [];
      for (let i = 0; i < 3; i++) {
        const path = join(dir.paths.audio, segmentFileName(i));
        await runFfmpeg(
          [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=${440 + i * 110}:duration=1.2`,
            "-c:a",
            "libmp3lame",
            "-q:a",
            "9",
            path,
          ],
          { timeoutSec: 30 },
        );
        // BR-U2-3 discipline even in simulation: durations are ffprobe-measured.
        segments.push({
          index: i,
          audio: { path, durationSec: (await probe(path)).durationSec },
        });
      }
      const track = await mergeAudio(segments, dir);
      expect(existsSync(join(dir.paths.audio, "durations.json"))).toBe(true);
      expect(existsSync(track.path)).toBe(true);
      // Stand-in for runTtsRun's marking half (backend synthesis unit-tested).
      // Re-load first: `dir` was captured before runScriptValidate marked the
      // script step, and markStep writes back the whole state snapshot.
      const dirAfterTts = await load(SLUG, { videosRoot });
      await markStep(dirAfterTts, "tts", {
        backend: "fixture-sine",
        voice: "e2e",
        segments: segments.length,
        durationSec: track.durationSec,
      });

      // ---- compose run (REAL resvg raster + REAL ffmpeg compose) ----------
      const composeResult = await runComposeRun({ slug: SLUG, videosRoot });
      expect(composeResult.step).toBe("compose");
      const videoPath = join(dir.paths.video, "video.mp4");
      expect(existsSync(videoPath)).toBe(true);
      const videoInfo = await probe(videoPath);
      expect(videoInfo.width).toBe(1080);
      expect(videoInfo.height).toBe(1920);
      expect(
        (await load(SLUG, { videosRoot })).state.steps.compose,
      ).toBeDefined();

      // ---- metadata 五件 (compliant frontmatter, SKILL.md 步骤 6 契约) -----
      const metaDir = join(dir.paths.input, "metadata");
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        join(metaDir, "metadata-shipinhao.md"),
        platformMetadata("视频号"),
      );
      writeFileSync(
        join(metaDir, "metadata-douyin.md"),
        platformMetadata("抖音"),
      );
      writeFileSync(
        join(metaDir, "aigc-declaration.md"),
        "# AIGC 内容声明\n\n本视频含 AI 生成内容（TTS 口播 + 程序生成卡片）。\n" +
          "上传时必须勾选平台「AI 生成内容」声明选项。\n",
      );
      writeFileSync(
        join(metaDir, "materials-manifest.md"),
        "# 素材清单\n\n- 文章素材: article.md（自有内容）\n- 音频: 程序生成正弦波（e2e fixture）\n",
      );
      writeFileSync(
        join(metaDir, "publish-advice.md"),
        "# 发布建议\n\n工作日晚间发布，封面用首卡片。\n",
      );

      // ---- package assemble + validate (manifest 契约通过, SUMMARY.md 在) --
      const pkgResult = await runPackageAssemble({ slug: SLUG, videosRoot });
      expect(pkgResult.step).toBe("package");
      expect(existsSync(join(dir.paths.pkg, "manifest.json"))).toBe(true);
      expect(existsSync(join(dir.paths.pkg, "SUMMARY.md"))).toBe(true);
      const validated = await runPackageValidate({ slug: SLUG, videosRoot });
      expect((validated.data as { valid: boolean }).valid).toBe(true);

      // ---- golden case (FR-4 AC): 删 aigc-declaration.md → 契约违约 --------
      rmSync(join(dir.paths.pkg, "aigc-declaration.md"));
      await expect(
        runPackageValidate({ slug: SLUG, videosRoot }),
      ).rejects.toThrow(ContractViolationError);

      // ---- register add + report weekly roundtrip (temp dataRoot) ---------
      const registered = await runRegisterAdd({
        platform: "shipinhao",
        url: "https://example.com/e2e/1",
        title: "bun 上手三步走",
        publishedAt: "2026-07-23T12:00:00+08:00",
        package: dir.paths.pkg,
        dataRoot,
      });
      expect(registered.text).toContain("已登记发布");
      await runMetricsAdd({
        platform: "shipinhao",
        week: "2026-07-20",
        followers: "10",
        views: "100",
        likes: "3",
        comments: "1",
        shares: "1",
        dataRoot,
      });
      const weekly = await runReportWeekly({ dataRoot });
      expect((weekly.data as { rows: unknown[] }).rows).toHaveLength(1);
    }, 60_000);
  },
);
