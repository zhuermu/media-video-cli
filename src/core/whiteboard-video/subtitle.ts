/**
 * PoC: 流水线字幕段 —— 词级时间戳 → 字幕行 → 帧内矢量字幕 + 旁挂 SRT
 *
 * ## 为什么字幕画进帧里，而不是交给 ffmpeg 烧
 *
 * 本机 ffmpeg（homebrew 8.0.1）**没编 libass 也没编 freetype**：
 * ```
 * $ ffmpeg -filters | grep -E "subtitles|drawtext"   → 空
 * ```
 * 也就是说 `-vf subtitles=` / `drawtext` 这两条路都不通。与其要求使用者去
 * 重装一个特定编译选项的 ffmpeg（流水线要能在别人机器上跑），不如把字幕
 * 当成画面的一部分：反正帧本来就是我们自己拼的 SVG。
 *
 * 代价是字幕不可关闭，所以同时**旁挂一份 SRT**：需要软字幕的场合用无字幕
 * 帧 + SRT 另出一版即可（`--no-burn`）。
 *
 * ## 字形走矢量路径，不走 <text>
 *
 * 帧渲染器是 `font: { loadSystemFonts: false }` 的（逐帧解析 80MB 的
 * PingFang.ttc 曾把帧时间从 75ms 拖到 660ms）。所以字幕也必须无字体依赖：
 * 规划期用 opentype 把每个字转成 path，逐帧只拼字符串。同一行只转一次。
 *
 * ## 断行规则
 *
 * 先按中文句读（。！？；，）切，再对超长句按字数硬切。每行 ≤ 18 字：竖屏
 * 1080 宽、字号 46 时一行放得下约 20 个全宽字，留两个字的余量给标点悬挂。
 */

import {
  clamp01,
  fmt,
  glyphVector,
  sansGlyphVector,
} from "../whiteboard/index";
import type { TimelineEl } from "../whiteboard/index";
import type { Narration } from "./narrate";
import { timeAtChar } from "./narrate";

/**
 * 单行字幕上限字数。
 *
 * 22 个全宽字在 46px 字号下约 1010px，1080 短边的画幅放得下并留出边距。
 * 更小的值（早先是 18）会把 "IdP 不满足 Desktop 的 OIDC 要求" 这种句子硬切
 * 成两行，第二行只剩 "OIDC 要求" 四个字，一闪而过。
 */
const MAX_CHARS = 22;

/** 优先在这些标点后断行. */
const BREAK_AFTER = /[。！？；，、：]/;

/**
 * 构成"一个词"的字符：拉丁字母、数字，以及标识符里会出现的连接符。
 *
 * 中日韩汉字**不算**——中文每个字都能独立断行，把汉字算进来会让"不满足"
 * 这种词组也不许断，反而挤出很多短行。
 */
