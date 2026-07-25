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

import type { TimelineEl } from "../whiteboard/index";
import type { Article, Section } from "./article";
import { checklist, markerTextEl, textWidth, titleBlock } from "./blocks";
import type { BlockCtx, TitleBlockOpts } from "./blocks";
import { matchIllustration } from "./assets-match";
import { flatIllustrationEl, importFlatSvg } from "./flat-import";
import type { FlatIllustration } from "./flat-import";
import type { FormatSpec } from "./format";
import {
  boardWipeEl,
  carryInEl,
  eraseEl,
  penElements,
  pointEl,
} from "./gestures";
import type { GestureEl, HandKit, WipeElement } from "./gestures";
import { ImageLoader, imageAspect } from "./images";
import { contentW, leftCol, rightCol } from "./layout";
import type { Layout } from "./layout";
import type { Log } from "./log";
import { silent } from "./log";
import type { SpokenLine } from "./narrate";
import { subtitleLines } from "./subtitle";
import type { SubtitleLine } from "./subtitle";

/** 板面画完到开始擦板之间的停顿（让最后一笔落定）. */
export const HOLD_BEFORE_WIPE = 0.4;
/** 整板擦净时长. */
export const WIPE_SEC = 1.4;
/** 擦完到下一段开画的间隔. */
export const AFTER_WIPE = 0.25;
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
  /** 所有扁平插画（`<defs>` 要在每帧顶部挂一遍）. */
  illustrations: FlatIllustration[];
  subtitles: SubtitleLine[];
  /** 全片时长（秒）. */
  totalSec: number;
  /** 全部元素（含擦板），供 `activeHandCue` 用. */
  elements: GestureEl[];
  /** 笔真的在板上的那些元素，供 `penPoseAt` / writing 音效用. */
  penElements: TimelineEl[];
}

export interface ComposeInput {
  article: Article;
  /** 与 `article.sections` 一一对应. */
  spoken: readonly SpokenSection[];
  format: FormatSpec;
  kit: HandKit;
  ink: string;
  accent: string;
  /** ManyPixels 插画库根目录. */
  illustrationsDir: string;
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
}

interface BuiltSection {
  els: GestureEl[];
  ils: FlatIllustration[];
  localEnd: number;
}

/**
 * 每一拍希望开始的时刻（相对本段起点）。
 *
 * 优先**贴到台词的句首**：一句新话开始的同时板上多出一件东西，读起来像
 * 有人在讲边写；均匀摊开则会出现"写到一半话题已经换了"。句子数少于拍数
 * 时退回均匀分布。
 */
export function beatTargets(
  lines: readonly SpokenLine[],
  count: number,
  audioSec: number,
): number[] {
  const usable = audioSec * BEAT_WINDOW;
  const even = Array.from({ length: count }, (_, i) => (i / count) * usable);
  if (lines.length < 2) return even;
  const cueStarts = lines.map((l) => l.offset).filter((o) => o < usable);
  if (cueStarts.length === 0) return even;
  return even.map((target) => {
    // 取离均匀目标最近的句首
    let best = cueStarts[0]!;
    for (const c of cueStarts) {
      if (Math.abs(c - target) < Math.abs(best - target)) best = c;
    }
    return best;
  });
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
    images: ImageLoader;
    illustrationsDir: string;
    log: Log;
  },
): BuiltSection {
  const { L, ctx, kit, ink, accent, images, log } = cx;
  const idp = `s${idx}`;
  const ils: FlatIllustration[] = [];
  const T = L.type;
  const twoCol = L.columns === 2;
  const textCol = twoCol ? leftCol(L) : { x: L.marginX, w: contentW(L) };
  const mediaCol = twoCol ? rightCol(L) : { x: L.marginX, w: contentW(L) };
  /** 版式在收集期就算好（不依赖时间），只把 t0 留到排时阶段. */
  const beats: Beat[] = [];

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
  let textY = titleGeom.bottomY + T.body * 0.9;
  let mediaY = twoCol ? titleGeom.bottomY + T.body * 0.9 : textY;

  // —— 擦：先写一个假设，再擦掉 ——
  if (s.scratch !== undefined) {
    const size = T.body;
    const y = textY;
    const w = textWidth(s.scratch, size, size * 0.06);
    const scratch = s.scratch;
    beats.push({
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
        const er = eraseEl({
          target: hypo,
          x: textCol.x - 22,
          y: y - 18,
          w: w + 44,
          h: size * 1.4,
          t0: hypo.t1 + 0.4,
          dur: 0.95,
          rows: 3,
          hand: kit.erase,
          idp: `${idp}E`,
        });
        return { els: [er], end: er.eraseT1 };
      },
    });
    // 擦过的地方不再堆内容：留白本身是"这条被否了"的一部分
    textY += size * 1.5;
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
    const availH =
      L.height - mediaY - L.marginBottom - L.height * (full ? 0.16 : 0.02);
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
        L.height - mediaY - L.marginBottom - (twoCol ? 0 : T.body * 6),
        twoCol ? 560 : 700,
      );
      const ilCx = twoCol ? mediaCol.x + mediaCol.w / 2 : L.width / 2;
      const ilCy = mediaY + size / 2;
      beats.push({
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
  let t = 0.25;
  for (const [i, beat] of beats.entries()) {
    t = Math.max(t, targets[i] ?? t);
    const r = beat.build(t);
    els.push(...r.els);
    t = r.end + BEAT;
  }

  return { els, ils, localEnd: t };
}

/** 分镜 + 配音 → 全片时间轴. */
export function composeStoryboard(input: ComposeInput): Storyboard {
  const { article, spoken, format, kit, ink, accent } = input;
  const log = input.log ?? silent;
  const L = format.layout;
  const ctx: BlockCtx = { ink, accent, beat: BEAT, layout: L };
  const images = new ImageLoader(log);
  const cx = {
    L,
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
  let cursor = 0;

  for (const [i, s] of article.sections.entries()) {
    const audio = spoken[i]!.durationSec;
    const built = buildSection(s, i, spoken[i]!.lines, audio, cx);
    // 谁长听谁的（见模块注释：不缩放笔速）
    const contentEnd = Math.max(audio, built.localEnd);
    const isLast = i === article.sections.length - 1;
    const wipeFrom = cursor + contentEnd + HOLD_BEFORE_WIPE;
    const dur = isLast
      ? contentEnd + FINAL_TAIL
      : contentEnd + HOLD_BEFORE_WIPE + WIPE_SEC + AFTER_WIPE;

    const wipe = isLast
      ? null
      : boardWipeEl({
          x: 0,
          y: 0,
          w: L.width,
          h: L.height,
          t0: wipeFrom,
          dur: WIPE_SEC,
          rows: 3,
          hand: kit.erase,
          idp: `w${i}`,
        });

    placed.push({
      index: i,
      start: cursor,
      end: cursor + dur,
      els: built.els.map((el) => shiftEl(el, cursor)),
      wipe,
    });
    illustrations.push(...built.ils);

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
        (isLast ? "" : `，${wipeFrom.toFixed(2)}s 擦板`),
    );
    cursor += dur;
  }

  const elements: GestureEl[] = placed.flatMap((p) => [
    ...p.els,
    ...(p.wipe === null ? [] : [p.wipe]),
  ]);

  return {
    placed,
    illustrations,
    subtitles,
    totalSec: cursor,
    elements,
    penElements: penElements(elements),
  };
}
