/**
 * @module cli/parse
 *
 * argv parsing + the CommandSpec route table: native `util.parseArgs` and
 * hand-written routing — zero CLI framework dependencies (BR-U6-10, Q1=A).
 *
 * ## 路由表是唯一事实源
 *
 * 每个参数都带 `desc` / `values` / `default` / `example`，而不是只有类型。原因是
 * 这条 CLI 的**主要调用方是大模型**：它看不到源码，只能读 `--help` 或
 * `vagent schema --json`。参数说明散在中文 usage 字符串里时，模型只能猜值域，
 * 猜错就是一次失败的渲染（几十分钟）。所以：
 *
 * - `helpText()` 由元数据渲染，不再手写；
 * - `vagent schema --json` 把整张表（含全局参数与退出码表）吐给调用方；
 * - `docs/cli.md` 的命令参考段由同一份元数据生成，并有漂移测试锁住；
 * - 枚举参数在 parse 层就校验，报错信息自带值域——错在参数上不该等到跑了半程
 *   才由 core 抛出。
 *
 * Boundary rules honored here:
 * - Workflow 1 step 1: unknown command → ValidationError carrying the help text
 *   (main maps it to exit code 2).
 * - 必填 flag 齐全 / 枚举值域在此校验；slug 格式与业务值域仍由 U1-U5 校验.
 * - BR-U6-11: help text lists every command WITH its stop-point hint.
 * - Global flags: `--json`（信封输出, BR-U6-2）、`--videos-root`、`--data-root`、
 *   `--dry-run`（试跑档，见 `dry-run.ts`）.
 */

import { parseArgs } from "node:util";

import { ValidationError } from "@core/errors";

/** 参数类型（util.parseArgs 的两种）. */
export type FlagType = "string" | "boolean";

/** 一个参数的完整说明——`desc` 与枚举的 `values` 是硬要求，见模块注释. */
export interface FlagSpec {
  type: FlagType;
  /** 一句话说清这个参数干什么（大模型据此选参数）. */
  desc: string;
  /** 枚举值域；给了就在 parse 层校验. */
  values?: readonly string[];
  /** 默认值描述（"未给时会发生什么"，可以是环境变量名）. */
  default?: string;
  /** 缺失即报错. */
  required?: boolean;
  /** 一个真实可用的取值样例. */
  example?: string;
  /** 非枚举的格式约束（如 ISO 日期），写给调用方看. */
  format?: string;
}

/** 位置参数说明. */
export interface PositionalSpec {
  name: string;
  desc: string;
  example?: string;
  format?: string;
}

/** 命令分组（help 与 schema 的排序依据）. */
export type CommandGroup = "card-video" | "whiteboard" | "registry" | "meta";

/** 分组的中文标题. */
export const GROUP_TITLES: Record<CommandGroup, string> = {
  "card-video": "竖版口播卡片视频流水线",
  whiteboard: "白板讲解视频",
  registry: "发布登记与指标",
  meta: "元命令（自描述 / 门禁 / 人设）",
};

/** 代价档：`expensive` 的命令在 `--dry-run` 时给规模预估. */
export type CommandCost = "cheap" | "expensive";

/** One entry of the CommandSpec route table. */
export interface RouteSpec {
  /** Canonical route key, e.g. "script validate". */
  route: string;
  /** argv tokens that select this route (1 or 2). */
  tokens: string[];
  /** 位置参数（顺序即 argv 顺序）. */
  positionals: PositionalSpec[];
  /** 参数表（键 = flag 名，不含 `--`）. */
  options: Record<string, FlagSpec>;
  summary: string;
  group: CommandGroup;
  /** 这条命令会写出什么（相对工作目录；`--dry-run` 会照着它报计划）. */
  produces: string[];
  /** 前置命令（route key），供调用方排序. */
  requires?: string[];
  cost: CommandCost;
  /** 停点提示（人工审核位，BR-U6-11）. */
  stopHint?: string;
  /** 额外注意事项（幂等性、失败模式、值域细节）. */
  notes?: string[];
}

