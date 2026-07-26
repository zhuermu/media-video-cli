/**
 * @module core/whiteboard-video/compose
 *
 * 分镜 + 配音 → **时间轴**：一段一屏的版式，段间整板擦净。
 *
 * ## 排片为什么不做时间缩放
 *
 * 直觉做法是"把画面时间轴按配音时长等比缩放"。不能这么干：**书写速度是
 * 感知常量**。同一支笔在第一段每秒写两个字、第三段每秒写五个字，观众会
 * 立刻觉得后面在赶时间 —— 而这个瑕疵没法用其他手段补救。
 *
 * 所以反过来：单段时长取 `max(配音时长, 板面时长)`，谁长听谁的。
 * - 板面先画完 → 定格，旁白继续说（真人讲课就是这样）；
 * - 旁白先说完 → 段尾补静音，让笔把这一笔写完再擦板。
 *
 * ## 段间为什么擦板而不是硬切
 *
 * 白板上的东西是一笔一笔画上去的，凭空消失不符合这个世界的规则。整板擦净
 * 承认前一段存在过，再把它清掉；硬切会让观众怀疑自己漏看了什么。
 */

import { existsSync, readFileSync } from "node:fs";

import { fmt, iconDrawSec, iconPaths } from "../whiteboard/index";
import type { CamMove, Pt, TimelineEl } from "../whiteboard/index";
import type { Article, Section } from "./article";
import { W, checklist, markerTextEl, textWidth, titleBlock } from "./blocks";
import { cellsBounds, planCamera, serpentineCells } from "./canvas";
import { markerStrokesEl } from "./marker";
import { PALETTE, rolesFor } from "./palette";
import type { PaletteRoles } from "./palette";
import { isDarkBackground } from "./board";
import type { BoardBackground } from "./board";
import type { Cell } from "./canvas";
import { boardBeats } from "./board-block";
import { LINE_W, curvedArrow } from "./strokes";
import { chartBeats } from "./chart-block";
import type { BlockCtx, TitleBlockOpts } from "./blocks";
import { matchIllustration } from "./assets-match";
import { flatIllustrationEl, importFlatSvg } from "./flat-import";
import type { FlatIllustration } from "./flat-import";
import type { FormatSpec } from "./format";
import { carryInEl, penElements, pointEl } from "./gestures";
import type { GestureEl, HandKit, WipeElement } from "./gestures";
import { ImageLoader, imageAspect } from "./images";
import {
  CELL_H_RATIO,
  contentBottom,
  contentW,
  leftCol,
  rightCol,
} from "./layout";
import type { Layout } from "./layout";
import type { Log } from "./log";
import { silent } from "./log";
import type { Persona } from "@core/persona";
import type { SpokenLine } from "./narrate";
import { subtitleLines } from "./subtitle";
import type { SubtitleLine } from "./subtitle";

/** 板面画完到开始擦板之间的停顿（让最后一笔落定）. */
export const HOLD_BEFORE_WIPE = 0.4;
/** 整板擦净时长（旧的翻页式换场，无限画布下不再使用）. */
export const WIPE_SEC = 1.4;
/** 擦完到下一段开画的间隔. */
export const AFTER_WIPE = 0.25;
/** 段间平移时长（镜头从上一格挪到下一格）. */
export const PAN_SEC = 1.5;
/** 平移结束到下一段开画的间隔. */
export const AFTER_PAN = 0.3;
/** 收尾拉远（看全景）的时长. */
export const ZOOM_OUT_SEC = 3.2;
/** 拉远到位后停留多久（给观众扫一遍整门课）. */
export const OVERVIEW_HOLD = 1.8;
/** 末段收尾（不擦板，留给观众看完）. */
export const FINAL_TAIL = 0.9;
/** 段内元素之间的呼吸. */
export const BEAT = 0.32;
/** 只用旁白前这么多比例的时长排板书（末尾留白让最后一笔落定）. */
const BEAT_WINDOW = 0.82;

/** 一段配音的结果（`speakSection` 的返回形状）. */
export interface SpokenSection {
  lines: SpokenLine[];
  durationSec: number;
}

/** 一段在全片时间轴上的排片结果. */
export interface PlacedSection {
  index: number;
  /** 本段在画布上的地盘. */
  cell: Cell;
  start: number;
  /** 段末（下一段起点）. */
  end: number;
  els: GestureEl[];
  /** 整板擦净（末段为 null）. */
  wipe: WipeElement | null;
}

