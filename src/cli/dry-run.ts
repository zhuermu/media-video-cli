/**
 * @module cli/dry-run
 *
 * `--dry-run` —— 每条命令的试跑档：**校验 → 报计划 → 零写入 → 退出 0**。
 *
 * ## 为什么值得单开一层
 *
 * 这条 CLI 里最贵的两步是 TTS 合成（联网、按段计费的注意力）和渲染（白板整片
 * 上万帧、近一小时）。而最常见的失败原因不是渲染本身，是**参数或前置产物不对**：
 * slug 拼错、script.json 还没写、五份元数据缺一份、模板路径写错。这些都能在
 * 一秒内查出来，代价却是一次几十分钟的白跑。
 *
 * 试跑档也是给大模型的：它拿到 `vagent schema --json` 之后仍可能传错参数，
 * `--dry-run` 让它在真跑之前拿到一次结构化的确认（`plan` / `writes` / `estimate`）。
 *
 * ## 三条硬约束
 *
 * 1. **零写入。** 不 mkdir、不落盘、不调 TTS、不起 ffmpeg。因此这里只做纯读校验
 *    与算术预估，不复用 `prepareVideo`（它会真的合成配音并写缓存）。
 * 2. **预估必须标明是估算。** 白板视频的帧数取决于**实测**配音时长，试跑档没有
 *    配音，只能按字数×语速粗估。把它写成 `estimate.note` 而不是假装精确——一个
 *    看起来精确的错数字比"约"更害人。
 * 3. **校验失败照常抛类型化错误。** 试跑不是"永远成功"：slug 不存在就该报
 *    NotFoundError（退出码 3），这正是它的价值。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ValidationError } from "@core/errors";
import { estimateDuration, validateScript } from "@core/script";
import { load, missingArtifacts, stepDone } from "@core/workdir";
import type { Step, VideoDir } from "@core/workdir";
import { parseArticle } from "@core/whiteboard-video";

import type { CommandResult } from "./envelope";
import { ROUTES, type ParsedCommand } from "./parse";

/** 中文口播语速（字/秒）——粗估用，实际由 TTS 实测决定. */
const CHARS_PER_SEC = 5.2;
/** 帧率（与渲染层一致；预估帧数用）. */
const FPS = 30;

/** 试跑档的结构化结果（`--json` 时进 data）. */
export interface DryRunPlan {
  route: string;
  /** 会依次做的事（人读）. */
  plan: string[];
  /** 会写出的文件/目录（真跑时）. */
  writes: string[];
  /** 规模预估（贵命令才有）. */
  estimate?: Record<string, string | number>;
}

function planText(p: DryRunPlan): string {
  const lines = [`试跑（未写入任何文件）: ${p.route}`, "", "将依次执行:"];
  for (const step of p.plan) lines.push(`  · ${step}`);
  lines.push("", p.writes.length === 0 ? "将写出: （只读命令）" : "将写出:");
  for (const w of p.writes) lines.push(`  + ${w}`);
  if (p.estimate !== undefined) {
    lines.push("", "规模预估:");
    for (const [k, v] of Object.entries(p.estimate)) {
      lines.push(`  ${k}: ${String(v)}`);
    }
  }
  lines.push("", "真跑: 去掉 --dry-run 重新执行", "");
  return lines.join("\n");
}

/** 路由声明的产物，把 `<slug>` 换成真实 slug. */
function declaredWrites(route: string, slug: string): string[] {
  const spec = ROUTES.find((r) => r.route === route);
  return (spec?.produces ?? []).map((p) => p.replace("<slug>", slug));
}

/** 前置步骤检查：未完成时报错并点名该跑哪条命令. */
function requireStep(dir: VideoDir, step: Step, hint: string): void {
  if (stepDone(dir, step)) return;
  const missing = missingArtifacts(dir, step);
  throw new ValidationError(
    `步骤 ${step} 未完成: 请先运行 ${hint}` +
      (missing.length === 0 ? "" : `（缺: ${missing.join(", ")}）`),
  );
}