/** 平台枚举（与 `@core/registry` 的 Platform 同域）. */
const PLATFORMS = ["shipinhao", "douyin"] as const;

/** CommandSpec 子命令注册表（domain-entities.md, incl. v1.1 init）. */
export const ROUTES: RouteSpec[] = [
  {
    route: "init",
    tokens: ["init"],
    positionals: [
      {
        name: "slug",
        desc: "视频工作目录名，小写字母数字与连字符",
        example: "graph-vs-loop",
        format: "^[a-z0-9][a-z0-9-]*$",
      },
    ],
    options: {
      article: {
        type: "string",
        desc: "源文章 Markdown 路径；与 --topic 二选一",
        example: "./article.md",
      },
      topic: {
        type: "string",
        desc: "一句话主题（没有现成文章时用）；与 --article 二选一",
        example: "AI agent 的循环与图",
      },
    },
    summary: "初始化视频工作目录并保存素材（U1）",
    group: "card-video",
    produces: [
      "videos/<slug>/input/（源文章或主题）",
      "videos/<slug>/state.json",
    ],
    cost: "cheap",
    notes: [
      "--article 与 --topic 必须且只能给一个",
      "slug 已存在时报错而不覆盖：换名或先删掉旧目录",
    ],
  },
  {
    route: "script validate",
    tokens: ["script", "validate"],
    positionals: [
      { name: "slug", desc: "init 时用的工作目录名", example: "graph-vs-loop" },
    ],
    options: {},
    summary: "校验 script/script.json 并生成审核物 script.md（U3）",
    group: "card-video",
    produces: ["videos/<slug>/script/script.md"],
    requires: ["init"],
    cost: "cheap",
    stopHint:
      "停点 1: 输出 script/script.md 供人工审核；确认后运行 tts run <slug>",
    notes: [
      "受限领域命中（财经/医疗/法律/赌博）抛 DomainGuardError 且零产物落盘",
      "script.json 由 LLM 或人写入，CLI 只校验，不生成内容",
    ],
  },
  {
    route: "tts run",
    tokens: ["tts", "run"],
    positionals: [
      { name: "slug", desc: "init 时用的工作目录名", example: "graph-vs-loop" },
    ],
    options: {
      backend: {
        type: "string",
        desc: "语音合成后端：edge=免费联网 Edge TTS，say=macOS 离线",
        values: ["edge", "say"],
        default: "$TTS_BACKEND，未设则 edge",
      },
      voice: {
        type: "string",
        desc: "音色 id（后端各自的音色名）",
        default: "$TTS_VOICE，未设则后端默认音色",
        example: "zh-CN-YunxiNeural",
      },
    },
    summary: "逐段语音合成并合并音轨（U2）",
    group: "card-video",
    produces: [
      "videos/<slug>/audio/seg-NN.mp3",
      "videos/<slug>/audio/merged.m4a",
      "videos/<slug>/audio/durations.json",
    ],
    requires: ["script validate"],
    cost: "expensive",
    notes: [
      "逐段幂等：已存在的 seg-NN.mp3 会跳过，中断后重跑只补缺的段",
      "只有网络类错误重试（500ms→1000ms），其余立即失败并带后端与段号",
    ],
  },
  {
    route: "compose run",
    tokens: ["compose", "run"],
    positionals: [
      { name: "slug", desc: "init 时用的工作目录名", example: "graph-vs-loop" },
    ],
    options: {
      template: {
        type: "string",
        desc: "卡片模板 JSON 路径（覆盖按配置名解析的默认模板）",
        default: "assets/templates/<配置模板名>.json",
        example: "./assets/templates/default.json",
      },
    },
    summary: "渲染卡片帧并合成 9:16 视频（U4）",
    group: "card-video",
    produces: [
      "videos/<slug>/cards/card-NN-P.png",
      "videos/<slug>/video/video.mp4",
      "videos/<slug>/video/video.srt",
    ],
    requires: ["tts run"],
    cost: "expensive",
    notes: [
      "script.json 里 style=whiteboard 时走白板渲染，同一条命令不变",
      "卡片帧幂等：已存在的 card-NN-P.png 会跳过，改过模板要先删 cards/ 再重跑",
    ],
  },
  {
    route: "package assemble",
    tokens: ["package", "assemble"],
    positionals: [
      { name: "slug", desc: "init 时用的工作目录名", example: "graph-vs-loop" },
    ],
    options: {
      cover: {
        type: "string",
        desc: "封面图路径；不给则用视频首帧",
        example: "./cover.png",
      },
    },
    summary: "组装发布包八件套并校验契约（U5）",
    group: "card-video",
    produces: [
      "videos/<slug>/package/manifest.json",
      "videos/<slug>/package/SUMMARY.md",
      "videos/<slug>/package/（成片 + 封面 + 元数据 + AIGC 声明 + 素材清单）",
    ],
    requires: ["compose run"],
    cost: "cheap",
    stopHint:
      "停点 2: 输出 package/SUMMARY.md 检查单；核对后人工上传，再 register add",
    notes: [
      "五份元数据（两平台文案 / AIGC 声明 / 素材清单 / 发布建议）需先由 LLM 写入 package/",
      "标题恰好 3 条、标签≥1、描述非空、AIGC 声明必须存在，缺一即 ContractViolationError",
    ],
  },
  {
    route: "package validate",
    tokens: ["package", "validate"],
    positionals: [
      { name: "slug", desc: "init 时用的工作目录名", example: "graph-vs-loop" },
    ],
    options: {},
    summary: "校验已组装发布包的 Manifest v1 契约（U5，机器门禁）",
    group: "card-video",
    produces: [],
    requires: ["package assemble"],
    cost: "cheap",
    stopHint:
      "停点 2: 契约通过后核对 SUMMARY.md 检查单，人工上传，再 register add",
  },
  {
    route: "register add",
    tokens: ["register", "add"],
    positionals: [],
    options: {
      platform: {
        type: "string",
        desc: "发布平台",
        values: PLATFORMS,
        required: true,
      },
      url: {
        type: "string",
        desc: "发布后的作品链接",
        required: true,
        example: "https://v.douyin.com/xxxxxxx/",
      },
      title: {
        type: "string",
        desc: "实际使用的标题（三个候选里选中的那个）",
        required: true,
      },
      "published-at": {
        type: "string",
        desc: "发布时刻",
        required: true,
        format: "ISO 8601，如 2026-07-26T20:00:00+08:00",
      },
      package: {
        type: "string",
        desc: "对应的发布包目录",
        required: true,
        example: "videos/graph-vs-loop/package",
      },
    },
    summary: "登记一次人工发布（U5；幂等键 platform+url）",
    group: "registry",
    produces: ["data/publishes.jsonl"],
    requires: ["package assemble"],
    cost: "cheap",
    notes: ["同一 platform+url 重复登记会被拒绝（幂等键）"],
  },
  {
    route: "metrics add",
    tokens: ["metrics", "add"],
    positionals: [],
    options: {
      platform: {
        type: "string",
        desc: "平台",
        values: PLATFORMS,
        required: true,
      },
      week: {
        type: "string",
        desc: "统计周的周一日期",
        required: true,
        format: "ISO 日期且必须是周一，如 2026-07-20",
      },
      followers: {
        type: "string",
        desc: "粉丝总数（非负整数）",
        required: true,
        example: "1200",
      },
      views: {
        type: "string",
        desc: "本周播放量（非负整数）",
        required: true,
        example: "35000",
      },
      likes: {
        type: "string",
        desc: "本周点赞数（非负整数）",
        required: true,
        example: "820",
      },
      comments: {
        type: "string",
        desc: "本周评论数（非负整数）",
        required: true,
        example: "64",
      },
      shares: {
        type: "string",
        desc: "本周转发数（非负整数）",
        required: true,
        example: "31",
      },
    },
    summary: "录入一条周指标（U5；重复键为更正追加）",
    group: "registry",
    produces: ["data/metrics.jsonl"],
    cost: "cheap",
    notes: ["同一 platform+week 再录一条＝更正，报表取最后一条"],
  },
  {
    route: "report weekly",
    tokens: ["report", "weekly"],
    positionals: [],
    options: {},
    summary: "输出周报表（U5；互动率 views=0 时显示「无数据」）",
    group: "registry",
    produces: [],
    requires: ["metrics add"],
    cost: "cheap",
  },
  {
    route: "report baseline",
    tokens: ["report", "baseline"],
    positionals: [],
    options: {},
    summary: "输出基线报告（U5；每平台需 ≥4 个不同周的数据）",
    group: "registry",
    produces: [],
    requires: ["metrics add"],
    cost: "cheap",
    notes: [
      "数据不足 4 周时抛 InsufficientDataError（退出码 10），不给半成品基线",
    ],
  },
  {
    route: "whiteboard render",
    tokens: ["whiteboard", "render"],
    positionals: [
      {
        name: "article.md",
        desc: "白板视频脚本（写法见 docs/whiteboard.md）",
        example: "./experiments/whiteboard-poc/article-graph-vs-loop.md",
      },
    ],
    options: {
      kind: {
        type: "string",
        desc: "体裁：short=竖版短片，long=横版长教程，auto=按实测配音总时长判定",
        values: ["short", "long", "auto"],
        default: "auto",
      },
      out: {
        type: "string",
        desc: "产物目录（mp4 / srt / 中间音轨）",
        default: "文章所在目录下的 out/",
      },
      frames: {
        type: "string",
        desc: "帧序列目录（p-%05d.png）",
        default: "文章所在目录下的 frames-<文章名>/",
      },
      stills: {
        type: "string",
        desc: "关键帧目录（--only-stills 用）",
        default: "文章所在目录下的 stills/",
      },
      cache: {
        type: "string",
        desc: "TTS 落盘缓存目录",
        default: "文章所在目录下的 cache/tts/",
      },
      tag: {
        type: "string",
        desc: "产物文件名前缀",
        default: "文章名（不含扩展名）",
      },
      persona: {
        type: "string",
        desc: "手势 persona（assets/sparkol/ 下的目录名）",
        default: "matt",
        example: "suneeta",
      },
      assets: {
        type: "string",
        desc: "素材根目录（其下按约定找 sparkol/ 与 manypixels/）",
        default: "仓库内 assets/",
      },
      arm: {
        type: "string",
        desc: "手臂收尾方式：cuff=袖口切断，extend=接出画幅",
        values: ["cuff", "extend"],
        default: "按画幅自动（横版 extend / 竖版 cuff）",
      },
      background: {
        type: "string",
        desc: "板面底纹",
        values: ["plain", "grid", "lined", "cream", "texture", "dots"],
        default: "文章的 > background: 指令，都没写则 plain",
      },
      cursor: {
        type: "string",
        desc: "画笔光标：hand=手拿笔（有擦除/搬运/点指手势），pen=只有一支笔",
        values: ["pen", "hand"],
        default: "hand",
      },
      preview: {
        type: "string",
        desc: "试看档：只渲开头这么多秒（帧/旁白/音效/字幕同一上限），产物带 -preview 后缀",
        example: "40",
        format: "正数秒",
      },
      "only-stills": {
        type: "boolean",
        desc: "只出关键帧目视复核版式（几秒出结果），不渲整片",
      },
      fresh: {
        type: "boolean",
        desc: "从零重渲；默认续跑（已存在的帧跳过）",
      },
      "no-burn": {
        type: "boolean",
        desc: "字幕不烧进画面（SRT 始终旁挂输出）",
      },
    },
    summary:
      "Markdown → 白板讲解视频（配音 + 手写板书 + 手势 + 字幕）；体裁默认按实测配音总时长自动判定",
    group: "whiteboard",
    produces: [
      "<out>/<tag>.mp4",
      "<out>/<tag>.srt",
      "<out>/<tag>-audio.m4a",
      "<frames>/p-*.png",
    ],
    cost: "expensive",
    stopHint:
      "整片渲染约 1 小时：先用 --only-stills 出关键帧复核版式，再用 --preview 30 试听配音/音效/字幕，最后渲整片（默认续跑，改过文章或版式必须加 --fresh）",
    notes: [
      "改过文章或版式后必须加 --fresh，否则会复用旧帧混进新片",
      "--preview 与 --only-stills 都不产生完整成片，帧目录也分开，不会污染整片续跑",
    ],
  },
  {
    route: "schema",
    tokens: ["schema"],
    positionals: [],
    options: {},
    summary:
      "输出整张命令表（JSON）：参数类型/值域/默认值/产物/前置，给大模型读",
    group: "meta",
    produces: [],
    cost: "cheap",
    notes: [
      "无论有没有 --json 都输出 JSON：它的唯一消费者是程序",
      "写 skill / 自动化脚本时先读它，命令改了不用改 skill",
    ],
  },
  {
    route: "persona show",
    tokens: ["persona", "show"],
    positionals: [],
    options: {},
    summary:
      "输出作者人设（口吻 / 选题 / 禁区 / 术语英文保留清单 / CTA / 署名 / 默认音色）",
    group: "meta",
    produces: [],
    cost: "cheap",
    notes: [
      "数据源 assets/persona/ermu.json；文件缺失不是错误，只是不署名",
      "skills 写文案前先读它，不要把口吻规则抄进 SKILL.md（会漂移）",
    ],
  },
  {
    route: "check",
    tokens: ["check"],
    positionals: [],
    options: {},
    summary: "门禁: prettier --check + bun test 串行汇总（BR-U6-9）",
    group: "meta",
    produces: [],
    cost: "expensive",
  },
];