/** 帧渲染器需要的全部时间轴信息. */
export interface Storyboard {
  placed: PlacedSection[];
  /** 每段在无限画布上的地盘（与 placed 同序）. */
  cells: Cell[];
  /** 镜头计划（段间平移 + 收尾拉远）. */
  camMoves: CamMove[];
  /** 所有扁平插画（`<defs>` 要在每帧顶部挂一遍）. */
  illustrations: FlatIllustration[];
  subtitles: SubtitleLine[];
  /** 全片时长（秒）. */
  totalSec: number;
  /** 全部元素（含擦板），供 `activeHandCue` 用. */
  elements: GestureEl[];
  /** 笔真的在板上的那些元素，供 `penPoseAt` / writing 音效用. */
  penElements: TimelineEl[];
  /**
   * 段与段之间的连接箭头（画布空间，**不参与按格剔除**）。
   *
   * 单独一条列表而不是塞进某一段的 els：它横跨两格，挂在任一格上都会在另一格
   * 单独可见时被剔掉。数量是段数减一、每条两条折线，全画一遍的代价可忽略。
   */
  links: GestureEl[];
  /**
   * 音效点位（画面语义 → 时刻）。
   *
   * 由排版层给而不是混音层猜：只有这里知道"这一笔是打勾、那一拍是图形块入场"。
   * 早先混音层自己从元素列表里找线索（whoosh 挂"擦板起点"），改版把擦板换成
   * 镜头平移之后挂钩静默失效，整片一声不响——语义必须由产生它的那一层声明。
   */
  sfxCues: SfxCues;
}

export interface ComposeInput {
  article: Article;
  /** 与 `article.sections` 一一对应. */
  spoken: readonly SpokenSection[];
  format: FormatSpec;
  kit: HandKit;
  ink: string;
  accent: string;
  /**
   * 板面背景（决定亮色/深色两套语义色）。
   *
   * 排版层需要知道深浅，不只是渲染层：连接弧线、注解、状态徽章的颜色都要
   * 跟着换，而这些颜色是在排版时就写进元素里的。
   */
  background?: BoardBackground;
  /** ManyPixels 插画库根目录. */
  illustrationsDir: string;
  /**
   * 作者人设（见 core/persona）。给了且文章没写 `> signature: off` 时，收尾
   * 拉远之后在画布角落手写签名 + 关注引导。缺省 = 不署名。
   */
  persona?: Persona;
  log?: Log;
}

/**
 * 一"拍"板书：版式已经算好，只有开始时刻待定。
 *
 * 把版式和排时分开，是为了让板书能**摊到旁白上**。早先的做法是一口气把
 * 标题、插画、要点全画完，然后定格等旁白说完 —— 一段旁白 40 秒、板面只有
 * 14 秒，观众有 26 秒盯着一块不动的板子。全片 7 分钟里有 5 分钟是静止画面。
 */
interface Beat {
  build(t0: number): { els: GestureEl[]; end: number };
  /**
   * 这一拍在画面上是什么事——**音效挂钩的唯一来源**。
   *
   * 声音的语义只有排版层知道（"这一笔是打勾还是框线"），混音层只看得到
   * 元素和时间。所以让每一拍自己声明，混音层不做任何猜测。
   */
  cue?: SfxCueKind;
}

/** 点状音效的类目（对应 `assets/sfx/manifest.json` 里的挂钩 id）. */
export type SfxCueKind = "ding" | "pop" | "sparkle";

/** 全片音效点位（画面语义 → 时刻，秒）. */
export interface SfxCues {
  /** 打勾（要点逐条确认）. */
  ding: number[];
  /** 图形块 / 图表 / 图片入场. */
  pop: number[];
  /** 强调标记：划掉、口播问号/感叹号. */
  sparkle: number[];
  /** 收尾拉远看全景（一次）. */
  page: number[];
}

interface BuiltSection {
  els: GestureEl[];
  ils: FlatIllustration[];
  localEnd: number;
  /** 本段的音效点位（段内局部时间，compose 再平移到全片）. */
  cues: Omit<SfxCues, "page">;
  /** 本段内容实际用到的最低点（画幅局部坐标），用于在格子里竖向居中. */
  bottomY: number;
}

/**
 * 每一拍希望开始的时刻（相对本段起点）。
 *
 * ## 规则：按序分配到句子，只延后不提前
 *
 * n 拍分给 m 句，第 i 拍归到第 `floor(i·m/n)` 句——**单调、不重复吸附**。
 * 同一句里分到多拍时，在这句的时长内均分。
 *
 * 早先的做法是"每拍各自取离均匀目标最近的句首"，它有两个会直接被观众看出来
 * 的毛病：
 *
 * 1. **多拍吸到同一句首**。6 拍 2 句时六个目标全落到两个时刻，于是讲第一句
 *    的时候板上一次冒出三条要点，后面一大段没东西可看。
 * 2. **可能提前**。"最近的句首"允许把一拍拉到上一句开头——话还没说到，结论
 *    已经写在板上了。讲解片里这是最伤的一种不同步：观众读完了才听到你讲，
 *    再讲就成了复述。
 *
 * 所以这里只允许**延后到句首**（宁可讲了半句才落笔），且拍序与句序严格同向。
 * 笔速不参与调整——书写速度是感知常量，忽快忽慢比不同步更难看（见模块头）。
 */