/** 读 script.json（试跑只读，不写 script.md）. */
async function readScript(dir: VideoDir): Promise<{
  segments: number;
  chars: number;
  seconds: number;
}> {
  const path = join(dir.paths.script, "script.json");
  const script = await validateScript(path, { warn: () => {} });
  const estimate = estimateDuration(script);
  const chars = script.segments.reduce((a, s) => a + [...s.text].length, 0);
  return {
    segments: script.segments.length,
    chars,
    seconds: Math.round(estimate.total),
  };
}

/** 卡片视频的五份 LLM 元数据（package assemble 的输入契约）. */
const METADATA_FILES = [
  "metadata-shipinhao.md",
  "metadata-douyin.md",
  "aigc-declaration.md",
  "materials.md",
  "publish-advice.md",
];

async function initPlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const article = cmd.values["article"];
  const topic = cmd.values["topic"];
  if ((article === undefined) === (topic === undefined)) {
    throw new ValidationError("init 需要且仅需要 --article 或 --topic 之一");
  }
  if (typeof article === "string" && !existsSync(article)) {
    throw new ValidationError(`article 素材文件不存在: ${article}`);
  }
  return {
    route: "init",
    plan: [
      `校验 slug「${slug}」格式与目录冲突`,
      typeof article === "string"
        ? `拷贝源文章 ${article} 到 input/`
        : "记录主题到 input/",
      "写 state.json（步骤全部未完成）",
    ],
    writes: declaredWrites("init", slug),
  };
}

async function scriptPlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const dir = await load(slug, { videosRoot: cmd.videosRoot });
  const s = await readScript(dir);
  return {
    route: "script validate",
    plan: [
      "校验 script.json（schema + 逐条问题汇总）",
      "跑 domain-guard 受限领域词表（命中即零产物报错）",
      "估算时长并渲染人工审核物 script.md",
    ],
    writes: declaredWrites("script validate", slug),
    estimate: {
      段数: s.segments,
      口播字数: s.chars,
      预计时长: `${s.seconds}s`,
    },
  };
}

async function ttsPlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const dir = await load(slug, { videosRoot: cmd.videosRoot });
  requireStep(dir, "script", `vagent script validate ${slug}`);
  const s = await readScript(dir);
  const done = Array.from({ length: s.segments }, (_, i) =>
    join(dir.paths.audio, `seg-${String(i + 1).padStart(2, "0")}.mp3`),
  ).filter((p) => existsSync(p)).length;
  const backend = cmd.values["backend"] ?? "$TTS_BACKEND / edge";
  return {
    route: "tts run",
    plan: [
      `逐段合成（后端 ${String(backend)}），已存在的段跳过`,
      "ffprobe 实测每段时长 → durations.json",
      "归一化 + 拼接 → merged.m4a，并断言总时长一致",
    ],
    writes: declaredWrites("tts run", slug),
    estimate: {
      段数: s.segments,
      已合成: done,
      待合成: s.segments - done,
      预计音频时长: `${s.seconds}s`,
    },
  };
}

async function composePlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const dir = await load(slug, { videosRoot: cmd.videosRoot });
  requireStep(dir, "tts", `vagent tts run ${slug}`);
  const s = await readScript(dir);
  const template = cmd.values["template"];
  if (typeof template === "string" && !existsSync(template)) {
    throw new ValidationError(`--template 指定的模板不存在: ${template}`);
  }
  const existingFrames = existsSync(dir.paths.cards)
    ? readdirSync(dir.paths.cards).filter((f) => f.endsWith(".png")).length
    : 0;
  return {
    route: "compose run",
    plan: [
      typeof template === "string"
        ? `载入模板 ${template}`
        : "按配置模板名载入 assets/templates/<名>.json",
      "逐段排版 → SVG → 栅格化卡片帧（已存在的帧跳过）",
      "ffmpeg 合成 9:16 成片 + 烧字幕",
    ],
    writes: declaredWrites("compose run", slug),
    estimate: {
      段数: s.segments,
      已有卡片帧: existingFrames,
      预计成片时长: `${s.seconds}s`,
    },
  };
}

