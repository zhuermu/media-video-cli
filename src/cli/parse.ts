/**
 * @module cli/parse
 *
 * argv parsing and the CommandSpec route table (domain-entities.md):
 * native util.parseArgs + hand-written routing — zero CLI framework
 * dependencies (BR-U6-10, Q1=A).
 *
 * Boundary rules honored here:
 * - Workflow 1 step 1: unknown command → ValidationError carrying the help
 *   text (main maps it to exit code 2).
 * - 校验逻辑: 必填 flag 齐全 → violations throw ValidationError with the
 *   command's usage summary; slug 格式与枚举值域由被委托的 U1-U5 校验.
 * - BR-U6-11: help text lists every command WITH its stop-point hint
 *   (审核位 UX 的一部分).
 * - Global flags: `--json`（信封输出, BR-U6-2）、`--videos-root`（覆盖 config）.
 */

import { parseArgs } from "node:util";

import { ValidationError } from "@core/errors";

/** One entry of the CommandSpec route table. */
export interface RouteSpec {
  /** Canonical route key, e.g. "script validate". */
  route: string;
  /** argv tokens that select this route (1 or 2). */
  tokens: string[];
  /** Names of required positionals after the route tokens. */
  positionals: string[];
  /** Per-command flag spec (util.parseArgs options). */
  options: Record<string, { type: "string" | "boolean" }>;
  /** Required flag names (missing → ValidationError). */
  required: string[];
  usage: string;
  summary: string;
  /** Stop-point hint rendered into help (BR-U6-11). */
  stopHint?: string;
}

/** CommandSpec 子命令注册表 (domain-entities.md, incl. v1.1 init). */
export const ROUTES: RouteSpec[] = [
  {
    route: "init",
    tokens: ["init"],
    positionals: ["slug"],
    options: { article: { type: "string" }, topic: { type: "string" } },
    required: [],
    usage: "vagent init <slug> --article <path.md> | --topic <文字>",
    summary: "初始化视频工作目录并保存素材（U1）",
  },
  {
    route: "script validate",
    tokens: ["script", "validate"],
    positionals: ["slug"],
    options: {},
    required: [],
    usage: "vagent script validate <slug>",
    summary: "校验 script/script.json 并生成审核物 script.md（U3）",
    stopHint:
      "停点 1: 输出 script/script.md 供人工审核；确认后运行 tts run <slug>",
  },
  {
    route: "tts run",
    tokens: ["tts", "run"],
    positionals: ["slug"],
    options: { backend: { type: "string" }, voice: { type: "string" } },
    required: [],
    usage: "vagent tts run <slug> [--backend edge|say] [--voice <音色>]",
    summary: "逐段语音合成并合并音轨（U2；前置: script 已完成）",
  },
  {
    route: "compose run",
    tokens: ["compose", "run"],
    positionals: ["slug"],
    options: {},
    required: [],
    usage: "vagent compose run <slug>",
    summary: "渲染卡片帧并合成 9:16 视频（U4；前置: script+tts 已完成）",
  },
  {
    route: "package assemble",
    tokens: ["package", "assemble"],
    positionals: ["slug"],
    options: { cover: { type: "string" } },
    required: [],
    usage: "vagent package assemble <slug> [--cover <图片>]",
    summary: "组装发布包八件套并校验契约（U5）",
    stopHint:
      "停点 2: 输出 package/SUMMARY.md 检查单；核对后人工上传，再 register add",
  },
  {
    route: "package validate",
    tokens: ["package", "validate"],
    positionals: ["slug"],
    options: {},
    required: [],
    usage: "vagent package validate <slug>",
    summary: "校验已组装发布包的 Manifest v1 契约（U5，机器门禁）",
    stopHint:
      "停点 2: 契约通过后核对 SUMMARY.md 检查单，人工上传，再 register add",
  },
  {
    route: "register add",
    tokens: ["register", "add"],
    positionals: [],
    options: {
      platform: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      "published-at": { type: "string" },
      package: { type: "string" },
    },
    required: ["platform", "url", "title", "published-at", "package"],
    usage:
      "vagent register add --platform <shipinhao|douyin> --url <链接> " +
      "--title <标题> --published-at <ISO时间> --package <发布包目录>",
    summary: "登记一次人工发布（U5；幂等键 platform+url）",
  },
  {
    route: "metrics add",
    tokens: ["metrics", "add"],
    positionals: [],
    options: {
      platform: { type: "string" },
      week: { type: "string" },
      followers: { type: "string" },
      views: { type: "string" },
      likes: { type: "string" },
      comments: { type: "string" },
      shares: { type: "string" },
    },
    required: [
      "platform",
      "week",
      "followers",
      "views",
      "likes",
      "comments",
      "shares",
    ],
    usage:
      "vagent metrics add --platform <shipinhao|douyin> --week <ISO周一> " +
      "--followers <n> --views <n> --likes <n> --comments <n> --shares <n>",
    summary: "录入一条周指标（U5；重复键为更正追加）",
  },
  {
    route: "report weekly",
    tokens: ["report", "weekly"],
    positionals: [],
    options: {},
    required: [],
    usage: "vagent report weekly [--json]",
    summary: "输出周报表（U5；互动率 views=0 时显示「无数据」）",
  },
  {
    route: "report baseline",
    tokens: ["report", "baseline"],
    positionals: [],
    options: {},
    required: [],
    usage: "vagent report baseline [--json]",
    summary: "输出基线报告（U5；每平台需 ≥4 个不同周的数据）",
  },
  {
    route: "check",
    tokens: ["check"],
    positionals: [],
    options: {},
    required: [],
    usage: "vagent check",
    summary: "门禁: prettier --check + bun test 串行汇总（BR-U6-9）",
  },
  {
    route: "whiteboard render",
    tokens: ["whiteboard", "render"],
    positionals: ["article.md"],
    options: {
      kind: { type: "string" },
      out: { type: "string" },
      frames: { type: "string" },
      stills: { type: "string" },
      cache: { type: "string" },
      tag: { type: "string" },
      persona: { type: "string" },
      assets: { type: "string" },
      arm: { type: "string" },
      "only-stills": { type: "boolean" },
      fresh: { type: "boolean" },
      "no-burn": { type: "boolean" },
    },
    required: [],
    usage:
      "vagent whiteboard render <article.md> [--kind short|long|auto] " +
      "[--only-stills] [--fresh] [--no-burn] [--persona <名>] " +
      "[--arm cuff|extend] " +
      "[--assets <素材根>] [--out <目录>] [--frames <目录>] " +
      "[--stills <目录>] [--cache <目录>] [--tag <前缀>]",
    summary:
      "Markdown → 白板讲解视频（配音 + 手写板书 + 手势 + 字幕）；" +
      "体裁默认按实测配音总时长自动判定",
    stopHint:
      "整片渲染约 1 小时：先用 --only-stills 出关键帧目视复核版式，再渲整片" +
      "（默认续跑，改过文章或版式必须加 --fresh）",
  },
];