/** Global flags merged into every command's parseArgs options (BR-U6-2). */
export const GLOBAL_OPTIONS: Record<string, FlagSpec> = {
  json: {
    type: "boolean",
    desc: "stdout 只输出单行 JsonEnvelope（stderr 仍是进度诊断）",
  },
  "dry-run": {
    type: "boolean",
    desc: "试跑：校验参数与前置产物、打印将写哪些文件，然后零写入退出 0",
  },
  "videos-root": {
    type: "string",
    desc: "覆盖视频工作目录根",
    default: "$VIDEOS_ROOT，未设则 ./videos",
  },
  "data-root": {
    type: "string",
    desc: "覆盖登记/指标数据目录（register / metrics / report 用）",
    default: "$DATA_ROOT，未设则 ./data",
  },
};

/** 退出码表（锁定；schema 里一并给调用方）. */
export const EXIT_CODES: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: 0, meaning: "成功" },
  { code: 1, meaning: "未捕获异常" },
  { code: 2, meaning: "ValidationError：参数或数据不合法" },
  { code: 3, meaning: "NotFoundError：工作目录或文件不存在" },
  { code: 4, meaning: "DomainGuardError：命中受限领域，零产物落盘" },
  { code: 5, meaning: "IoError：读写失败" },
  { code: 6, meaning: "FfmpegError：ffmpeg/ffprobe 失败（带 argv 与 stderr）" },
  { code: 7, meaning: "TTS 错误（带后端与段号）" },
  { code: 8, meaning: "RenderError：渲染失败" },
  { code: 9, meaning: "ContractViolationError：发布包契约不完整" },
  { code: 10, meaning: "InsufficientDataError：数据量不足（如基线不满 4 周）" },
];