const WORD_CHAR = /[0-9A-Za-z_$@#.\-+/]/;

/** 往后找词尾时最多允许超出的字数（宁可这行略长，也别劈开词）. */
const OVERFLOW_TOLERANCE = 6;

/** 切在 `cut` 处会不会把一个词劈成两半. */
function splitsWord(text: string, cut: number): boolean {
  const before = text[cut - 1];
  const after = text[cut];
  if (before === undefined || after === undefined) return false;
  return WORD_CHAR.test(before) && WORD_CHAR.test(after);
}

/**
 * 把理想切点挪到不劈开单词的位置。
 *
 * 没有这个的话，长句硬切会切出 "……需要 offline_ac" / "cess 才能拿到……"
 * 这种字幕：观众得把两行拼起来才知道那是什么词，而字幕是一闪而过的。
 *
 * 先往后找词尾（让这行略微超长），找不到再往前退到词首；退太多会切出
 * 半空的一行，所以退到半行就放弃，接受硬切——整行是一个超长标识符时，
 * 硬切是唯一的选择。
 */
function safeCut(
  text: string,
  from: number,
  ideal: number,
  to: number,
): number {
  if (!splitsWord(text, ideal)) return ideal;
  const forwardLimit = Math.min(to, ideal + OVERFLOW_TOLERANCE);
  for (let p = ideal + 1; p <= forwardLimit; p++) {
    if (!splitsWord(text, p)) return p;
  }
  const backLimit = from + Math.ceil(MAX_CHARS / 2);
  for (let p = ideal - 1; p >= backLimit; p--) {
    if (!splitsWord(text, p)) return p;
  }
  return ideal;
}

/** 一行字幕（绝对时间轴）. */
export interface SubtitleLine {
  text: string;
  t0: number;
  t1: number;
}

export interface VectorTextOpts {
  /** 左端 x（anchor="end" 时为右端）. */
  x: number;
  /** 字框顶边 y. */
  y: number;
  size: number;
  color: string;
  opacity?: number;
  anchor?: "start" | "middle" | "end";
  /** 字间额外间距. */
  tracking?: number;
  /**
   * 字形来源。默认 `handwriting`（手写体优先、缺字回退无衬线）；
   * `sans` 直接用无衬线字体——字幕专用，见 {@link sansGlyphVector}。
   */
  font?: "handwriting" | "sans";
}

/**
 * 把一行文字转成矢量 path 组（无字体依赖）。
 *
 * 帧渲染器是 `loadSystemFonts: false` 的（逐帧解析系统字体曾把帧时间从
 * 75ms 拖到 660ms），所以画面里**任何**文字都不能用 `<text>` —— 那会直接
 * 渲染成空白。字幕、页眉、角标全走这里。
 *
 * @returns `{ svg, width }`；width 用于居中/右对齐或画底板
 */
export function vectorText(
  text: string,
  o: VectorTextOpts,
): { svg: string; width: number } {
  const chars = [...text];
  const tracking = o.tracking ?? 0;
  const glyph = o.font === "sans" ? sansGlyphVector : glyphVector;
  const vecs = chars.map((ch) => glyph(ch, o.size));
  const advance = (i: number): number =>
    (vecs[i]?.advance ?? (/\s/.test(chars[i]!) ? o.size * 0.4 : o.size)) +
    tracking;
  const width = chars.reduce((a, _c, i) => a + advance(i), 0);
  let x = o.x;
  if (o.anchor === "end") x = o.x - width;
  else if (o.anchor === "middle") x = o.x - width / 2;
  const parts: string[] = [];
  for (const [i, v] of vecs.entries()) {
    if (v !== null) {
      // glyphVector 的 d 以字框左上角为原点、基线已内置
      parts.push(
        `<path d="${v.d}" transform="translate(${fmt(x)},${fmt(o.y)})" fill="${o.color}"/>`,
      );
    }
    x += advance(i);
  }
  const op = o.opacity ?? 1;
  const svg =
    op >= 1
      ? parts.join("")
      : `<g fill-opacity="${fmt(op)}">${parts.join("")}</g>`;
  return { svg, width };
}

/**
 * 把一段口播切成字幕行，并用词级时间戳定位每行的起止。
 *
 * @param n 该段口播（含词边界）
 * @param offset 这段口播在全片时间轴上的起点（秒）
 */
export function subtitleLines(n: Narration, offset: number): SubtitleLine[] {
  const text = n.text;
  if (text.length === 0) return [];

  // —— 切行：先按句读切成小句，再贪心打包到接近上限 ——
  //
  // 只按句读切会切出"照片和截图"这种五个字的行：一行一闪，观众眼睛一直在
  // 跳。打包后一行接近满，阅读节奏才跟得上语速。
  const clauses: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    // 标点跟在小句末尾，不要孤零零地起一行
    if (BREAK_AFTER.test(text[i]!) || i === text.length - 1) {
      clauses.push({ from, to: i + 1 });
      from = i + 1;
    }
  }
  const spans: Array<{ from: number; to: number }> = [];
  for (const c of clauses) {
    const last = spans[spans.length - 1];
    const len = c.to - c.from;
    if (last !== undefined && last.to - last.from + len <= MAX_CHARS) {
      last.to = c.to;
      continue;
    }
    if (len <= MAX_CHARS) {
      spans.push({ ...c });
      continue;
    }
    // 单个小句就超上限（长句无标点）→ 切段，但不劈开单词
    let p = c.from;
    while (p < c.to) {
      const ideal = Math.min(c.to, p + MAX_CHARS);
      const cut = ideal >= c.to ? c.to : safeCut(text, p, ideal, c.to);
      spans.push({ from: p, to: cut });
      p = cut;
    }
  }

  const out: SubtitleLine[] = [];
  for (const s of spans) {
    const raw = text.slice(s.from, s.to);
    // 行尾标点去掉：字幕里不显示逗号句号更干净（口播里仍然读出停顿）
    // 首尾空白也去掉：切在词间空格上时，下一行会顶着一个空格起头
    const shown = raw.replace(/[。，、；：]$/, "").trim();
    if (shown === "") continue;
    const t0 = offset + timeAtChar(n, s.from);
    const t1 = offset + timeAtChar(n, s.to);
    out.push({ text: shown, t0, t1: Math.max(t1, t0 + 0.25) });
  }
  // 相邻行首尾相接（去掉几十毫秒的空档，否则字幕会闪）
  for (let i = 0; i < out.length - 1; i++) {
    out[i]!.t1 = Math.max(out[i]!.t1, out[i + 1]!.t0);
  }
  const last = out[out.length - 1];
  if (last !== undefined) last.t1 = Math.max(last.t1, offset + n.durationSec);
  return out;
}

