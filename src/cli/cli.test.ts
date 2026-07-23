/**
 * Offline tests for the U6 CLI assembly (hermetic temp VIDEOS_ROOT /
 * DATA_ROOT per test): route table + required flags (校验逻辑), envelope
 * shapes (Q2=A), ExitCodeMap coverage (BR-U1-10), init/script command
 * flows with stop-point 1 text (BR-U6-4/11), domain-guard propagation
 * (BR-U3-2 → exit 4), --json envelope from a real command result
 * (BR-U6-2), register+report registry roundtrip, and the check gate's
 * no-short-circuit aggregation (BR-U6-9).
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

import {
  AppError,
  ContractViolationError,
  DomainGuardError,
  FfmpegError,
  InsufficientDataError,
  IoError,
  NotFoundError,
  RenderError,
  TTSBackendError,
  TTSMalformedOutputError,
  TTSNetworkError,
  TTSRateLimitError,
  ValidationError,
} from "@core/errors";
import { load } from "@core/workdir";

import {
  defaultSpawn,
  renderCheckTable,
  runCheck,
  runCheckCommand,
} from "./commands/check";
import { runComposeRun } from "./commands/compose";
import { runInit } from "./commands/init";
import { runMetricsAdd } from "./commands/metrics";
import { runRegisterAdd } from "./commands/register";
import { runReportBaseline, runReportWeekly } from "./commands/report";
import { runScriptValidate } from "./commands/script";
import { err, ok } from "./envelope";
import { mapExitCode } from "./exit";
import { parseCli } from "./parse";

// ---- hermetic temp roots ----------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** A benign guard table (empty categories) — hermetic vs the shipped asset. */
function makeBenignGuardTable(): string {
  const root = makeTempRoot("cli-guard-");
  const path = join(root, "guard.json");
  writeFileSync(path, JSON.stringify({ categories: [] }));
  return path;
}

/** Valid 3-segment script.json fixture (skills 生成物 simulation). */
function validScript(overrides: Record<string, unknown> = {}): object {
  return {
    title: "测试视频",
    topic: "bun 上手指南",
    segments: [
      { text: "第一段口播文字", cardText: "第一段要点" },
      { text: "第二段口播文字", cardText: "第二段要点", emphasis: ["要点"] },
      { text: "第三段口播文字", cardText: "第三段要点" },
    ],
    source: { kind: "topic", ref: "bun 上手指南" },
    ...overrides,
  };
}

// ---- parse: route table + 校验逻辑 -------------------------------------------