/** Parsed command handed from parse to dispatch. `route: "help"` = 帮助. */
export interface ParsedCommand {
  route: string;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
  json: boolean;
  dryRun: boolean;
  videosRoot?: string;
  dataRoot?: string;
}

/** 一个参数的用法片段：`--voice <值>` / `--fresh`. */
function flagUsage(name: string, spec: FlagSpec): string {
  const body =
    spec.type === "boolean"
      ? `--${name}`
      : spec.values !== undefined
        ? `--${name} <${spec.values.join("|")}>`
        : `--${name} <${name}>`;
  return spec.required === true ? body : `[${body}]`;
}

/**
 * 用法行由元数据生成，不再手写。
 *
 * 手写的那份和 `options` 表漂移过（`--preview` 加进 options 却没进 usage），
 * 而用法行正是大模型第一眼看的东西。
 */
export function usageFor(spec: RouteSpec): string {
  const parts = ["vagent", ...spec.tokens];
  for (const p of spec.positionals) parts.push(`<${p.name}>`);
  const names = Object.keys(spec.options);
  const required = names.filter((n) => spec.options[n]!.required === true);
  const optional = names.filter((n) => spec.options[n]!.required !== true);
  for (const n of [...required, ...optional]) {
    parts.push(flagUsage(n, spec.options[n]!));
  }
  return parts.join(" ");
}

