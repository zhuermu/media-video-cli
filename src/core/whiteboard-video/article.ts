/**
 * PoC: 流水线第一段 —— Markdown 文章 → 分镜（Section[]）
 *
 * 生产里这一步是 LLM 干的：它读文章，输出下面这个 `Article` 的 JSON。
 * 本模块用**确定性的 Markdown 结构映射**产出同一份中间表示，理由有两个：
 * 1. 这段的产物才是流水线真正的契约。先把契约钉死，后面几段（配音、
 *    版式、混音）就能独立开发和回归，不必每次都等一次 LLM 调用；
 * 2. demo 要可复现。同一篇文章跑两次必须出同一条视频，否则没法判断
 *    "画面变了"是改对了还是模型飘了。
 *
 * ## 映射规则（也就是 LLM 需要遵守的输出约定）
 *
 * | Markdown              | 含义 |
 * |-----------------------|------|
 * | `# 标题`              | 全片主标题 |
 * | `> key: value`        | 片级指令（cast / format，见下） |
 * | `## 标题`             | 一个分镜，标题写在板上 |
 * | 普通段落              | 口播台词（**只有它进配音**，板上不写） |
 * | `角色：台词`          | 指定说话人（角色须在 cast 里） |
 * | `角色（情绪）：台词`  | 指定说话人 + 情绪 |
 * | `- 列表项`            | 板上的打勾要点（写） |
 * | `~~文本~~`            | 先写、再擦掉的假设（擦） |
 * | `![alt](路径)`        | 搬进画面的外部图片（搬） |
 * | `![alt](il:kw1,kw2)`  | 素材库检索词（英文），匹配一张扁平插画 |
 *
 * 片级指令：
 * ```
 * > cast: 主讲=news-male-formal, 提问=narrator-female-warm
 * > format: auto | short | long
 * ```
 * `cast` 也可以写预设名（`> cast: interview`，见 voices.ts 的 CAST_PRESETS）。
 *
 * 插画用**英文检索词**而不是中文，是因为素材库的关键词是英文，而中英映射
 * 属于上游 LLM 的活（它在读全文，比事后猜关键词准）。见 assets-match.ts。
 *
 * 口播与板书**故意分离**：白板视频的板上文字是关键词，口播是完整句子。
 * 让两者相同是最常见的翻车方式——观众会去读板上的长句，然后既没听清也
 * 没看完。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ValidationError } from "../errors/index";
import { isBoardBlockKind, parseBoardBlock } from "./board-block";
import type { BoardSpec } from "./board-block";
import { isBoardBackground } from "./board";
import type { BoardBackground } from "./board";
import { parseChartBlock } from "./chart-block";
import { hasInlineMarks, parseInlineMarks } from "./inline-marks";
import type { ChartSpec } from "./chart-block";
import type { Cue } from "./narrate";
import type { Emotion } from "./voices";
import { CAST_PRESETS } from "./voices";

/** 成片体裁：竖版短片 / 横版长教程 / 按时长自动判. */
export type VideoKind = "short" | "long" | "auto";

/** 一个分镜：板上画什么 + 谁说什么. */
export interface Section {
  /** 板上的标题（`##` 的内容）. */
  title: string;
  /** 口播台词（按顺序；单人片全是同一个角色）. */
  cues: Cue[];
  /** 打勾要点（板上写） */
  bullets: string[];
  /** 先写再擦的假设（`~~…~~`）；无则 undefined. */
  scratch?: string;
  /** 搬进画面的外部图片绝对路径；无则 undefined. */
  image?: string;
  /** 素材库检索词（英文）；无则该段不配插画. */
  illustration?: string[];
  /** 板上画的图表（```chart``` 块）；无则该段不配图表. */
  chart?: ChartSpec;
  /** 板上画的图形块（```table``` / ```flow``` / … ）；无则该段不配. */
  board?: BoardSpec;
}

export interface Article {
  /** 全片主标题（`#`）. */
  title: string;
  sections: Section[];
  /** 角色名 → 音色库 id. */
  cast: Record<string, string>;
  /**
   * 文章里是否**显式**写了 `> cast:`。
   *
   * 需要这个布尔，是因为"没写 cast"和"写了 solo 预设"在补完默认值之后长得一样，
   * 而人设的默认音色只该覆盖前者：作者显式选了音色就不该被人设改掉。
   */
  castAuthored: boolean;
  kind: VideoKind;
  /** 板面底纹（`> background:`）；未写则由 config 的默认值决定. */
  background?: BoardBackground;
  /**
   * 收尾要不要手写作者签名与关注引导（`> signature: on|off`），默认 on。
   *
   * 默认开是有意的：署名是这条流水线的常态，"这条片子不署名"才是例外。缺人设
   * 文件时 compose 自己会跳过，所以默认开不会在没配人设的仓库里报错。
   */
  signature: boolean;
}

