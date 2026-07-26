/**
 * @module core/whiteboard-video/cover
 *
 * 片头封面：主标题 + 副标 + 一个图形块 + 金句 + 署名，渲成一张静帧。
 *
 * ## 为什么封面要生成，而不是从成片抽帧
 *
 * 抽帧有两个躲不开的毛病：字幕是烧进画面的（抽到的帧十有八九带半句台词），
 * 手拿笔的光标会遮住内容。更要紧的是封面承担的信息不一样——它要在信息流的
 * 小窗里三秒说清"这条片子在讲什么"，那需要**结论式的构图**，而不是某一段
 * 讲到一半的状态。
 *
 * ## 为什么主视觉复用板书块
 *
 * 封面不引入新画法，主视觉直接拿文章里某一段的图形块（`> cover: <段号>`，
 * 默认取第一个有块的段）。这样封面和成片是同一套笔触、配色、字形；观众点进来
 * 不会觉得走错了片子。代价是封面构图受块类型限制——这是有意的取舍：一套能自由
 * 排版的封面模板会立刻长成第二套视觉规范，然后两套开始互相漂移。
 *
 * 时间轴上取 `t = COVER_T`（远大于任何一拍的结束时间）拿"画完"的静态形态：
 * 元素本身是带笔迹动画的，封面只要终态。
 */

import { boardBeats } from "./board-block";
import type { BoardSpec } from "./board-block";
import { markerTextEl, textWidth } from "./blocks";
import {
  BOARD_DESIGN,
  backgroundDefs,
  boardCornersSvg,
  boardStyleFor,
} from "./board";
import type { BoardBackground } from "./board";
import { isDarkBackground } from "./board";
import { PALETTE, rolesFor } from "./palette";
import type { Persona } from "../persona/index";
import { highlightEl } from "./strokes";
import { markerStrokesEl } from "./marker";
import type { TimelineEl } from "../whiteboard/types";

/** 取"画完"那一刻：所有笔迹动画都已结束. */
const COVER_T = 1e6;

export interface CoverInput {
  title: string;
  subtitle?: string;
  tagline?: string;
  /** 主视觉：某一段的图形块；没有就只排文字. */
  block?: BoardSpec;
  /** 署名与关注引导（缺人设则不署名，同片内签名的语义）. */
  persona?: Persona;
  width: number;
  height: number;
  background: BoardBackground;
}

/** 一行字的宽度（字距与正文同一比例）. */
function tw(s: string, size: number): number {
  return textWidth(s, size, size * 0.06);
}

/**
 * 标题字号：先按画幅定基准，再按实际字宽收，保证一行放得下。
 *
 * 不换行是刻意的——封面标题折成两行，在信息流小窗里第二行会被裁掉，
 * 而作者看到的预览是完整的，这种不一致比字小更糟。
 */
export function fitTitleSize(
  title: string,
  width: number,
  base: number,
): number {
  const max = width * 0.82;
  let size = base;
  while (size > base * 0.45 && tw(title, size) > max) size -= 2;
  return size;
}