/** 路由查找（先两 token 再一 token）；未知命令返回 undefined. */
function findRoute(argv: string[]): RouteSpec | undefined {
  return (
    ROUTES.find(
      (r) =>
        r.tokens.length === 2 &&
        r.tokens[0] === argv[0] &&
        r.tokens[1] === argv[1],
    ) ?? ROUTES.find((r) => r.tokens.length === 1 && r.tokens[0] === argv[0])
  );
}

/** 按 route key 取用法行（命令实现里的报错信息复用它，避免两处漂移）. */
export function usageOf(route: string): string {
  const spec = ROUTES.find((r) => r.route === route);
  return spec === undefined ? `vagent ${route}` : usageFor(spec);
}

/** Help text: command list + stop-point hints + global flags (BR-U6-11). */
export function helpText(): string {
  const lines: string[] = [
    "vagent — media-video-cli: 文章/主题 → 短视频（卡片口播 / 白板讲解）半自动流水线",
    "",
    "用法: vagent <命令> [参数]",
    "",
    "机器可读的完整参数表: vagent schema --json",
    "任何命令加 --dry-run 可先试跑（零写入）",
  ];
  const groups: CommandGroup[] = [
    "card-video",
    "whiteboard",
    "registry",
    "meta",
  ];
  for (const g of groups) {
    const specs = ROUTES.filter((r) => r.group === g);
    if (specs.length === 0) continue;
    lines.push("", `${GROUP_TITLES[g]}:`);
    for (const spec of specs) {
      lines.push(`  ${usageFor(spec)}`);
      lines.push(`      ${spec.summary}`);
      if (spec.stopHint !== undefined) lines.push(`      ⏸ ${spec.stopHint}`);
    }
  }
  lines.push("", "全局参数:");
  for (const [name, spec] of Object.entries(GLOBAL_OPTIONS)) {
    const def = spec.default === undefined ? "" : `（默认: ${spec.default}）`;
    lines.push(`  --${name.padEnd(13)} ${spec.desc}${def}`);
  }
  lines.push(
    "",
    "流程: init → script validate →⏸ 停点1 → tts run → compose run →",
    "      package assemble/validate →⏸ 停点2（人工上传）→ register add",
    "",
  );
  return lines.join("\n");
}