/** SRT 时间码 `HH:MM:SS,mmm`. */
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (v: number, w = 2): string => String(v).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

/** 生成 SRT 文本（软字幕旁挂用）. */
export function toSrt(lines: readonly SubtitleLine[]): string {
  return lines
    .map(
      (l, i) => `${i + 1}\n${srtTime(l.t0)} --> ${srtTime(l.t1)}\n${l.text}\n`,
    )
    .join("\n");
}

/** 一行字幕的预转矢量结果（规划期算一次，逐帧复用）. */
interface BakedLine extends SubtitleLine {
  /** 已平移到最终位置的字形 path 集合. */
  glyphs: string;
  width: number;
}

export interface SubtitleStyleOpts {
  /** 画幅. */
  width: number;
  height: number;
  /** 字号. Default 46 × (width/1080). */
  size?: number;
  /** 字幕基线距画面底部的距离. Default 高度的 12%（给平台 UI 留位）. */
  bottom?: number;
  color?: string;
  /** 背景板颜色（半透明白，压住画面里的笔迹）. */
  plate?: string;
}

/**
 * 字幕时间轴元素：整片一个，内部按 t 选当前行。
 *
 * 不给每行各建一个元素，是因为帧装配要按 `t0/t1` 做视口剔除和排序，几十个
 * 一闪而过的小元素只会把那两件事变吵；字幕在概念上就是一条**轨道**。
 */
export function subtitleEl(
  lines: readonly SubtitleLine[],
  o: SubtitleStyleOpts,
): TimelineEl {
  // 按**短边**定字号，不是宽度：横屏 1920 宽会把字幕放大 1.78 倍，一行占掉
  // 半屏。两个画幅的短边都是 1080，短边归一后横竖屏的字幕一样大。
  const scale = Math.min(o.width, o.height) / 1080;
  const size = o.size ?? 46 * scale;
  const bottom = o.bottom ?? o.height * 0.12;
  const color = o.color ?? "#1b1f24";
  const plate = o.plate ?? "#ffffffdd";
  const baseY = o.height - bottom;

  const baked: BakedLine[] = lines.map((l) => {
    const { svg, width } = vectorText(l.text, {
      x: o.width / 2,
      y: baseY - size,
      size,
      color,
      anchor: "middle",
      // 字幕走无衬线，和板上的手写体拉开：字幕是叠在画面上的一层说明，
      // 不是白板上又写了一行字。字重/字形一致时，观众会去"读板书"。
      font: "sans",
      tracking: size * 0.03,
    });
    return { ...l, glyphs: svg, width };
  });

  const t0 = baked[0]?.t0 ?? 0;
  const t1 = baked[baked.length - 1]?.t1 ?? 0;

  return {
    t0,
    t1,
    svg(t) {
      // 逆序找：后面的行覆盖前面的（相邻行首尾相接，边界上取新行）
      let hit: BakedLine | undefined;
      for (const l of baked) {
        if (t >= l.t0 && t < l.t1) hit = l;
      }
      if (hit === undefined) return "";
      // 入场/退场各 80ms 淡变，避免硬切闪烁
      const fade = 0.08;
      const op =
        Math.min(clamp01((t - hit.t0) / fade), clamp01((hit.t1 - t) / fade)) *
        0.98;
      if (op <= 0.01) return "";
      const padX = size * 0.5;
      const padY = size * 0.34;
      return (
        `<g opacity="${fmt(op)}">` +
        `<rect x="${fmt((o.width - hit.width) / 2 - padX)}" y="${fmt(baseY - size - padY * 0.55)}" ` +
        `width="${fmt(hit.width + padX * 2)}" height="${fmt(size + padY * 1.7)}" rx="${fmt(size * 0.26)}" fill="${plate}"/>` +
        hit.glyphs +
        `</g>`
      );
    },
  };
}