/** 封面 SVG（纯函数：同一输入渲出同一张图）. */
export function coverSvg(input: CoverInput): string {
  const { width: W, height: H } = input;
  const vertical = H > W;
  const style = boardStyleFor(input.background, BOARD_DESIGN);
  // 封面跟成片同一套主题：深板要浅墨，否则封面上的字直接消失
  const dark = isDarkBackground(input.background);
  const P = rolesFor(dark);
  const out: string[] = [];
  const push = (s: string): void => {
    out.push(s);
  };
  const el = (e: TimelineEl): void => {
    push(e.svg(COVER_T));
  };
  const text = (
    s: string,
    x: number,
    y: number,
    size: number,
    color = P.ink,
  ): void => {
    el(
      markerTextEl(s, {
        x,
        y,
        size,
        gap: size * 0.06,
        t0: 0,
        perChar: 0.001,
        color,
        idp: `cv${out.length}`,
      }),
    );
  };
  const center = (s: string, y: number, size: number, color = P.ink): void => {
    text(s, (W - tw(s, size)) / 2, y, size, color);
  };

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  );
  const defs = backgroundDefs(input.background, "coverBg");
  push(`<defs>${defs}</defs>`);
  push(`<rect width="${W}" height="${H}" fill="${style.surface}"/>`);
  if (defs !== "")
    push(`<rect width="${W}" height="${H}" fill="url(#coverBg)"/>`);
  const m = Math.round(W * 0.01);
  push(
    `<rect x="${m}" y="${m}" width="${W - m * 2}" height="${H - m * 2}" fill="none" stroke="${style.frame}" stroke-width="4" rx="4"/>`,
  );
  push(boardCornersSvg(m, m, W - m * 2, H - m * 2, style, vertical ? 1 : 1.1));

  // ---- 标题 + 下划线 ----
  const titleSize = fitTitleSize(
    input.title,
    W,
    vertical ? W * 0.085 : W * 0.06,
  );
  const titleTop = H * (vertical ? 0.1 : 0.07);
  center(input.title, titleTop, titleSize);
  const halfW = tw(input.title, titleSize) / 2;
  const ruleY = titleTop + titleSize * 1.24;
  el(
    markerStrokesEl(
      [
        [
          [W / 2 - halfW, ruleY],
          [W / 2 + halfW, ruleY],
        ],
      ],
      {
        t0: 0,
        dur: 1,
        color: P.primary,
        width: Math.max(6, W * 0.005),
        seed: "cvRule",
        amp: 2.2,
        overshoot: false,
      },
    ),
  );

  let y = ruleY + titleSize * 0.3;
  if (input.subtitle !== undefined) {
    const size = titleSize * 0.36;
    center(input.subtitle, y, size, P.muted);
    y += size * 1.7;
  }

  // ---- 主视觉：复用板书块 ----
  const taglineSize = titleSize * 0.5;
  const bottomReserve = H * (input.tagline === undefined ? 0.12 : 0.2);
  const boxTop = y + H * 0.03;
  const boxH = H - bottomReserve - boxTop;
  if (input.block !== undefined && boxH > H * 0.2) {
    const boxW = W * 0.84;
    const ctx = {
      ink: P.ink,
      bodySize: titleSize * 0.46,
      idp: "cvb",
    };
    const box = { x: (W - boxW) / 2, y: boxTop, w: boxW, h: boxH };
    // 两趟排版：块用不满给定高度（表格按行高、流程按节点数），第一趟量出
    // 真实底边，第二趟按实际高度垂直居中。只量不画的话封面会把图贴在顶部、
    // 底下空一大片——那看起来像渲染没画完。
    const probe = boardBeats(input.block, box, ctx);
    const usedH = Math.max(0, probe.bottomY - boxTop);
    const dy = usedH > 0 && usedH < boxH ? (boxH - usedH) / 2 : 0;
    const { beats } = boardBeats(input.block, { ...box, y: boxTop + dy }, ctx);
    let t = 0;
    for (const beat of beats) {
      const built = beat.build(t);
      for (const e of built.els) el(e);
      t = built.end;
    }
  }

  // ---- 金句 ----
  //
  // 亮板上用荧光笔压住（黄块 + 深字，最像真的马克笔）；深板上改成**亮黄字**、
  // 不画块：半透明黄压在深底上是一块暗褐，浅色字盖上去比不强调还难读。
  if (input.tagline !== undefined) {
    const w = tw(input.tagline, taglineSize);
    const ty = H - bottomReserve + H * 0.02;
    if (dark) {
      center(input.tagline, ty, taglineSize, P.warn);
    } else {
      el(
        highlightEl(
          W / 2 - w / 2 - taglineSize * 0.3,
          ty + taglineSize * 0.04,
          w + taglineSize * 0.6,
          {
            t0: 0,
            dur: 1,
            color: P.warn,
            height: taglineSize * 1.24,
            seed: "cvHl",
          },
        ),
      );
      center(input.tagline, ty, taglineSize);
    }
  }

  // ---- 署名 ----
  if (input.persona !== undefined) {
    const cta = input.persona.cta[0] ?? "";
    const ctaSize = titleSize * 0.26;
    const nameSize = titleSize * 0.46;
    const right = W - m - W * 0.02;
    const blockW = Math.max(
      tw(cta, ctaSize),
      tw(input.persona.signature, nameSize),
    );
    const x = right - blockW;
    text(
      input.persona.signature,
      x,
      H - m - nameSize * 2.5,
      nameSize,
      P.primary,
    );
    if (cta !== "") text(cta, x, H - m - ctaSize * 2, ctaSize, P.muted);
  }

  push("</svg>");
  return out.join("\n");
}

/**
 * 封面主视觉取哪一段的块。
 *
 * `auto` 挑第一个有块的段——第一段通常是钩子（一句便签或一张对比表），正好是
 * 封面想要的东西。指定段号则严格取那一段：作者知道哪张图最能代表全片，指定了
 * 就不该被"自动"改掉；那一段没有块时返回 undefined（封面退化成纯文字，
 * 不报错——封面是附加物，不该拦住成片）。
 */
export function pickCoverBlock(
  sections: ReadonlyArray<{ board?: BoardSpec }>,
  pick: { kind: "off" } | { kind: "auto" } | { kind: "section"; index: number },
): BoardSpec | undefined {
  if (pick.kind === "off") return undefined;
  if (pick.kind === "section") return sections[pick.index - 1]?.board;
  return sections.find((s) => s.board !== undefined)?.board;
}