describe("parse", () => {
  test("unknown command → ValidationError carrying help (Workflow 1 → exit 2)", () => {
    expect(() => parseCli(["frobnicate"])).toThrow(ValidationError);
    try {
      parseCli(["frobnicate"]);
    } catch (error) {
      expect((error as Error).message).toContain("未知命令");
      expect((error as Error).message).toContain("vagent"); // help attached
    }
    // Unknown subaction of a known group is unknown too.
    expect(() => parseCli(["script", "preview", "s"])).toThrow(ValidationError);
  });

  test("flag parsing, globals (--json/--videos-root), and required-flag gate", () => {
    const parsed = parseCli([
      "tts",
      "run",
      "my-slug",
      "--backend",
      "say",
      "--voice",
      "Tingting",
      "--json",
      "--videos-root",
      "/tmp/x",
    ]);
    expect(parsed.route).toBe("tts run");
    expect(parsed.positionals).toEqual(["my-slug"]);
    expect(parsed.values["backend"]).toBe("say");
    expect(parsed.values["voice"]).toBe("Tingting");
    expect(parsed.json).toBe(true);
    expect(parsed.videosRoot).toBe("/tmp/x");

    // Missing required flags → itemized ValidationError with usage.
    try {
      parseCli(["register", "add", "--platform", "shipinhao"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as Error).message;
      expect(message).toContain("--url");
      expect(message).toContain("--published-at");
      expect(message).toContain("用法");
    }
    // Wrong positional count.
    expect(() => parseCli(["init"])).toThrow(ValidationError);
    // No args → help route (not an error).
    expect(parseCli([]).route).toBe("help");
  });
});

// ---- envelope (Q2=A) -----------------------------------------------------------

describe("envelope", () => {
  test("ok/err shapes: step+data on success; type/message/context on failure", () => {
    expect(ok({ a: 1 }, "script")).toEqual({
      ok: true,
      step: "script",
      data: { a: 1 },
    });
    expect(ok()).toEqual({ ok: true });

    const failure = err(
      new ContractViolationError("包不可交付", {
        violations: [{ field: "cover.path", problem: "缺失" }],
      }),
    );
    expect(failure.ok).toBe(false);
    expect(failure.error?.type).toBe("ContractViolationError");
    expect(failure.error?.message).toContain("包不可交付");
    // Typed error fields surface in context (skills 转述面).
    expect(failure.error?.context).toMatchObject({
      exitCode: 9,
      violations: [{ field: "cover.path", problem: "缺失" }],
    });

    const untyped = err(new Error("裸错误"));
    expect(untyped.error?.type).toBe("Error");
    expect(untyped.error?.context).toEqual({});
  });
});

// ---- exit-code mapping (BR-U1-10 locked table) ----------------------------------

describe("mapExitCode", () => {
  test("covers every AppError class; unknown → 1", () => {
    const sub = { argv: ["ffmpeg"], stderr: "" };
    const tts = { backend: "edge", segmentIndex: 0 };
    const cases: Array<[AppError, number]> = [
      [new ValidationError("v"), 2],
      [new NotFoundError("n"), 3],
      [new DomainGuardError("d"), 4],
      [new IoError("i"), 5],
      [new FfmpegError("f", sub), 6],
      [new TTSNetworkError("t", tts), 7],
      [new TTSRateLimitError("t", tts), 7],
      [new TTSMalformedOutputError("t", tts), 7],
      [new TTSBackendError("t", tts), 7],
      [new RenderError("r"), 8],
      [new ContractViolationError("c", { violations: [] }), 9],
      [
        new InsufficientDataError("s", {
          platform: "shipinhao",
          weeksFound: 1,
          weeksRequired: 4,
        }),
        10,
      ],
    ];
    for (const [error, code] of cases) {
      expect(mapExitCode(error)).toBe(code);
    }
    expect(mapExitCode(new Error("x"))).toBe(1);
    expect(mapExitCode("字符串")).toBe(1);
  });
});

// ---- init command ---------------------------------------------------------------

describe("init command", () => {
  test("happy path creates the workdir; slug conflict rejected (BR-U1-2)", async () => {
    const videosRoot = makeTempRoot("cli-init-");

    const result = await runInit({
      slug: "demo-video",
      topic: "bun 上手",
      videosRoot,
    });
    expect(existsSync(join(videosRoot, "demo-video", "state.json"))).toBe(true);
    expect(result.text).toContain("script validate demo-video");

    // Conflict: same slug again.
    await expect(
      runInit({ slug: "demo-video", topic: "bun 上手", videosRoot }),
    ).rejects.toThrow(ValidationError);
    // argv 校验: --article 与 --topic 互斥且必居其一.
    await expect(runInit({ slug: "other", videosRoot })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      runInit({ slug: "other", topic: "t", article: "a.md", videosRoot }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---- script validate command -------------------------------------------------------

describe("script validate command", () => {
  test("full flow: script.md written, step marked, stop-point 1 text (BR-U6-4)", async () => {
    const videosRoot = makeTempRoot("cli-script-");
    await runInit({ slug: "demo-video", topic: "bun 上手", videosRoot });

    // Skills simulation: drop a valid 3-segment script.json fixture.
    writeFileSync(
      join(videosRoot, "demo-video", "script", "script.json"),
      JSON.stringify(validScript()),
    );

    const result = await runScriptValidate(
      { slug: "demo-video", videosRoot },
      { guardTablePath: makeBenignGuardTable() },
    );

    const previewPath = join(videosRoot, "demo-video", "script", "script.md");
    expect(existsSync(previewPath)).toBe(true);
    expect(result.step).toBe("script");
    // Stop-point 1 stdout notice: 审核物路径 + 下一步提示 (Workflow 2).
    expect(result.text).toContain(previewPath);
    expect(result.text).toContain("停点 1");
    expect(result.text).toContain("tts run demo-video");

    const dir = await load("demo-video", { videosRoot });
    expect(dir.state.steps.script).toBeDefined();
    expect(dir.state.steps.script?.meta["segments"]).toBe(3);
  });

  test("domain-guard hit → DomainGuardError propagates, zero artifacts (BR-U3-2)", async () => {
    const videosRoot = makeTempRoot("cli-guard-hit-");
    await runInit({ slug: "guarded", topic: "test", videosRoot });
    writeFileSync(
      join(videosRoot, "guarded", "script", "script.json"),
      JSON.stringify(validScript({ topic: "炒股快速致富" })),
    );

    const guardRoot = makeTempRoot("cli-guard-table-");
    const tablePath = join(guardRoot, "guard.json");
    writeFileSync(
      tablePath,
      JSON.stringify({
        categories: [{ name: "finance", keywords: ["炒股"] }],
      }),
    );

    await expect(
      runScriptValidate(
        { slug: "guarded", videosRoot },
        { guardTablePath: tablePath },
      ),
    ).rejects.toThrow(DomainGuardError);
    // Zero artifacts on rejection: no script.md, no step marked.
    expect(existsSync(join(videosRoot, "guarded", "script", "script.md"))).toBe(
      false,
    );
    const dir = await load("guarded", { videosRoot });
    expect(dir.state.steps.script).toBeUndefined();
  });
});

// ---- --json envelope from a real command result (BR-U6-2) --------------------------

describe("--json envelope", () => {
  test("a command result wraps into the JsonEnvelope stdout shape", async () => {
    const videosRoot = makeTempRoot("cli-json-");
    const result = await runInit({
      slug: "json-video",
      topic: "t",
      videosRoot,
    });

    const envelope = ok(result.data, result.step);
    expect(envelope.ok).toBe(true);
    expect(envelope.step).toBeUndefined(); // init has no pipeline step
    expect(envelope.data).toMatchObject({ slug: "json-video" });
    expect(envelope.error).toBeUndefined();
    // Serializable in one stdout line (skills parse stdout only).
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope as object);
  });
});

// ---- register + report roundtrip (registry delegation) ------------------------------

describe("register/metrics/report commands", () => {
  test("register add + metrics add + report weekly roundtrip (temp dataRoot)", async () => {
    const dataRoot = makeTempRoot("cli-registry-");
    const pkgDir = join(dataRoot, "package");
    mkdirSync(pkgDir);

    const registered = await runRegisterAdd({
      platform: "shipinhao",
      url: "https://example.com/v/1",
      title: "测试标题",
      publishedAt: "2026-07-23T12:00:00+08:00",
      package: pkgDir,
      dataRoot,
    });
    expect(registered.text).toContain("已登记发布");

    // Duplicate (platform, url) rejected via U5 idempotence key (BR-U5-7).
    await expect(
      runRegisterAdd({
        platform: "shipinhao",
        url: "https://example.com/v/1",
        title: "测试标题",
        publishedAt: "2026-07-23T12:00:00+08:00",
        package: pkgDir,
        dataRoot,
      }),
    ).rejects.toThrow(ValidationError);

    await runMetricsAdd({
      platform: "shipinhao",
      week: "2026-07-20", // ISO Monday
      followers: "100",
      views: "1000",
      likes: "30",
      comments: "10",
      shares: "10",
      dataRoot,
    });

    const report = await runReportWeekly({ dataRoot });
    const rows = (report.data as { rows: Array<{ views: number }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.views).toBe(1000);
    expect(report.text).toContain("5.00%"); // (30+10+10)/1000
  });
});

// ---- report baseline command (registry delegation + rendering) ----------------------

describe("report baseline command", () => {
  test("4 Mondays of metrics → rendered baseline; empty data → exit-10 error", async () => {
    const dataRoot = makeTempRoot("cli-baseline-");
    // 4 distinct ISO Mondays (BR-U5-10 gate threshold).
    const weeks = ["2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20"];
    for (const [i, week] of weeks.entries()) {
      await runMetricsAdd({
        platform: "shipinhao",
        week,
        followers: String(100 + i * 10),
        views: "1000",
        likes: "30",
        comments: "10",
        shares: "10",
        dataRoot,
      });
    }

    const result = await runReportBaseline({ dataRoot });
    expect(result.text).toContain("基线报告");
    expect(result.text).toContain("shipinhao（4 周数据）");
    expect(result.text).toContain("周粉丝增长: 中位 10"); // adjacent diffs [10,10,10]
    expect(result.text).toContain("5.00%"); // (30+10+10)/1000 engagement

    // Empty data plane → InsufficientDataError (exit 10 via mapExitCode).
    const emptyRoot = makeTempRoot("cli-baseline-empty-");
    await expect(runReportBaseline({ dataRoot: emptyRoot })).rejects.toThrow(
      InsufficientDataError,
    );
  });
});

// ---- compose command: 前置校验 (compose 装配桥的守门半边) ----------------------------

describe("compose run command", () => {
  test("missing script/tts steps → ValidationError with 前置提示", async () => {
    const videosRoot = makeTempRoot("cli-compose-pre-");
    await runInit({ slug: "not-ready", topic: "t", videosRoot });

    try {
      await runComposeRun({ slug: "not-ready", videosRoot });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain("script 未完成");
    }
  });
});

// ---- check gate (BR-U6-9) ------------------------------------------------------------

describe("check command", () => {
  test("serial, no short-circuit, aggregated table, any failure → not ok", () => {
    const spawned: string[][] = [];
    const summary = runCheck((argv) => {
      spawned.push(argv);
      // First step fails; the second must still run (no short-circuit).
      return { exitCode: spawned.length === 1 ? 1 : 0 };
    });

    expect(spawned).toHaveLength(2); // both ran despite the first failing
    expect(spawned[0]).toEqual(["bunx", "prettier", "--check", "."]);
    expect(spawned[1]).toEqual(["bun", "test"]);
    expect(summary.ok).toBe(false);
    expect(summary.results[0]!.ok).toBe(false);
    expect(summary.results[1]!.ok).toBe(true);

    const table = renderCheckTable(summary);
    expect(table).toContain("✗ 失败（exit 1）");
    expect(table).toContain("✅ 通过");
    expect(table).toContain("1/2 项失败");

    // All green → ok.
    expect(runCheck(() => ({ exitCode: 0 })).ok).toBe(true);
  });

  test("runCheckCommand maps the aggregate to exitCode (1 on any failure)", () => {
    const failing = runCheckCommand(() => ({ exitCode: 2 }));
    expect(failing.exitCode).toBe(1);
    expect(failing.text).toContain("门禁未通过");

    const green = runCheckCommand(() => ({ exitCode: 0 }));
    expect(green.exitCode).toBe(0);
    expect(green.text).toContain("门禁通过");
  });

  test("defaultSpawn: real exit code passthrough; unspawnable → 127", () => {
    expect(defaultSpawn(["true"]).exitCode).toBe(0);
    expect(defaultSpawn(["false"]).exitCode).toBe(1);
    expect(defaultSpawn(["/nonexistent-vagent-check-xyz"]).exitCode).toBe(127);
  });
});