/** schema 输出的命令条目. */
export interface SchemaCommand {
  route: string;
  tokens: string[];
  group: CommandGroup;
  summary: string;
  usage: string;
  cost: CommandCost;
  positionals: PositionalSpec[];
  flags: Array<{ name: string } & FlagSpec>;
  produces: string[];
  requires: string[];
  stopHint?: string;
  notes: string[];
}

/** `vagent schema` 的输出（大模型的唯一参数来源）. */
export interface CliSchema {
  cli: string;
  product: string;
  version: string;
  description: string;
  groups: Array<{ id: CommandGroup; title: string }>;
  globals: Array<{ name: string } & FlagSpec>;
  exitCodes: ReadonlyArray<{ code: number; meaning: string }>;
  commands: SchemaCommand[];
}

function flagList(
  options: Record<string, FlagSpec>,
): Array<{ name: string } & FlagSpec> {
  return Object.entries(options).map(([name, spec]) => ({ name, ...spec }));
}

/** 路由表 → schema（纯函数：`schema` 命令与文档生成器共用）. */
export function cliSchema(version: string): CliSchema {
  return {
    cli: "vagent",
    product: "media-video-cli",
    version,
    description:
      "半自动短视频生产管线：Markdown / 主题 → 竖版口播卡片视频或横版白板讲解视频 + 可上传的发布包。" +
      "内容创作由 LLM 或人完成，确定性工作（校验/合成/渲染/打包/登记）全部走本 CLI。",
    groups: (["card-video", "whiteboard", "registry", "meta"] as const).map(
      (id) => ({ id, title: GROUP_TITLES[id] }),
    ),
    globals: flagList(GLOBAL_OPTIONS),
    exitCodes: EXIT_CODES,
    commands: ROUTES.map((spec) => ({
      route: spec.route,
      tokens: spec.tokens,
      group: spec.group,
      summary: spec.summary,
      usage: usageFor(spec),
      cost: spec.cost,
      positionals: spec.positionals,
      flags: flagList(spec.options),
      produces: spec.produces,
      requires: spec.requires ?? [],
      ...(spec.stopHint === undefined ? {} : { stopHint: spec.stopHint }),
      notes: spec.notes ?? [],
    })),
  };
}