export function beatTargets(
  lines: readonly SpokenLine[],
  count: number,
  audioSec: number,
): number[] {
  if (count <= 0) return [];
  const usable = audioSec * BEAT_WINDOW;
  const even = (i: number): number => (i / count) * usable;
  // 只保留落在可排窗口内的句子；一句都没有（或只有一句）就退回均匀分布
  const starts = lines.map((l) => l.offset).filter((o) => o < usable);
  if (starts.length < 2) {
    return Array.from({ length: count }, (_, i) => even(i));
  }

  const m = starts.length;
  const out: number[] = [];
  // 最后一句的可用区间按**配音全长**算，不按 BEAT_WINDOW 截。窗口是为段尾运镜
  // 留白用的，可最后一句要是起得晚（比如 21.1s 处、配音 26s），拿窗口当终点
  // 只剩 0.2s，分到它的几拍会挤成同时出现——那正是这套算法要消除的毛病。
  const tail = audioSec * 0.94;
  for (let i = 0; i < count; i += 1) {
    const li = Math.min(m - 1, Math.floor((i * m) / count));
    const lineStart = starts[li]!;
    const lineEnd = starts[li + 1] ?? Math.max(usable, tail);
    // 这一句分到几拍、当前是其中第几拍
    const first = Math.ceil((li * count) / m);
    const next = Math.ceil(((li + 1) * count) / m);
    const share = Math.max(1, next - first);
    const k = Math.min(share - 1, Math.max(0, i - first));
    const span = Math.max(0, lineEnd - lineStart);
    out.push(lineStart + (span * k) / share);
  }
  return out;
}

/** 解析一张扁平插画（解析失败就返回 null，让版式退化成纯文字）. */
function loadIllustration(path: string, idp: string): FlatIllustration | null {
  if (!existsSync(path)) return null;
  try {
    return importFlatSvg(readFileSync(path, "utf8"), idp);
  } catch {
    return null;
  }
}

/**
 * 时间平移。
 *
 * 不做"段外返回空串"的硬门控 —— 换页由整板擦净负责（见 `boardWipeEl`）。
 * 擦完之后遮罩全黑，内容自然就没了。
 */
export function shiftEl(el: GestureEl, shift: number): GestureEl {
  const t1 = el.t1 + shift;
  const out: GestureEl = {
    t0: el.t0 + shift,
    t1,
    bbox: el.bbox,
    svg(t) {
      if (t < shift) return "";
      return el.svg(t - shift);
    },
  };
  if (el.pen !== undefined) {
    const pen = el.pen;
    out.pen = (t) => {
      if (t < shift || t > t1) return null;
      // 区间内一律给出位姿，并把局部时间**夹回**被包元素自己的区间。
      //
      // 两处都必须做。`penPoseAt` 对区间端点是强制解包，而 `t1 - shift` 在
      // 浮点下可能比 `el.t1` 大一丝：只夹参数不改判空条件，端点仍然会返回
      // null 然后崩；只判空不夹参数，被包元素自己的 `t > t1 → null` 会命中。
      // 代理声明了 [t0+shift, t1+shift]，就得为这个区间里的每个 t 负责。
      return pen(Math.min(Math.max(t - shift, el.t0), el.t1));
    };
  }
  if (el.penSpan !== undefined) {
    out.penSpan = [el.penSpan[0] + shift, el.penSpan[1] + shift];
  }
  if (el.hand !== undefined) {
    const hand = el.hand;
    out.hand = (t) => (t < shift ? null : hand(t - shift));
  }
  return out;
}

/**
 * 空间平移（与 {@link shiftEl} 的时间平移对称）。
 *
 * 无限画布上每段有自己的地盘，但段内的版式代码仍然在**局部坐标**（0..画幅）里
 * 算——这样 blocks / charts / diagrams 全都不必知道自己被摆在画布哪儿。平移在
 * 这一层统一加上。
 *
 * 三样东西都要挪，漏一样就会错位：
 * - `svg` 用 `<g transform>` 包一层（不去改字符串里的坐标）；
 * - `pen` 返回的笔尖位置要加偏移——笔的贴图画在画布层里，和内容同一个坐标系；
 * - `hand` 返回的手势位姿同理。
 */
export function translateEl(el: GestureEl, dx: number, dy: number): GestureEl {
  const open = `<g transform="translate(${fmt(dx)} ${fmt(dy)})">`;
  const out: GestureEl = {
    t0: el.t0,
    t1: el.t1,
    svg(t) {
      const s = el.svg(t);
      return s === "" ? "" : `${open}${s}</g>`;
    },
  };
  if (el.bbox !== undefined) {
    const [bx, by, bw, bh] = el.bbox;
    out.bbox = [bx + dx, by + dy, bw, bh];
  }
  if (el.pen !== undefined) {
    const pen = el.pen;
    out.pen = (t) => {
      const p = pen(t);
      return p === null ? null : [p[0] + dx, p[1] + dy];
    };
  }
  if (el.penSpan !== undefined) out.penSpan = el.penSpan;
  if (el.hand !== undefined) {
    const hand = el.hand;
    out.hand = (t) => {
      const c = hand(t);
      return c === null ? null : { ...c, x: c.x + dx, y: c.y + dy };
    };
  }
  return out;
}