/** Global flags merged into every command's parseArgs options (BR-U6-2). */
const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  "videos-root": { type: "string" },
} as const;

/** Parsed command handed from parse to dispatch. `route: "help"` = 帮助. */
export interface ParsedCommand {
  route: string;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
  json: boolean;
  videosRoot?: string;
}

/** Help text: command list + stop-point hints + global flags (BR-U6-11). */
export function helpText(): string {
  const lines: string[] = [
    "vagent — 文章/主题 → 竖版口播卡片视频 半自动流水线 CLI",
    "",
    "用法: vagent <命令> [参数]",
    "",
    "命令:",
  ];
  for (const spec of ROUTES) {
    lines.push(`  ${spec.usage}`);
    lines.push(`      ${spec.summary}`);
    if (spec.stopHint !== undefined) {
      lines.push(`      ⏸ ${spec.stopHint}`);
    }
  }
  lines.push(
    "",
    "全局参数:",
    "  --json          stdout 只输出 JsonEnvelope（stderr 仍为进度诊断）",
    "  --videos-root   覆盖视频工作目录根（默认 $VIDEOS_ROOT 或 ./videos）",
    "",
    "流程: init → script validate →⏸ 停点1 → tts run → compose run →",
    "      package assemble/validate →⏸ 停点2（人工上传）→ register add",
    "",
  );
  return lines.join("\n");
}

/** Route lookup: two-token match first, then one-token. Unknown → throw. */
function matchRoute(argv: string[]): RouteSpec {
  const two = ROUTES.find(
    (r) =>
      r.tokens.length === 2 &&
      r.tokens[0] === argv[0] &&
      r.tokens[1] === argv[1],
  );
  if (two !== undefined) return two;
  const one = ROUTES.find(
    (r) => r.tokens.length === 1 && r.tokens[0] === argv[0],
  );
  if (one !== undefined) return one;
  throw new ValidationError(
    `未知命令: ${argv.slice(0, 2).join(" ")}\n\n${helpText()}`,
  );
}

/**
 * Parses argv into a routed command (Workflow 1 step 1).
 *
 * @throws ValidationError on unknown command/flag, wrong positional count,
 *         or missing required flags — always carrying a usage summary.
 */
export function parseCli(argv: string[]): ParsedCommand {
  const first = argv[0];
  if (
    first === undefined ||
    first === "help" ||
    first === "--help" ||
    first === "-h"
  ) {
    return { route: "help", positionals: [], values: {}, json: false };
  }

  const spec = matchRoute(argv);
  const rest = argv.slice(spec.tokens.length);

  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...spec.options, ...GLOBAL_OPTIONS },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    throw new ValidationError(
      `参数解析失败: ${(cause as Error).message}\n用法: ${spec.usage}`,
      { cause },
    );
  }

  if (parsed.positionals.length !== spec.positionals.length) {
    throw new ValidationError(
      `位置参数不符: 期望 <${spec.positionals.join("> <")}>` +
        `（${spec.positionals.length} 个），得到 ${parsed.positionals.length} 个\n` +
        `用法: ${spec.usage}`,
    );
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;
  const missing = spec.required.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new ValidationError(
      `缺少必填参数: ${missing.map((n) => `--${n}`).join(" ")}\n用法: ${spec.usage}`,
    );
  }

  return {
    route: spec.route,
    positionals: parsed.positionals,
    values,
    json: values["json"] === true,
    videosRoot: values["videos-root"] as string | undefined,
  };
}