async function packageAssemblePlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const dir = await load(slug, { videosRoot: cmd.videosRoot });
  requireStep(dir, "compose", `vagent compose run ${slug}`);
  const cover = cmd.values["cover"];
  if (typeof cover === "string" && !existsSync(cover)) {
    throw new ValidationError(`--cover 指定的封面不存在: ${cover}`);
  }
  const missing = METADATA_FILES.filter(
    (f) => !existsSync(join(dir.paths.pkg, f)),
  );
  return {
    route: "package assemble",
    plan: [
      "检查五份 LLM 元数据齐全（两平台文案 / AIGC 声明 / 素材清单 / 发布建议）",
      "拷贝成片与封面，写 manifest.json（Manifest v1）",
      "跑三层契约校验，生成 SUMMARY.md 检查单",
    ],
    writes: declaredWrites("package assemble", slug),
    estimate: {
      元数据缺失: missing.length === 0 ? "无" : missing.join(", "),
      封面: typeof cover === "string" ? cover : "视频首帧",
    },
  };
}

async function packageValidatePlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const slug = cmd.positionals[0] ?? "";
  const dir = await load(slug, { videosRoot: cmd.videosRoot });
  const manifest = join(dir.paths.pkg, "manifest.json");
  return {
    route: "package validate",
    plan: [
      `读 ${manifest}`,
      "三层校验：文件存在且非空 → 字段完整 → AIGC 必须声明",
    ],
    writes: [],
    estimate: {
      manifest: existsSync(manifest) ? "存在" : "缺失（真跑会报错）",
    },
  };
}

function registerPlan(cmd: ParsedCommand): DryRunPlan {
  const v = cmd.values;
  const publishedAt = String(v["published-at"]);
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new ValidationError(
      `--published-at 不是合法 ISO 时间: "${publishedAt}"`,
    );
  }
  const pkg = String(v["package"]);
  if (!existsSync(pkg)) {
    throw new ValidationError(`--package 指定的发布包目录不存在: ${pkg}`);
  }
  return {
    route: "register add",
    plan: [
      "校验字段与幂等键 (platform, url)",
      `追加一行到 ${cmd.dataRoot ?? "$DATA_ROOT / ./data"}/publishes.jsonl`,
    ],
    writes: declaredWrites("register add", ""),
    estimate: {
      platform: String(v["platform"]),
      url: String(v["url"]),
      发布时刻: publishedAt,
    },
  };
}

function metricsPlan(cmd: ParsedCommand): DryRunPlan {
  const v = cmd.values;
  const week = String(v["week"]);
  const parsed = new Date(week);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`--week 不是合法日期: "${week}"`);
  }
  if (parsed.getUTCDay() !== 1) {
    throw new ValidationError(
      `--week 必须是周一（ISO 周起点），"${week}" 是周 ${parsed.getUTCDay()}`,
    );
  }
  const numeric = ["followers", "views", "likes", "comments", "shares"];
  for (const name of numeric) {
    const raw = String(v[name]);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`--${name} 必须是非负整数，得到 "${raw}"`);
    }
  }
  return {
    route: "metrics add",
    plan: [
      "校验周一日期与五个非负整数指标",
      `追加一行到 ${cmd.dataRoot ?? "$DATA_ROOT / ./data"}/metrics.jsonl`,
    ],
    writes: declaredWrites("metrics add", ""),
    estimate: { 统计周: week, platform: String(v["platform"]) },
  };
}

function reportPlan(route: string, cmd: ParsedCommand): DryRunPlan {
  const root = cmd.dataRoot ?? process.env["DATA_ROOT"] ?? "./data";
  const file = join(root, "metrics.jsonl");
  const weeks = existsSync(file)
    ? new Set(
        readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => (JSON.parse(l) as { week?: string }).week ?? ""),
      ).size
    : 0;
  return {
    route,
    plan: [
      `读 ${file}`,
      route === "report baseline"
        ? "按平台聚合，每平台需 ≥4 个不同周（不足抛 InsufficientDataError）"
        : "按周聚合并算互动率（views=0 显示「无数据」）",
    ],
    writes: [],
    estimate: { 已有周数: weeks },
  };
}