/** 一段的版式（局部时间轴，从 0 起算）. */
function buildSection(
  s: Section,
  idx: number,
  lines: readonly SpokenLine[],
  audioSec: number,
  cx: {
    L: Layout;
    ctx: BlockCtx;
    kit: HandKit;
    ink: string;
    accent: string;
    /** 语义色（亮/深两套，见 palette 的 `rolesFor`）. */
    roles: PaletteRoles;
    images: ImageLoader;
    illustrationsDir: string;
    log: Log;
  },
): BuiltSection {
  const { L, ctx, kit, ink, accent, roles, images, log } = cx;
  const idp = `s${idx}`;
  const ils: FlatIllustration[] = [];
  const T = L.type;
  const twoCol = L.columns === 2;
  const textCol = twoCol ? leftCol(L) : { x: L.marginX, w: contentW(L) };
  const mediaCol = twoCol ? rightCol(L) : { x: L.marginX, w: contentW(L) };
  /** 版式在收集期就算好（不依赖时间），只把 t0 留到排时阶段. */
  const beats: Beat[] = [];
  /**
   * 不排进拍子、直接贴在**口播时刻**上的元素（口播标记）。
   *
   * 拍子是"讲到哪写到哪"的节奏骨架，问号不该占用一拍——占了就会把后面所有
   * 内容往后推，而问号只是伴随那句话出现的一个小记号。
   */
  const els0: Array<{ at: number; el: GestureEl }> = [];

  // —— 标题 ——
  const titleOpts: Omit<TitleBlockOpts, "t0"> = {
    x: L.marginX,
    y: L.marginTop,
    size: T.title,
    perChar: T.titlePerChar,
    underline: 1,
    underlineAccent: true,
    idp: `${idp}T`,
  };
  const titleGeom = titleBlock(s.title, { ...titleOpts, t0: 0 }, ctx);
  beats.push({
    build(t0) {
      const b = titleBlock(s.title, { ...titleOpts, t0 }, ctx);
      return { els: b.els, end: b.endT };
    },
  });
  // —— 口播标记：设问画问号、强调画感叹号 ——
  //
  // 讲解片里"提问"这件事只存在于声音里：换了个音色问一句，画面上什么都没变，
  // 观众得靠听辨。在标题右侧画一个手绘问号，问句就有了视觉锚——这也是 scribe
  // 视频最常见的手法（说到什么就画什么）。
  //
  // 判据取**句尾标点**而不是"谁在说"：同一个人也会设问，而问号该跟着问句走。
  // 位置放在标题右侧的空白里：那块地方本来就空着（标题降权后只占左侧三成），
  // 而且和标题同一行读起来像"这一段的问号"，不会和下面的图抢位置。
  const cueMarks = lines
    .map((l, i) => {
      const text = l.narration.text.trimEnd();
      const name = /[？?]$/.test(text)
        ? "question"
        : /[！!]$/.test(text)
          ? "exclaim"
          : null;
      return name === null ? null : { name, at: l.offset, i };
    })
    .filter((m): m is { name: string; at: number; i: number } => m !== null)
    .slice(0, 2);
  for (const [k, mark] of cueMarks.entries()) {
    const size = T.title * 2.1;
    const cx = Math.min(
      L.marginX + titleGeom.width + size * (1.1 + k * 1.15),
      L.marginX + contentW(L) - size * 0.6,
    );
    const cy = L.marginTop + size * 0.5;
    els0.push({
      at: mark.at,
      el: markerStrokesEl(iconPaths(mark.name, cx, cy, size), {
        t0: mark.at,
        dur: iconDrawSec(mark.name) * 1.1,
        color: accent,
        width: LINE_W.bold,
        seed: `${idp}q${k}`,
        amp: 1.3,
        overshoot: false,
      }),
    });
  }

  let textY = titleGeom.bottomY + T.body * 0.9;
  let mediaY = twoCol ? titleGeom.bottomY + T.body * 0.9 : textY;

  // —— 划掉：先写一个假设，再一笔划掉（不擦除） ——
  //
  // 无限画布上没有板擦了，但更重要的是**划掉比擦掉信息量大**：收尾拉远看全景时，
  // 观众还能看见"这条曾经被提出、然后被否了"。擦干净只剩一片空白，那段推理就只
  // 存在于口播里。
  if (s.scratch !== undefined) {
    const size = T.body;
    const y = textY;
    const w = textWidth(s.scratch, size, size * 0.06);
    const scratch = s.scratch;
    beats.push({
      cue: "sparkle",
      build(t0) {
        const hypo = markerTextEl(scratch, {
          x: textCol.x,
          y,
          size,
          gap: size * 0.06,
          t0,
          perChar: T.bodyPerChar,
          color: ink,
          idp: `${idp}H`,
        });
        // 划线略微斜、两端各出头一点：真人划掉是一挥而过，不是精确对齐的删除线
        const my = y + size * 0.52;
        const strike = markerStrokesEl(
          [
            [
              [textCol.x - size * 0.14, my + size * 0.06],
              [textCol.x + w + size * 0.16, my - size * 0.05],
            ],
          ],
          {
            t0: hypo.t1 + 0.28,
            dur: 0.42,
            color: roles.danger,
            width: W.body,
            seed: `${idp}sk`,
            amp: 2.2,
          },
        );
        return { els: [hypo, strike], end: strike.t1 };
      },
    });
    // 划掉的那行仍占版面（它还在板上），下一行照常往下走
    textY += size * 1.7;
    if (!twoCol) mediaY = textY;
  }

  // —— 搬：外部图片 ——
  //
  // 布局规则：**本段没有要点时，图占满内容宽度**；有要点时图留在媒体栏。
  //
  // 文档里的架构图宽高比在 2.1–2.5 之间，塞进横版右栏只有 380px 高，图里的
  // 字在投屏上根本看不清。这类图本身就是这一页的主角，不该和要点抢地方。
  // 把规则挂在"有没有要点"上而不是自动猜，作者能预期，也不会静默丢内容。
  let imageBox: { x: number; y: number; w: number; h: number } | null = null;
  if (s.image !== undefined) {
    const full = s.bullets.length === 0;
    const aspect = imageAspect(s.image);
    // 纵向可用高度：标题以下，再给字幕留出安全区（字幕基线在 12% 高处）
    const availH = contentBottom(L) - mediaY - L.height * (full ? 0.14 : 0);
    const availW = full ? contentW(L) : mediaCol.w * (twoCol ? 0.98 : 0.88);
    const w = Math.round(Math.min(availW, availH * aspect));
    const h = Math.round(w / aspect);
    imageBox = { x: Math.round((L.width - w) / 2), y: mediaY, w, h };
    if (!full && twoCol) {
      imageBox.x = Math.round(mediaCol.x + (mediaCol.w - w) / 2);
    }
    const href = images.uri(s.image, w);
    const box = imageBox;
    beats.push({
      cue: "pop",
      build(t0) {
        const carry = carryInEl({
          href,
          ...box,
          t0,
          from: "right",
          hand: kit.carry,
          canvasW: L.width,
          canvasH: L.height,
          frame: { color: ink, width: 6 },
        });
        return { els: [carry], end: carry.t1 };
      },
    });
    mediaY += h + T.body * 0.9;
    if (!twoCol || full) textY = Math.max(textY, mediaY);
  } else if (s.chart !== undefined) {
    // —— 图表：占媒体位，规则与外部图片一致（本段没要点 → 占满内容宽度） ——
    //
    // 图表比插画更吃宽度：纵轴要放刻度值、横轴要放类目名，挤在窄栏里刻度会先
    // 糊掉，而刻度糊掉的图表就退回装饰了。所以宽度优先级高于"和要点并排"。
    const full = s.bullets.length === 0;
    const availH = contentBottom(L) - mediaY - L.height * 0.02;
    const w = full ? contentW(L) : mediaCol.w * (twoCol ? 0.98 : 0.9);
    const h = Math.min(availH, full ? L.height * 0.34 : availH);
    const cxBox = {
      x: full ? L.marginX : twoCol ? mediaCol.x : L.marginX,
      y: mediaY,
      w,
      h,
    };
    const { beats: cBeats, bottomY } = chartBeats(s.chart, cxBox, {
      ink,
      bodySize: T.body,
      idp: `${idp}C`,
      roles,
    });
    for (const [bi, b] of cBeats.entries()) {
      beats.push(bi === 0 ? { ...b, cue: "pop" } : b);
    }
    mediaY = bottomY + T.body * 0.6;
    if (!twoCol || full) textY = Math.max(textY, mediaY);
  } else if (s.board !== undefined) {
    // —— 板书块（表格/流程/导图/图标流/场景/便签/状态）：与图表同一个媒体位 ——
    //
    // 高度上限按块类型分：流程图和导图是**纵向**生长的（节点串成一列），给不够
    // 高就会把节点压成扁条；场景是一幅**按高度限宽**的画（见 sceneBeats），高度
    // 就是它的尺寸旋钮；表格/图标流/状态是横向铺开的，给太多高度只会留白。
    // 这个区分必须在这里做——board-block 只知道自己的形状，不知道这一段还有没有
    // 要点要排在下面。
    const full = s.bullets.length === 0;
    const tall =
      s.board.kind === "flow" ||
      s.board.kind === "mindmap" ||
      s.board.kind === "scene";
    const availH = contentBottom(L) - mediaY - L.height * 0.02;
    const w = full ? contentW(L) : mediaCol.w * (twoCol ? 0.98 : 0.9);
    const h = Math.min(availH, L.height * (tall ? 0.52 : 0.34));
    const bBox = {
      x: full ? L.marginX : twoCol ? mediaCol.x : L.marginX,
      y: mediaY,
      w,
      h,
    };
    const { beats: bBeats, bottomY } = boardBeats(s.board, bBox, {
      ink,
      bodySize: T.body,
      idp: `${idp}B`,
      roles,
    });
    for (const [bi, b] of bBeats.entries()) {
      beats.push(bi === 0 ? { ...b, cue: "pop" } : b);
    }
    mediaY = bottomY + T.body * 0.6;
    if (!twoCol || full) textY = Math.max(textY, mediaY);
  } else if (s.illustration !== undefined) {
    // 素材库匹配（英文检索词由上游给，见 assets-match.ts）
    const hit = matchIllustration(cx.illustrationsDir, s.illustration);
    const il = hit === null ? null : loadIllustration(hit.path, `${idp}i_`);
    if (hit !== null) {
      log(
        `    素材匹配 [${s.illustration.join(",")}] → ${hit.slug}` +
          `（${hit.name}，分 ${hit.score}）${il === null ? " ⚠ 解析失败" : ""}`,
      );
    } else {
      log(`    素材匹配 [${s.illustration.join(",")}] → 无命中，走纯文字`);
    }
    if (il !== null) {
      ils.push(il);
      const size = Math.min(
        mediaCol.w * (twoCol ? 0.9 : 0.8),
        contentBottom(L) - mediaY - (twoCol ? 0 : T.body * 6),
        twoCol ? 560 : 700,
      );
      const ilCx = twoCol ? mediaCol.x + mediaCol.w / 2 : L.width / 2;
      const ilCy = mediaY + size / 2;
      beats.push({
        cue: "pop",
        build(t0) {
          const hero = flatIllustrationEl(il, {
            cx: ilCx,
            cy: ilCy,
            size,
            t0,
            dur: 2.2,
            reveal: "scribble",
            scribbleRows: 8,
          });
          return { els: [hero], end: hero.t1 };
        },
      });
      mediaY += size + T.body * 0.5;
      if (!twoCol) textY = mediaY;
    }
  }

  // —— 写：打勾要点（**每条一拍**，逐条摊到旁白上） ——
  const lineHeight = T.body * 1.95;
  for (const [i, item] of s.bullets.entries()) {
    const y = textY + i * lineHeight;
    beats.push({
      cue: "ding",
      build(t0) {
        const one = checklist(
          [item],
          {
            x: textCol.x + 10,
            y,
            size: T.body,
            lineHeight,
            t0,
            perChar: T.bodyPerChar,
            idp: `${idp}L${i}`,
            checkAccent: true,
          },
          ctx,
        );
        return { els: one.els, end: one.endT };
      },
    });
  }

  // —— 指：搬进来的图值得再点一下 ——
  if (imageBox !== null && kit.point !== null) {
    const box = imageBox;
    const hand = kit.point;
    beats.push({
      build(t0) {
        const pt = pointEl({
          x: box.x + box.w * 0.52,
          y: box.y + box.h * 0.6,
          t0,
          dur: 1.3,
          taps: 2,
          hand,
          from: "bottom",
          canvasW: L.width,
          canvasH: L.height,
          ring: { color: accent, r: 96, width: 5 },
        });
        return { els: [pt], end: pt.t1 };
      },
    });
  }

  // —— 排时：把每一拍推到它的目标时刻（不早于上一拍结束 + 呼吸） ——
  const targets = beatTargets(lines, beats.length, audioSec);
  const els: GestureEl[] = [];
  const cues: Omit<SfxCues, "page"> = { ding: [], pop: [], sparkle: [] };
  let t = 0.25;
  for (const [i, beat] of beats.entries()) {
    t = Math.max(t, targets[i] ?? t);
    const r = beat.build(t);
    els.push(...r.els);
    if (beat.cue !== undefined) cues[beat.cue].push(t);
    t = r.end + BEAT;
  }
  for (const m of els0) {
    els.push(m.el);
    cues.sparkle.push(m.at);
  }

  // 内容实际占到哪里：媒体位和要点栏各自往下长，取更低的那个
  const bulletsBottom =
    s.bullets.length === 0
      ? textY
      : textY + (s.bullets.length - 1) * lineHeight + T.body * 1.2;
  return {
    els,
    ils,
    localEnd: t,
    cues,
    bottomY: Math.max(mediaY, bulletsBottom),
  };
}