/**
 * Parses argv into a routed command (Workflow 1 step 1).
 *
 * @throws ValidationError on unknown command/flag, wrong positional count,
 *         missing required flags, or an out-of-domain enum value — always
 *         carrying the usage line (and the value domain when it is an enum).
 */
export function parseCli(argv: string[]): ParsedCommand {
  const first = argv[0];
  if (
    first === undefined ||
    first === "help" ||
    first === "--help" ||
    first === "-h"
  ) {
    return {
      route: "help",
      positionals: [],
      values: {},
      json: false,
      dryRun: false,
    };
  }

  const spec = findRoute(argv);
  if (spec === undefined) {
    throw new ValidationError(
      `未知命令: ${argv.slice(0, 2).join(" ")}\n\n${helpText()}`,
    );
  }
  const rest = argv.slice(spec.tokens.length);

  const options: Record<string, { type: FlagType }> = {};
  for (const [name, f] of Object.entries({
    ...spec.options,
    ...GLOBAL_OPTIONS,
  })) {
    options[name] = { type: f.type };
  }

  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    throw new ValidationError(
      `参数解析失败: ${(cause as Error).message}\n用法: ${usageFor(spec)}`,
      { cause },
    );
  }

  if (parsed.positionals.length !== spec.positionals.length) {
    const names = spec.positionals.map((p) => p.name);
    throw new ValidationError(
      `位置参数不符: 期望 <${names.join("> <")}>` +
        `（${names.length} 个），得到 ${parsed.positionals.length} 个\n` +
        `用法: ${usageFor(spec)}`,
    );
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;

  const missing = Object.entries(spec.options)
    .filter(([name, f]) => f.required === true && values[name] === undefined)
    .map(([name]) => `--${name}`);
  if (missing.length > 0) {
    throw new ValidationError(
      `缺少必填参数: ${missing.join(" ")}\n用法: ${usageFor(spec)}`,
    );
  }

  // 枚举值域在此校验：错在参数上不该等 core 跑到一半才发现，而且这里能把
  // 完整值域写进报错——大模型改一次就对了。
  for (const [name, f] of Object.entries(spec.options)) {
    const got = values[name];
    if (f.values === undefined || typeof got !== "string") continue;
    if (!f.values.includes(got)) {
      throw new ValidationError(
        `--${name} 值非法: "${got}"（允许: ${f.values.join(" | ")}）\n` +
          `用法: ${usageFor(spec)}`,
      );
    }
  }

  return {
    route: spec.route,
    positionals: parsed.positionals,
    values,
    json: values["json"] === true,
    dryRun: values["dry-run"] === true,
    videosRoot: values["videos-root"] as string | undefined,
    dataRoot: values["data-root"] as string | undefined,
  };
}