async function whiteboardPlan(cmd: ParsedCommand): Promise<DryRunPlan> {
  const path = cmd.positionals[0] ?? "";
  if (!existsSync(path)) {
    throw new ValidationError(`文章不存在: ${path}`);
  }
  // parseArticle 是纯解析（读文件、不写），语法错误在这里就报出来——这正是
  // 试跑最该拦住的一类问题（写错一个图形块，真跑要等到那一段才失败）。
  const article = parseArticle(path);
  const chars = article.sections.reduce(
    (a, s) => a + s.cues.reduce((b, c) => b + [...c.text].length, 0),
    0,
  );
  const media = article.sections.filter(
    (s) =>
      s.board !== undefined ||
      s.chart !== undefined ||
      s.image !== undefined ||
      s.illustration !== undefined,
  ).length;
  const preview = cmd.values["preview"];
  const previewSec = typeof preview === "string" ? Number(preview) : Number.NaN;
  if (
    typeof preview === "string" &&
    (!Number.isFinite(previewSec) || previewSec <= 0)
  ) {
    throw new ValidationError(`--preview 需要一个正数秒数，得到 "${preview}"`);
  }
  const roughSec = chars / CHARS_PER_SEC;
  const cappedSec = Number.isFinite(previewSec)
    ? Math.min(previewSec, roughSec)
    : roughSec;
  const frames = Math.round(cappedSec * FPS);
  const onlyStills = cmd.values["only-stills"] === true;
  return {
    route: "whiteboard render",
    plan: onlyStills
      ? [
          `解析文章（${article.sections.length} 段）`,
          "逐段合成配音（决定体裁与排拍）",
          "每段渲一张关键帧到 stills/",
        ]
      : [
          `解析文章（${article.sections.length} 段）`,
          "逐段合成配音 → 实测时长决定体裁（short/long）与排拍",
          "逐帧渲染板书 + 手势 + 字幕",
          "旁白入轨 + 音效混音 + ffmpeg 封装",
        ],
    writes: onlyStills
      ? ["<stills>/<tag>-sN-talk.png（每段一张）"]
      : declaredWrites("whiteboard render", ""),
    estimate: {
      段数: article.sections.length,
      带图形块的段: media,
      口播字数: chars,
      预计时长: `约 ${Math.round(cappedSec)}s`,
      预计帧数: onlyStills ? article.sections.length + 1 : `约 ${frames}`,
      预计渲染耗时: onlyStills
        ? "秒级"
        : `约 ${Math.max(1, Math.round((frames * 0.09) / 60))} 分钟`,
      note: "时长与帧数按字数×语速粗估；真实值由实测配音时长决定",
    },
  };
}

/**
 * 跑一条命令的试跑档。
 *
 * @throws ValidationError / NotFoundError 参数或前置产物不对（试跑的价值所在）.
 */
export async function runDryRun(cmd: ParsedCommand): Promise<CommandResult> {
  const plan = await planFor(cmd);
  // 刻意不填 `step`：Step 是流水线锁定的四个步骤（script/tts/compose/package），
  // 试跑不属于任何一步——硬塞一个 "dry-run" 会污染那个枚举与 --json 信封契约。
  return {
    data: plan as unknown as Record<string, unknown>,
    text: planText(plan),
  };
}

async function planFor(cmd: ParsedCommand): Promise<DryRunPlan> {
  switch (cmd.route) {
    case "init":
      return initPlan(cmd);
    case "script validate":
      return scriptPlan(cmd);
    case "tts run":
      return ttsPlan(cmd);
    case "compose run":
      return composePlan(cmd);
    case "package assemble":
      return packageAssemblePlan(cmd);
    case "package validate":
      return packageValidatePlan(cmd);
    case "register add":
      return registerPlan(cmd);
    case "metrics add":
      return metricsPlan(cmd);
    case "report weekly":
    case "report baseline":
      return reportPlan(cmd.route, cmd);
    case "whiteboard render":
      return whiteboardPlan(cmd);
    case "schema":
      return {
        route: "schema",
        plan: ["把路由表序列化成 JSON 打到 stdout"],
        writes: [],
      };
    case "persona show":
      return {
        route: "persona show",
        plan: ["读 assets/persona/ermu.json 并打印（缺文件则提示未配置）"],
        writes: [],
      };
    case "check":
      return {
        route: "check",
        plan: [
          "prettier --check .",
          "bun test（含覆盖率门禁）",
          "两步串行汇总，不短路",
        ],
        writes: ["coverage/（bun test 的覆盖率产物）"],
      };
    default:
      throw new ValidationError(`试跑未实现: ${cmd.route}`);
  }
}