/**
 * 段与段之间的**连接箭头**（画在两格之间的空白上，随镜头平移时画出来）。
 *
 * 这是"承上启下"落到画面上的那一笔。没有它，无限画布只是把一屏屏内容并排摆着，
 * 收尾拉远看到的是一堆互不相干的方块；有了它，全景读起来是一条讲述线索——上一
 * 块的结论引出下一块的问题。
 *
 * 三个刻意的选择：
 * - **画在平移窗口里**，不在段内：观众看到的顺序是"这一块讲完 → 笔往下一块引
 *   一条线 → 镜头跟着线过去"，运镜因此有了动机，而不是无缘无故地平移。
 * - **走弧线**而不是直线：直线连两个方块读作流程图的边（有严格的先后语义），
 *   弧线读作"顺手一带"，更接近讲述而不是建模。
 * - **muted 色 + 细线**：它是脉络提示，不该比内容本身重。
 */
function linkEl(
  from: Cell,
  to: Cell,
  t0: number,
  dur: number,
  idp: string,
  muted: string,
): GestureEl {
  // 起点在上一格内容区的右下/左下角，终点在下一格标题的左上方
  const rightward = to.x >= from.x;
  const sameRow = Math.abs(to.y - from.y) < from.h * 0.5;
  const start: Pt = sameRow
    ? [
        from.x + (rightward ? from.w * 0.94 : from.w * 0.06),
        from.y + from.h * 0.62,
      ]
    : [from.x + from.w * 0.5, from.y + from.h * 0.95];
  const end: Pt = sameRow
    ? [to.x + (rightward ? to.w * 0.06 : to.w * 0.94), to.y + to.h * 0.42]
    : [to.x + to.w * 0.5, to.y + to.h * 0.08];
  // 弧的凸向：同行时往下鼓，换行时往前进方向鼓
  const bulge = sameRow ? 0.18 : 0.22;
  const paths = curvedArrow(start[0], start[1], end[0], end[1], bulge, 26);
  return markerStrokesEl(paths, {
    t0,
    dur,
    color: muted,
    width: LINE_W.thin,
    seed: `${idp}link`,
    amp: 2.2,
    overshoot: false,
    opacity: 0.8,
  });
}

