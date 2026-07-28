/**
 * `--dry-run` 的契约测试。
 *
 * 核心那条是**零写入**：表驱动遍历全部路由，在临时工作根上跑一遍试跑，然后把
 * 目录树前后做快照比较。这条断言比"每条命令看起来对不对"重要得多——试跑档的
 * 全部价值建立在"它绝不落盘"上，而落盘是静默的：一次 mkdir 不会报错，只会在
 * 下一次真跑时表现为"工作目录莫名已存在"。
 *
 * 允许命令因为缺前置产物抛 ValidationError / NotFoundError：那正是试跑要拦的
 * 东西，不是测试失败。
 */

import { afterAll, describe, expect, test } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { NotFoundError, ValidationError } from "@core/errors";
import { initVideo, markStep } from "@core/workdir";

import { runDryRun, type DryRunPlan } from "./dry-run";
import { ROUTES, parseCli } from "./parse";

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** 递归目录快照：相对路径 + 文件大小（mkdir 与写文件都会改变它）. */
function snapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      out.push(
        `${relative(root, full)}${st.isDirectory() ? "/" : `:${st.size}`}`,
      );
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** 三段 script.json（与 cli.test.ts 的 fixture 同形）. */
function validScript(): object {
  return {
    title: "试跑测试",
    topic: "dry run",
    segments: [
      { text: "第一段口播文字", cardText: "第一段要点" },
      { text: "第二段口播文字", cardText: "第二段要点" },
      { text: "第三段口播文字", cardText: "第三段要点" },
    ],
    source: { kind: "topic", ref: "dry run" },
  };
}

/** 造一个走到 script 步骤的工作目录. */
async function makeScriptedWorkdir(): Promise<{
  videosRoot: string;
  slug: string;
}> {
  const videosRoot = makeTempRoot("dry-vr-");
  const slug = "dry-run-demo";
  const dir = await initVideo(
    slug,
    { kind: "topic", ref: "dry run" },
    {
      videosRoot,
    },
  );
  writeFileSync(
    join(dir.paths.script, "script.json"),
    JSON.stringify(validScript()),
  );
  writeFileSync(join(dir.paths.script, "script.md"), "# 审核物\n");
  await markStep(dir, "script", {});
  return { videosRoot, slug };
}

/** 每条路由一组"能过 parse 的最小 argv"（试跑只需要参数齐全）. */
function argvFor(route: string, slug: string): string[] {
  switch (route) {
    case "init":
      return ["init", slug, "--topic", "试跑"];
    case "register add":
      return [
        "register",
        "add",
        "--platform",
        "douyin",
        "--url",
        "https://v.douyin.com/x/",
        "--title",
        "标题",
        "--published-at",
        "2026-07-26T20:00:00+08:00",
        "--package",
        "/tmp/not-there",
      ];
    case "metrics add":
      return [
        "metrics",
        "add",
        "--platform",
        "douyin",
        "--week",
        "2026-07-20",
        "--followers",
        "10",
        "--views",
        "100",
        "--likes",
        "5",
        "--comments",
        "1",
        "--shares",
        "0",
      ];
    case "whiteboard render":
      return [
        "whiteboard",
        "render",
        "experiments/whiteboard-poc/article-graph-vs-loop.md",
      ];
    default: {
      const spec = ROUTES.find((r) => r.route === route)!;
      return [...spec.tokens, ...spec.positionals.map(() => slug)];
    }
  }
}

describe("--dry-run 零写入", () => {
  for (const spec of ROUTES) {
    test(`${spec.route} 不写任何文件`, async () => {
      const videosRoot = makeTempRoot("dry-zero-vr-");
      const dataRoot = makeTempRoot("dry-zero-dr-");
      const cmd = parseCli([
        ...argvFor(spec.route, "zero-write-probe"),
        "--dry-run",
        "--videos-root",
        videosRoot,
        "--data-root",
        dataRoot,
      ]);
      const before = [snapshot(videosRoot), snapshot(dataRoot)];
      try {
        await runDryRun(cmd);
      } catch (error) {
        // 缺前置产物就该报错——这正是试跑的用途；写入才是失败。
        expect(
          error instanceof ValidationError || error instanceof NotFoundError,
          `${spec.route} 抛了非预期错误: ${String(error)}`,
        ).toBe(true);
      }
      expect([snapshot(videosRoot), snapshot(dataRoot)]).toEqual(before);
    });
  }
});