/** 单人片的默认角色名（脚本里不写角色名时归到它）. */
export const DEFAULT_SPEAKER = "旁白";

/** 情绪词（中文写法 → 库内 Emotion）. */
const EMOTION_WORDS: Record<string, Emotion> = {
  平静: "calm",
  沉稳: "calm",
  上扬: "upbeat",
  轻快: "upbeat",
  严肃: "serious",
  警告: "serious",
  温和: "gentle",
  安慰: "gentle",
  急: "urgent",
  紧迫: "urgent",
  设问: "question",
  疑问: "question",
};

/** `![alt](路径)` 的路径若是目录，取其中第一张图（便于直接指素材目录）. */
function firstImageIn(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).isFile()) return path;
  const stack = [path];
  const found: string[] = [];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(jpe?g|png)$/i.test(e.name)) found.push(p);
    }
  }
  // 排序后取首个：同一个目录每次跑都拿同一张图（可复现）
  return found.sort()[0];
}

/** 解析 `> cast: …`：既接预设名，也接 `角色=音色id` 列表. */
function parseCast(value: string): Record<string, string> {
  const preset = CAST_PRESETS[value.trim()];
  if (preset !== undefined) return { ...preset };
  const out: Record<string, string> = {};
  for (const pair of value.split(/[,，]/)) {
    const m = /^\s*([^=]+?)\s*=\s*(\S+)\s*$/.exec(pair);
    if (m !== null) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * 解析文章。
 *
 * @param path Markdown 文件路径（图片路径相对它所在目录解析）
 * @throws Error 文章里没有 `##` 分镜
 */
/**
 * 占用这一段的**媒体位**，已被占则报错。
 *
 * 一段只有一个媒体位（图片 / 插画 / 图表 / 板书块共用），因为版式只给了一个：
 * 两个媒体挤进去要么互相压住，要么把要点挤出画幅。这里当场报错而不是自动挪到
 * 下一段——作者的意图是"这两样都在这一段"，静默重排会让成片和文章不对应。
 */
function claimMedia(s: Section, what: string): void {
  const held =
    s.chart !== undefined
      ? "图表"
      : s.board !== undefined
        ? "板书块"
        : s.image !== undefined
          ? "图片"
          : s.illustration !== undefined
            ? "插画"
            : null;
  if (held !== null) {
    throw new ValidationError(
      `段「${s.title}」已经有${held}，${what}放不下了——一段只有一个媒体位，请拆成两段`,
    );
  }
}

export function parseArticle(path: string): Article {
  const baseDir = dirname(resolve(path));
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  let title = "";
  let cast: Record<string, string> = {};
  let castAuthored = false;
  let kind: VideoKind = "auto";
  let background: BoardBackground | undefined;
  let signature = true;
  const sections: Section[] = [];
  let cur: Section | null = null;
  /** 当前正在收集的围栏代码块（null = 不在块内）. */
  let fence: { info: string; body: string[] } | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    // —— 围栏代码块：必须在所有其他规则之前处理 ——
    //
    // 否则块里的内容会被逐行当成普通段落，也就是**当成口播台词念出来**。
    if (fence !== null) {
      if (/^```/.test(line)) {
        const info = fence.info;
        const body = fence.body.join("\n");
        fence = null;
        if (/^chart\b/.test(info)) {
          if (cur === null) {
            throw new ValidationError(
              "```chart``` 块出现在第一个 `## 分镜` 之前，不知道该画在哪一段",
            );
          }
          claimMedia(cur, "图表");
          try {
            cur.chart = parseChartBlock(info, body);
          } catch (cause) {
            // 补上段落上下文：光说"数据行读不懂"，作者还得自己找是哪一段
            const msg = cause instanceof Error ? cause.message : String(cause);
            throw new ValidationError(
              `段「${cur.title}」的图表块有问题：${msg}`,
              {
                cause,
              },
            );
          }
        } else if (isBoardBlockKind(info.split(/\s+/)[0] ?? "")) {
          if (cur === null) {
            throw new ValidationError(
              `\`\`\`${info}\`\`\` 块出现在第一个 \`## 分镜\` 之前，不知道该画在哪一段`,
            );
          }
          claimMedia(cur, `板书块 ${info.split(/\s+/)[0]}`);
          try {
            cur.board = parseBoardBlock(info, body);
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            throw new ValidationError(
              `段「${cur.title}」的 \`\`\`${info}\`\`\` 块有问题：${msg}`,
              { cause },
            );
          }
        } else {
          // 非图表围栏（```js 之类）：跳过内容，但要说出来。
          // 静默丢内容和把代码念出来一样糟，两者之间选"跳过 + 明确告知"。
          console.error(
            `⚠ 段「${cur?.title ?? "?"}」里的 \`\`\`${info || "(无语言)"}\`\`\` 代码块已跳过（白板视频不朗读代码块）`,
          );
        }
        continue;
      }
      fence.body.push(raw);
      continue;
    }
    const fenceOpen = /^```\s*(.*)$/.exec(line);
    if (fenceOpen !== null) {
      fence = { info: fenceOpen[1]!.trim(), body: [] };
      continue;
    }

    if (line === "") continue;

    // 片级指令（必须在第一个 ## 之前）
    const directive = /^>\s*([A-Za-z]+)\s*[:：]\s*(.+)$/.exec(line);
    if (directive !== null) {
      const k = directive[1]!.toLowerCase();
      const v = directive[2]!.trim();
      if (k === "cast") {
        cast = parseCast(v);
        castAuthored = true;
      } else if (
        k === "format" &&
        (v === "short" || v === "long" || v === "auto")
      ) {
        kind = v;
      } else if (k === "background") {
        // 未知底纹当场报错：写错一个词就静默回到纯白，作者会以为指令没生效
        if (!isBoardBackground(v)) {
          throw new ValidationError(
            `底纹 "${v}" 不支持；可用：plain | grid | lined | cream | texture | dots`,
          );
        }
        background = v;
      } else if (k === "signature") {
        // 和底纹同样的道理：写错一个词就静默不署名，作者不会发现
        if (v !== "on" && v !== "off") {
          throw new ValidationError(`signature 只接受 on | off，得到 "${v}"`);
        }
        signature = v === "on";
      }
      continue;
    }

    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1 !== null) {
      title = h1[1]!.trim();
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2 !== null) {
      cur = { title: h2[1]!.trim(), cues: [], bullets: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) continue;

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const text = bullet[1]!.trim();
      // 行内标记在这里就校验一遍（渲染层还会解析一次）：未闭合/嵌套的标记若拖到
      // 渲染期才报，错误信息里没有段落名，作者得自己找是哪一行。
      if (hasInlineMarks(text)) {
        try {
          parseInlineMarks(text);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          throw new ValidationError(
            `段「${cur.title}」的要点行内标记有问题：${msg}`,
            { cause },
          );
        }
      }
      cur.bullets.push(text);
      continue;
    }
    const strike = /^~~(.+)~~$/.exec(line);
    if (strike !== null) {
      cur.scratch = strike[1]!.trim();
      continue;
    }
    const img = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(line);
    if (img !== null) {
      claimMedia(cur, "图片/插画");
      const p = img[1]!.trim();
      if (p.startsWith("il:")) {
        cur.illustration = p
          .slice(3)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      } else {
        const abs = p.startsWith("/") ? p : join(baseDir, p);
        cur.image = firstImageIn(abs);
        if (cur.image === undefined) {
          // 静默降级是最难查的一类问题：图没找到 → 搬入手势和后面的点指
          // 一起消失，成片看起来"就是这么设计的"。必须报出来。
          console.error(
            `⚠ 段「${cur.title}」引用的外部图片找不到: ${abs}（搬入 / 点指手势会缺失）`,
          );
        }
      }
      continue;
    }

    // 口播台词。`角色：` / `角色（情绪）：` 前缀只在角色已登记在 cast 时才
    // 当说话人处理 —— 否则"注意：这里有个坑"这种正常句子会被误判成角色。
    //
    // 只剥 `*` 和反引号，**不剥下划线**：技术内容里 `offline_access`、
    // `user_access_token` 这类标识符满地都是，按 Markdown 斜体去剥会把它们
    // 念成 "offlineaccess"（字幕里也一样错）。CJK 文本里用下划线做斜体本来
    // 就不常见，权衡下来保留下划线更安全。
    const clean = line.replace(/[*`]/g, "");
    const spoken =
      /^([^：:（(]{1,8})(?:[（(]([^）)]{1,6})[）)])?\s*[：:]\s*(.+)$/.exec(
        clean,
      );
    if (spoken !== null && cast[spoken[1]!.trim()] !== undefined) {
      const emotion =
        spoken[2] === undefined ? undefined : EMOTION_WORDS[spoken[2].trim()];
      cur.cues.push({
        speaker: spoken[1]!.trim(),
        text: spoken[3]!.trim(),
        ...(emotion === undefined ? {} : { emotion }),
      });
      continue;
    }
    // 无角色前缀：并入上一条同角色台词，或起一条默认角色的
    const last = cur.cues[cur.cues.length - 1];
    if (last !== undefined && last.speaker === DEFAULT_SPEAKER) {
      last.text += clean;
    } else {
      cur.cues.push({ speaker: DEFAULT_SPEAKER, text: clean });
    }
  }

  if (sections.length === 0) {
    throw new Error(`文章里没有 "## " 分镜: ${path}`);
  }
  // 没写 cast 也要能跑：补上默认角色
  if (cast[DEFAULT_SPEAKER] === undefined) {
    cast = { ...CAST_PRESETS["solo"], ...cast };
  }
  return background === undefined
    ? { title, sections, cast, castAuthored, kind, signature }
    : { title, sections, cast, castAuthored, kind, background, signature };
}