/** 分镜 + 配音 → 全片时间轴. */
export function composeStoryboard(input: ComposeInput): Storyboard {
  const { article, spoken, format, kit, ink, accent } = input;
  // 语义色随板面深浅整套切换：深板上 muted/primary 要提亮，否则注解与
  // 连接线在深底上糊掉（见 palette 的 DARK_PALETTE）
  const roles = rolesFor(isDarkBackground(input.background ?? "plain"));
  const log = input.log ?? silent;
  const L = format.layout;
  const dark = isDarkBackground(input.background ?? "plain");
  const ctx: BlockCtx = { ink, accent, beat: BEAT, layout: L, dark };
  const images = new ImageLoader(log);
  const cx = {
    L,
    roles,
    ctx,
    kit,
    ink,
    accent,
    images,
    illustrationsDir: input.illustrationsDir,
    log,
  };

  const placed: PlacedSection[] = [];
  const illustrations: FlatIllustration[] = [];
  const subtitles: SubtitleLine[] = [];
  // 无限画布：每段一格，蛇形铺开（见 canvas.ts 的取舍）
  // 格高刻意**小于画幅高度**（0.78）：一段内容实际只用到画幅上部 60% 左右，
  // 若一格就是一整屏，收尾拉远时行与行之间会连成大片空白。格高收紧后，镜头
  // 视野比格子高，上下行的笔迹会从画面边缘露出一点——这正是"同一块画布"该有的
  // 样子（参考 scribe 视频：镜头移动时总能看见邻近内容的一角）。
  //
  // 格宽保持等于画幅宽：横向是主要的阅读方向，露出邻格会让当前内容看起来没排满。
  const cells = serpentineCells(article.sections.length, {
    cellW: L.width,
    cellH: L.height * CELL_H_RATIO,
  });
  const panWindows: Array<readonly [number, number]> = [];
  const links: GestureEl[] = [];
  const sfxCues: SfxCues = { ding: [], pop: [], sparkle: [], page: [] };
  let cursor = 0;

  for (const [i, s] of article.sections.entries()) {
    const audio = spoken[i]!.durationSec;
    const built = buildSection(s, i, spoken[i]!.lines, audio, cx);
    // 谁长听谁的（见模块注释：不缩放笔速）
    const contentEnd = Math.max(audio, built.localEnd);
    const isLast = i === article.sections.length - 1;
    const cell = cells[i] ?? { x: 0, y: 0, w: L.width, h: L.height };
    // 换场不再擦板：停一下 → 镜头平移到下一格 → 开画
    const panFrom = cursor + contentEnd + HOLD_BEFORE_WIPE;
    const dur = isLast
      ? contentEnd + FINAL_TAIL
      : contentEnd + HOLD_BEFORE_WIPE + PAN_SEC + AFTER_PAN;
    if (!isLast) panWindows.push([panFrom, panFrom + PAN_SEC]);
    // 连接箭头：在"停一下"和平移之间画出来，笔把视线引向下一格
    const next = cells[i + 1];
    if (!isLast && next !== undefined) {
      links.push(
        linkEl(
          cell,
          next,
          panFrom - HOLD_BEFORE_WIPE * 0.5,
          PAN_SEC * 0.8,
          `s${i}`,
          roles.muted,
        ),
      );
    }

    placed.push({
      index: i,
      cell,
      start: cursor,
      end: cursor + dur,
      // 先按时间平移，再按画布位置平移：两者互不影响，顺序无关
      // 竖向居中：内容从 marginTop 开始往下长，短的段（比如一朵云 + 一句话）
      // 会贴在格子顶部，格子下半部全空。收尾拉远时这些空白连成一片，整张画布
      // 读起来是"每块内容都挤在自己格子的上沿"。把剩余高度的一半补到上方，
      // 内容就落在格子的视觉中心。
      //
      // 只补一半而不是完全居中：标题仍应比几何中心略高（人读图先看上面），
      // 而且字幕压在画面下方 12% 处，内容太靠下会撞字幕。
      els: built.els
        .map((el) => shiftEl(el, cursor))
        .map((el) =>
          translateEl(
            el,
            cell.x,
            cell.y + Math.max(0, (contentBottom(L) - built.bottomY) * 0.42),
          ),
        ),
      wipe: null,
    });
    illustrations.push(...built.ils);

    // 音效点位：段内局部时间 → 全片时间
    for (const k of ["ding", "pop", "sparkle"] as const) {
      for (const at of built.cues[k]) sfxCues[k].push(cursor + at);
    }

    // 字幕：逐句（每句在段内有自己的偏移）
    for (const line of spoken[i]!.lines) {
      subtitles.push(...subtitleLines(line.narration, cursor + line.offset));
    }

    log(
      `  段 ${i} 起 ${cursor.toFixed(2)}s，配音 ${audio.toFixed(2)}s，` +
        `板面 ${built.localEnd.toFixed(2)}s → ${dur.toFixed(2)}s` +
        (built.localEnd > audio
          ? "（板面更长，段尾补静音）"
          : "（旁白更长，板面定格）") +
        (isLast ? "" : `，${panFrom.toFixed(2)}s 平移到下一格`),
    );
    cursor += dur;
  }

  const elements: GestureEl[] = [
    ...placed.flatMap((p) => [...p.els, ...(p.wipe === null ? [] : [p.wipe])]),
    // 连接箭头也进 elements：它是笔画出来的，手必须跟着它走，否则画面上会
    // 出现一条没有人画的线
    ...links,
  ];

  // 收尾：镜头拉远看整门课的全景，再停一会儿让观众扫一遍
  const zoomOutFrom = cursor;
  const camMoves = planCamera({
    cells,
    panWindows,
    zoomOutWindow: [zoomOutFrom, zoomOutFrom + ZOOM_OUT_SEC],
    aspect: L.width / L.height,
  });
  // 拉远看全景 = 讲完了、翻回去看整页，用翻页声标记
  sfxCues.page.push(zoomOutFrom);
  let totalSec = cursor + ZOOM_OUT_SEC + OVERVIEW_HOLD;

  // —— 收尾署名：全景到位之后，在画布右下角手写笔名 + 关注引导 ——
  //
  // 为什么放在拉远**之后**而不是最后一段里：签名是给整块画布签的，不是给某一段
  // 签的。镜头还在段里时写，它会变成那一段的内容；等全景到位再写，观众看到的是
  // "讲完了，作者在自己的板子上落款"。
  //
  // 位置取全景外接矩形的右下角内侧：那是唯一一块与任何段落内容都不重叠的地方
  // （蛇形铺格时最后一行右侧总有余量），而且是视线扫完全景的终点。
  if (article.signature && input.persona !== undefined) {
    const bounds = cellsBounds(cells);
    // 字号按**全景外接矩形的宽度**取，不按画幅字阶取：签名只在拉远之后出现，
    // 那时整块画布被缩到一屏（12 段的片子缩到约 0.18），画幅字阶的 64px 落到
    // 屏幕上只剩 12px——等于没签。以 bounds.w 为基准，签名在屏幕上恒定约 46px。
    const size = bounds.w * 0.018;
    // 落笔时刻放在**拉远过半**处，不是拉远之后：签名写完要 2 秒左右（手写字是
    // 按笔画揭示的），等拉远结束再落笔就写不完——实测被成片结尾截掉半句 CTA。
    // 镜头还在退、作者已在落款，观感也更像"讲完顺手一签"。
    const startAt = zoomOutFrom + ZOOM_OUT_SEC * 0.55;
    // 落款位置：最后一格的**内容之下**。一段内容只用到格子上部约七成（见
    // CELL_H_RATIO 与 contentBottom 的换算），格底那条留白是全景里唯一确定空着
    // 的地方——按 bounds 右下角算会压到最后一段的图（实测压在云朵便签上）。
    const last = cells.reduce(
      (best, c) =>
        c.y > best.y || (c.y === best.y && c.x > best.x) ? c : best,
      cells[0]!,
    );
    // 右对齐要按**实测字宽**算，不能按字号猜：CTA 是可配文案，"关注二木 · 聊大模型
    // 落地"比"二木"长四倍，按字号留位会把它推出画面右边缘（实测被裁掉半句）。
    const ctaSize = size * 0.42;
    const ctaText = input.persona.cta[0]!;
    const blockW = Math.max(
      textWidth(input.persona.signature, size, size * 0.08),
      textWidth(ctaText, ctaSize, ctaSize * 0.06),
    );
    const x = last.x + last.w - blockW - size * 0.8;
    const y = last.y + last.h - size * 1.1;
    const sign = markerTextEl(input.persona.signature, {
      x,
      y,
      size,
      gap: size * 0.08,
      t0: startAt,
      perChar: 0.16,
      color: accent,
      idp: "sig",
    });
    const cta = markerTextEl(ctaText, {
      x,
      y: y + size * 1.35,
      size: ctaSize,
      gap: ctaSize * 0.06,
      t0: sign.t1 + 0.12,
      perChar: 0.05,
      color: roles.muted,
      idp: "cta",
    });
    // 挂在 links 上而不是某一段的 els 上：links 是画布空间、**不参与按格剔除**的
    // 那一层，而签名写在全景视野里、不属于任何一格（挂进某格会在别处被剔掉）。
    links.push(sign, cta);
    sfxCues.sparkle.push(startAt);
    // 成片结尾以"签名写完"为下限：全景停留时长是给观众扫图的，不该顺带决定
    // 签名能不能写完。
    totalSec = Math.max(totalSec, cta.t1 + 0.5);
    log(
      `  署名 ${startAt.toFixed(2)}s 起手写「${input.persona.signature}」+ CTA`,
    );
  }
  log(
    `  收尾 ${zoomOutFrom.toFixed(2)}s 起拉远 ${ZOOM_OUT_SEC.toFixed(1)}s + ` +
      `停留 ${OVERVIEW_HOLD.toFixed(1)}s（${cells.length} 格全景）`,
  );

  return {
    placed,
    cells,
    camMoves,
    illustrations,
    subtitles,
    totalSec,
    sfxCues,
    elements,
    penElements: penElements(elements),
    links,
  };
}