describe("--dry-run 计划内容", () => {
  test("script validate / tts run 给出段数与预计时长", async () => {
    const { videosRoot, slug } = await makeScriptedWorkdir();
    for (const route of ["script validate", "tts run"]) {
      const cmd = parseCli([
        ...argvFor(route, slug),
        "--dry-run",
        "--videos-root",
        videosRoot,
      ]);
      const result = await runDryRun(cmd);
      const plan = result.data as unknown as DryRunPlan;
      expect(plan.route).toBe(route);
      expect(plan.estimate?.["段数"]).toBe(3);
      // script 报「预计时长」，tts 报「预计音频时长」——两条命令看的是不同的量
      const seconds =
        plan.estimate?.["预计时长"] ?? plan.estimate?.["预计音频时长"];
      expect(String(seconds ?? "")).toMatch(/s$/);
      // 试跑不属于流水线四步之一，不该占用信封的 step 字段
      expect(result.step).toBeUndefined();
    }
  });

  test("tts run 分别报已合成 / 待合成", async () => {
    const { videosRoot, slug } = await makeScriptedWorkdir();
    const cmd = parseCli([
      "tts",
      "run",
      slug,
      "--dry-run",
      "--videos-root",
      videosRoot,
    ]);
    const plan = (await runDryRun(cmd)).data as unknown as DryRunPlan;
    expect(plan.estimate?.["已合成"]).toBe(0);
    expect(plan.estimate?.["待合成"]).toBe(3);
  });

  test("tts run 的「已合成」按零基段名数（seg-00 起，不是 seg-01）", async () => {
    const { videosRoot, slug } = await makeScriptedWorkdir();
    const audio = join(videosRoot, slug, "audio");
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, "seg-00.mp3"), "x");
    writeFileSync(join(audio, "seg-01.mp3"), "x");

    const plan = (
      await runDryRun(
        parseCli([
          "tts",
          "run",
          slug,
          "--dry-run",
          "--videos-root",
          videosRoot,
        ]),
      )
    ).data as unknown as DryRunPlan;
    expect(plan.estimate?.["已合成"]).toBe(2);
    expect(plan.estimate?.["待合成"]).toBe(1);
  });

  test("--fresh 的计划声明会先清空 audio/，待合成回到全量", async () => {
    const { videosRoot, slug } = await makeScriptedWorkdir();
    const audio = join(videosRoot, slug, "audio");
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, "seg-00.mp3"), "x");

    const plan = (
      await runDryRun(
        parseCli([
          "tts",
          "run",
          slug,
          "--fresh",
          "--dry-run",
          "--videos-root",
          videosRoot,
        ]),
      )
    ).data as unknown as DryRunPlan;
    expect(plan.plan[0]).toContain("清空 audio/");
    expect(plan.estimate?.["待合成"]).toBe(3);
    // 试跑必须零写入：已有的段还在
    expect(existsSync(join(audio, "seg-00.mp3"))).toBe(true);
  });

  test("收费后端在试跑里先报计费口径（免费后端不报）", async () => {
    const { videosRoot, slug } = await makeScriptedWorkdir();
    const paid = (
      await runDryRun(
        parseCli([
          "tts",
          "run",
          slug,
          "--backend",
          "minimax",
          "--dry-run",
          "--videos-root",
          videosRoot,
        ]),
      )
    ).data as unknown as DryRunPlan;
    expect(String(paid.estimate?.["计费提示"])).toContain("按字符计费");
    expect(Number(paid.estimate?.["待合成字符"])).toBeGreaterThan(0);

    const free = (
      await runDryRun(
        parseCli([
          "tts",
          "run",
          slug,
          "--backend",
          "edge",
          "--dry-run",
          "--videos-root",
          videosRoot,
        ]),
      )
    ).data as unknown as DryRunPlan;
    expect(free.estimate?.["计费提示"]).toBeUndefined();
  });

  test("whiteboard render 给帧数与粗估声明，且不建 frames 目录", async () => {
    const framesDir = join(makeTempRoot("dry-frames-"), "frames");
    const cmd = parseCli([
      "whiteboard",
      "render",
      "experiments/whiteboard-poc/article-graph-vs-loop.md",
      "--frames",
      framesDir,
      "--dry-run",
    ]);
    const plan = (await runDryRun(cmd)).data as unknown as DryRunPlan;
    expect(String(plan.estimate?.["预计帧数"])).toMatch(/^约 \d+$/);
    expect(String(plan.estimate?.["note"])).toContain("粗估");
    expect(existsSync(framesDir)).toBe(false);
  });

  test("--only-stills 的计划与整片不同（只出关键帧）", async () => {
    const cmd = parseCli([
      "whiteboard",
      "render",
      "experiments/whiteboard-poc/article-graph-vs-loop.md",
      "--only-stills",
      "--dry-run",
    ]);
    const plan = (await runDryRun(cmd)).data as unknown as DryRunPlan;
    expect(plan.writes.join(" ")).toContain("stills");
    expect(plan.estimate?.["预计渲染耗时"]).toBe("秒级");
  });

  test("package assemble 试跑点名缺哪几份元数据", async () => {
    const videosRoot = makeTempRoot("dry-pkg-vr-");
    const slug = "pkg-probe";
    const dir = await initVideo(
      slug,
      { kind: "topic", ref: "t" },
      {
        videosRoot,
      },
    );
    writeFileSync(
      join(dir.paths.script, "script.json"),
      JSON.stringify(validScript()),
    );
    writeFileSync(join(dir.paths.script, "script.md"), "x");
    await markStep(dir, "script", {});
    // 伪造 tts / compose 产物，只为把步骤推到 compose 完成
    mkdirSync(dir.paths.audio, { recursive: true });
    writeFileSync(join(dir.paths.audio, "merged.m4a"), "x");
    writeFileSync(
      join(dir.paths.audio, "durations.json"),
      JSON.stringify({ perSegment: [1, 1, 1], segmentOffsets: [0, 1, 2] }),
    );
    await markStep(dir, "tts", {});
    mkdirSync(dir.paths.video, { recursive: true });
    writeFileSync(join(dir.paths.video, "video.mp4"), "x");
    await markStep(dir, "compose", {});

    const cmd = parseCli([
      "package",
      "assemble",
      slug,
      "--dry-run",
      "--videos-root",
      videosRoot,
    ]);
    const plan = (await runDryRun(cmd)).data as unknown as DryRunPlan;
    expect(String(plan.estimate?.["元数据缺失"])).toContain(
      "metadata-shipinhao.md",
    );
  });

  test("参数错误在试跑阶段就报出来", async () => {
    // ISO 时间非法
    await expect(
      runDryRun(
        parseCli([
          "register",
          "add",
          "--platform",
          "douyin",
          "--url",
          "u",
          "--title",
          "t",
          "--published-at",
          "上周三",
          "--package",
          "/tmp",
          "--dry-run",
        ]),
      ),
    ).rejects.toThrow(/ISO/);

    // week 不是周一
    await expect(
      runDryRun(
        parseCli([
          "metrics",
          "add",
          "--platform",
          "douyin",
          "--week",
          "2026-07-21",
          "--followers",
          "1",
          "--views",
          "1",
          "--likes",
          "1",
          "--comments",
          "1",
          "--shares",
          "1",
          "--dry-run",
        ]),
      ),
    ).rejects.toThrow(/周一/);

    // 指标不是非负整数
    await expect(
      runDryRun(
        parseCli([
          "metrics",
          "add",
          "--platform",
          "douyin",
          "--week",
          "2026-07-20",
          "--followers=-3",
          "--views",
          "1",
          "--likes",
          "1",
          "--comments",
          "1",
          "--shares",
          "1",
          "--dry-run",
        ]),
      ),
    ).rejects.toThrow(/非负整数/);
  });
});
