/**
 * PoC: 结构化版式组件
 *
 * 现状问题：`scene.ts` 的自动版式是「元素竖排流式」——每个元素各自
 * 孤立、中段留白大、对齐不成体系。参考图的专业感来自**成组的信息块**：
 * 标题+下划线、横向流程带（框+图标+标注+箭头）、左对齐打勾清单。
 *
 * 本模块把这些固定搭配做成组件（一次调用产出一组 TimelineEl），并统一
 * 走 12 栏网格与安全边距。
 *
 * 竖版取舍：流程带 ≤3 步横排单行（1080 宽放得下），>3 步转竖向流程链，
 * 不靠横向运镜看全貌——竖屏观众看不到画面外的东西。
 */

import type { Pt, TimelineEl } from "../whiteboard/index";
import {
  arrowHead,
  fmt,
  hanziTextEl,
  iconPaths,
  measureHanziText,
} from "../whiteboard/index";
import type { Layout } from "./layout";
import { PORTRAIT, contentW } from "./layout";
import { circleAroundPath, keyUnderlinePath } from "./emphasis";
import { parseInlineMarks } from "./inline-marks";
import { markerStrokesEl } from "./marker";
import { PALETTE, highlightOf } from "./palette";
import { highlightEl } from "./strokes";

/**
 * 默认画幅（竖屏）。组件实际用的是 `BlockCtx.layout`，这里只是兼容早期
 * 只有竖屏时写下的 demo 调用点。
 */
export const G = PORTRAIT;

export const CONTENT_W = contentW(PORTRAIT);

/**
 * 笔迹宽度档位（马克笔的粗细语言：标题粗、正文中、装饰细）。
 *
 * 整体较早先下调约 40%。原值（标题 13 / 下划线 11 / 框 8）在 1080 宽画幅上
 * 已经接近"粗记号笔"，而设计稿的线条是**细笔**：框线和下划线只比正文笔画
 * 略粗一点。线太粗的两个具体后果是：框和字之间的留白被吃掉，画面显得挤；
 * 以及下划线压过标题底部的笔画，标题末字读起来像被划掉。
 */
export const W = {
  title: 8,
  heading: 6,
  body: 4.5,
  icon: 4.5,
  frame: 5,
  arrow: 5,
  check: 5.5,
  // 标题下划线是一道手写的勾，不是色条：6.5 的粗蓝线在小标题下会比标题本身更抢眼
  underline: 3.6,
} as const;

/**
 * 手写字形的轮廓膨胀量（"马克笔加粗"）——**默认为 0，即不膨胀**。
 *
 * ## 为什么归零
 *
 * 这个技巧原本是为霞鹜文楷服务的：楷体笔画细，膨胀轮廓能让字看起来像马克笔
 * 写的。换成站酷快乐体（设计稿 §7 首选）之后它变成了纯粹的害处——**这支字体
 * 本身就是圆头粗笔画**，膨胀是在已经很粗的笔画上再加粗。
 *
 * 而膨胀是把 stroke 画在轮廓上，轮廓包括**字腔**（笔画之间的白），所以每个
 * 字腔两侧各被吃掉 `weight/2`。笔画密的字字腔本来只有几个像素：实测「事」
 * 在 size=104 下，`weight=1` 已开始糊，`weight≥2` 完全糊成一个黑团（当时的
 * 默认值算出来是 2.7）。这不是"偏粗"，是字认不出来了。
 *
 * 保留这个旋钮（`markerTextEl` 的 `weight`）而不是删掉，是因为将来若换回细笔画
 * 字体仍然需要它；但默认必须是 0——字重应当由字体提供，不由后处理伪造。
 *
 * 设计稿 §7 的三档（标题粗体 / 副标题中粗 / 正文常规）因此改由**字号**承载，
 * 见 `layout.ts` 的 {@link TypeScale}（title / subtitle / body / label 四阶）。
 */
const MARKER_WEIGHT_RATIO = 0;

export function markerWeight(size: number): number {
  return size * MARKER_WEIGHT_RATIO;
}

export interface TextOpts {
  x: number;
  y: number;
  size: number;
  gap: number;
  t0: number;
  perChar: number;
  color: string;
  idp: string;
  /** 字形轮廓膨胀（马克笔粗度）. Default: {@link markerWeight}(size). */
  weight?: number;
}

/**
 * 马克笔手写：复用 `hanziTextEl` 的真笔顺 + 手写字体字形，外层包一个
 * 继承 stroke 的 <g> 让字形轮廓膨胀 —— SVG 的 stroke 是可继承属性，
 * 而 hanzi 输出的字形 path 只设 fill，于是"免费"得到马克笔粗度；
 * mask 内部的 polyline 都显式带 stroke，不受影响。
 */
/**
 * 马克笔加粗会让字形向外膨胀 `weight/2`，相邻两字因此各吃掉一半间距。
 * 字间距必须把这份膨胀补回来，否则小字号下相邻字直接粘连（曾出现在
 * size=96/weight=7 的标题上）。
 */
function effectiveGap(gap: number, weight: number): number {
  return gap + weight * 0.9;
}

export function markerTextEl(text: string, o: TextOpts): TimelineEl {
  const weight = o.weight ?? markerWeight(o.size);
  const inner = hanziTextEl(text, {
    x: o.x,
    y: o.y,
    size: o.size,
    gap: effectiveGap(o.gap, weight),
    t0: o.t0,
    perChar: o.perChar,
    color: o.color,
    fontFamily: "sans-serif",
    idp: o.idp,
  });
  const open =
    `<g stroke="${o.color}" stroke-width="${fmt(weight)}" ` +
    `stroke-linejoin="round" stroke-linecap="round">`;
  return {
    t0: inner.t0,
    t1: inner.t1,
    svg(t) {
      const s = inner.svg(t);
      return s === "" ? "" : `${open}${s}</g>`;
    },
    pen: inner.pen?.bind(inner),
  };
}

/**
 * 手写行宽度（版式对齐用）。必须与 {@link markerTextEl} 的实际宽度一致，
 * 因此同样要算上马克笔加粗对字间距的补偿。
 */
export function textWidth(text: string, size: number, gap: number): number {
  const weight = markerWeight(size);
  return measureHanziText(text, size, effectiveGap(gap, weight)) + weight;
}

/** 字号自适应的下限（相对请求字号）——再小就该改文案而不是继续缩. */
const FIT_MIN_RATIO = 0.62;

/**
 * 把字号收到能放进 `maxW` 的最大值（放得下就原样返回）。
 *
 * 手写文本的宽度对字号几乎是线性的（CJK 全宽 + 间距/加粗都按字号比例），
 * 所以先按比例一步到位，再迭代两次修正混排里的拉丁字宽误差。
 *
 * 没有这一步的话，标题字数一多就直接画出画面外：`titleBlock` 早先按固定
 * 字号排版，8 个字 118px 需要 1043px，而竖屏内容区只有 896px，最后一个
 * 字被裁在屏幕外。
 */
export function fitSize(
  text: string,
  size: number,
  maxW: number,
  gapRatio = 0.06,
): number {
  if (maxW <= 0) return size;
  let s = size;
  for (let i = 0; i < 3; i++) {
    const w = textWidth(text, s, s * gapRatio);
    if (w <= maxW) break;
    s = Math.max(size * FIT_MIN_RATIO, s * (maxW / w));
    if (s <= size * FIT_MIN_RATIO) break;
  }
  return s;
}

// ---- 手绘几何件 ----

/**
 * 手绘方框（一笔画完）。
 *
 * 收笔处理：真人闭合矩形时会**拐过起点沿顶边多走一点**，而不是沿左边
 * 向上冲过头。后者在渲染里是一根竖直尖刺（曾出现在每个框的左上角），
 * 所以这里的收笔向右拐 —— 读起来是"角"，不是"刺"。
 * 调用方需配 `overshoot: false`，避免 geometry 再沿最后一段方向加一截。
 */
export function boxPath(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y + h * 0.004],
    [x + w * 0.055, y - h * 0.004],
  ];
}

/** 横向箭头（杆 + 两翼）. */
export function arrowPaths(
  x0: number,
  y: number,
  x1: number,
  size = 26,
): Pt[][] {
  const shaft: Pt[] = [
    [x0, y],
    [x1, y],
  ];
  return [shaft, arrowHead(shaft, size)];
}

/** 竖向箭头（流程链用）. */
export function arrowPathsDown(
  x: number,
  y0: number,
  y1: number,
  size = 26,
): Pt[][] {
  const shaft: Pt[] = [
    [x, y0],
    [x, y1],
  ];
  return [shaft, arrowHead(shaft, size)];
}

/** 手绘对勾（两段折线，第二段长于第一段）. */
export function checkPath(cx: number, cy: number, size: number): Pt[] {
  return [
    [cx - size * 0.42, cy + size * 0.02],
    [cx - size * 0.1, cy + size * 0.34],
    [cx + size * 0.46, cy - size * 0.36],
  ];
}

// ---- 组件 ----

export interface BlockCtx {
  ink: string;
  accent: string;
  /** 元素间的入场间隔（秒）. */
  beat: number;
  /** 画幅与版式规格. Default {@link PORTRAIT}. */
  layout?: Layout;
}

/** 取上下文的画幅（未指定则竖屏）. */
function lay(ctx: BlockCtx): Layout {
  return ctx.layout ?? PORTRAIT;
}

export interface TitleBlockOpts {
  /** 首字左上角. */
  x: number;
  y: number;
  size: number;
  t0: number;
  perChar: number;
  /** 下划线：0 无、1 单线、2 双线（参考图是双线）. */
  underline?: 0 | 1 | 2;
  /** 下划线是否用强调色. */
  underlineAccent?: boolean;
  /** 可用宽度上限（超出则自动缩字号）. Default: 从 x 到内容区右边界. */
  maxW?: number;
  idp: string;
}

/** 标题块：马克笔手写 + 下划线（强调件在字写完后补上，像真人回头划线）. */
export function titleBlock(
  text: string,
  o: TitleBlockOpts,
  ctx: BlockCtx,
): { els: TimelineEl[]; width: number; endT: number; bottomY: number } {
  const l = lay(ctx);
  const maxW = o.maxW ?? l.width - l.marginX - o.x;
  // 字数多时自动缩字号，避免画到画面外
  const size = fitSize(text, o.size, maxW);
  const gap = size * 0.06;
  const width = textWidth(text, size, gap);
  const title = markerTextEl(text, {
    x: o.x,
    y: o.y,
    size,
    gap,
    t0: o.t0,
    perChar: o.perChar,
    color: ctx.ink,
    idp: `${o.idp}t`,
  });
  const els: TimelineEl[] = [title];
  let endT = title.t1;
  let bottomY = o.y + size;

  const n = o.underline ?? 0;
  if (n > 0) {
    const color = o.underlineAccent === true ? ctx.accent : ctx.ink;
    const uy = o.y + size * 1.1;
    const t0 = title.t1 + ctx.beat * 0.5;
    // 只划到标题宽度的 ~78%：真人回头划线是随手一道，划满全宽会读作分隔条
    const lines: Pt[][] = [
      [
        [o.x - size * 0.03, uy],
        [o.x + width * 0.78, uy],
      ],
    ];
    if (n === 2) {
      const uy2 = uy + size * 0.185;
      lines.push([
        [o.x + size * 0.05, uy2],
        [o.x + width * 0.78, uy2],
      ]);
    }
    const ul = markerStrokesEl(lines, {
      t0,
      dur: 0.42 * n,
      color,
      width: W.underline,
      seed: `${o.idp}ul`,
      amp: 3.4,
    });
    els.push(ul);
    endT = ul.t1;
    bottomY = uy + (n === 2 ? size * 0.185 : 0) + W.underline;
  }
  return { els, width, endT, bottomY };
}

export interface FlowStep {
  /** 元素库线稿图标名. */
  icon: string;
  /** 框下方标注. */
  label: string;
}

export interface FlowBandOpts {
  /** 带的顶部 y. */
  y: number;
  /** 带的左边界. Default: 版式左边距. */
  x?: number;
  /** 带的可用宽度. Default: 内容区宽度（横屏可传单栏宽）. */
  w?: number;
  t0: number;
  /** 单步的描画时长（框 + 图标 + 标注）. */
  stepSec: number;
  idp: string;
  /** 强调色描画的步序（0-based；参考图里中间那步是重点）. */
  accentIndex?: number;
}

/**
 * 横向流程带：框 + 框内线稿图标 + 框下标注 + 步间箭头。
 * 仅支持 ≤3 步（竖版宽度约束）；更多步用 {@link flowChain}。
 */
export function flowBand(
  steps: readonly FlowStep[],
  o: FlowBandOpts,
  ctx: BlockCtx,
): { els: TimelineEl[]; endT: number; bottomY: number } {
  const l = lay(ctx);
  const bandX = o.x ?? l.marginX;
  const bandW = o.w ?? contentW(l);
  const n = steps.length;
  // 箭头留白尽量窄——宽度紧张时框大一点才撑得住画面
  const arrowW = n === 3 ? 66 : 110;
  const box = Math.min(
    l.orientation === "landscape" ? 230 : 260,
    (bandW - arrowW * (n - 1)) / n,
  );
  const gapX = n > 1 ? (bandW - box * n) / (n - 1) : 0;
  const labelSize = l.type.label;
  const labelY = o.y + box + 40;

  const els: TimelineEl[] = [];
  let t = o.t0;
  for (const [i, step] of steps.entries()) {
    const x = bandX + i * (box + gapX);
    const color = i === o.accentIndex ? ctx.accent : ctx.ink;
    // 框（一笔）
    els.push(
      markerStrokesEl([boxPath(x, o.y, box, box)], {
        t0: t,
        dur: o.stepSec * 0.42,
        color,
        width: W.frame,
        seed: `${o.idp}bx${i}`,
        amp: 3.2,
        overshoot: false,
      }),
    );
    t += o.stepSec * 0.42 + ctx.beat * 0.35;
    // 框内图标
    els.push(
      markerStrokesEl(
        iconPaths(step.icon, x + box / 2, o.y + box / 2, box * 0.56),
        {
          t0: t,
          dur: o.stepSec * 0.46,
          color,
          width: W.icon,
          seed: `${o.idp}ic${i}`,
          amp: 2.2,
        },
      ),
    );
    t += o.stepSec * 0.46 + ctx.beat * 0.35;
    // 标注（框下居中）
    const lgap = labelSize * 0.06;
    const lw = textWidth(step.label, labelSize, lgap);
    const label = markerTextEl(step.label, {
      x: x + (box - lw) / 2,
      y: labelY,
      size: labelSize,
      gap: lgap,
      t0: t,
      perChar: 0.2,
      color: ctx.ink,
      idp: `${o.idp}lb${i}`,
    });
    els.push(label);
    // 同 checklist：按元素实际 t1 推进，字间停顿不能漏算
    t = label.t1 + ctx.beat * 0.4;
    // 箭头（指向下一步）
    if (i < n - 1) {
      const ax0 = x + box + gapX * 0.22;
      const ax1 = x + box + gapX * 0.78;
      els.push(
        markerStrokesEl(arrowPaths(ax0, o.y + box / 2, ax1), {
          t0: t,
          dur: 0.34,
          color: ctx.ink,
          width: W.arrow,
          seed: `${o.idp}ar${i}`,
          amp: 1.6,
        }),
      );
      t += 0.34 + ctx.beat * 0.3;
    }
  }
  return { els, endT: t, bottomY: labelY + labelSize * 1.1 };
}

export interface ChecklistOpts {
  x: number;
  y: number;
  size: number;
  /** 行距（含字高）. */
  lineHeight: number;
  t0: number;
  perChar: number;
  idp: string;
  /** 勾用强调色. */
  checkAccent?: boolean;
}

/** 打勾清单：每行「手绘勾 + 手写文字」，勾先落再写字（真人的顺序）. */
export function checklist(
  items: readonly string[],
  o: ChecklistOpts,
  ctx: BlockCtx,
): { els: TimelineEl[]; endT: number; bottomY: number } {
  const els: TimelineEl[] = [];
  const checkSize = o.size * 0.92;
  const textX = o.x + checkSize * 1.5;
  let t = o.t0;
  for (const [i, item] of items.entries()) {
    const { text: plain, marks } = parseInlineMarks(item);
    const cy = o.y + i * o.lineHeight + o.size * 0.5;
    els.push(
      markerStrokesEl([checkPath(o.x + checkSize * 0.5, cy, checkSize)], {
        t0: t,
        dur: 0.3,
        color: o.checkAccent === true ? ctx.accent : ctx.ink,
        width: W.check,
        seed: `${o.idp}ck${i}`,
        amp: 2.0,
      }),
    );
    t += 0.3 + ctx.beat * 0.25;
    const line = markerTextEl(plain, {
      x: textX,
      y: o.y + i * o.lineHeight,
      size: o.size,
      gap: o.size * 0.06,
      t0: t,
      perChar: o.perChar,
      color: ctx.ink,
      idp: `${o.idp}it${i}`,
    });
    els.push(line);
    // 必须按元素**实际**结束时间推进，不能按 字数×perChar 估。
    // hanziTextEl 在字与字之间还插了 CHAR_GAP_SEC(0.12s) 的换笔停顿，
    // 六个字就差 0.6s —— 按估值推进会让下一行提前 0.6s 开画，两个笔描
    // 元素同时活跃，笔留在上一行，下一行的字却已经出现（"文字先出现、
    // 笔还没移动"）。
    t = line.t1 + ctx.beat * 0.5;
    // 行内强调：整行写完**之后**再补。
    //
    // 顺序是有意的：真人是先写完一句，再回头涂color/划线/圈起来。边写边涂做不到
    // ——涂抹的宽度取决于这段字最终有多宽，而那要等字写完才知道。
    for (const [k, mark] of marks.entries()) {
      const gap = o.size * 0.06;
      const mx =
        textX + textWidth(plain.slice(0, mark.from), o.size, gap) + gap / 2;
      const mw = textWidth(plain.slice(mark.from, mark.to), o.size, gap);
      const my = o.y + i * o.lineHeight;
      const seed = `${o.idp}mk${i}_${k}`;
      if (mark.kind === "highlight") {
        els.push(
          highlightEl(
            mx - o.size * 0.08,
            my + o.size * 0.1,
            mw + o.size * 0.16,
            {
              t0: t,
              dur: 0.34,
              // 荧光笔用**黄色**（HIGHLIGHTS 的第 3 个）而不是第 1 个蓝：
              // 设计稿 §4/§13 的高亮都是黄的，而蓝色涂抹压在黑字上偏冷、
              // 又和标题下划线的蓝撞车，读起来像"这行被选中了"而不是"重点"。
              color: highlightOf(2),
              height: o.size * 1.02,
              seed,
            },
          ),
        );
        t += 0.34 + ctx.beat * 0.3;
      } else if (mark.kind === "key") {
        const el = markerStrokesEl([keyUnderlinePath(mx, my, mw, o.size)], {
          t0: t,
          dur: 0.3,
          color: ctx.accent,
          width: W.body,
          seed,
          amp: 2.0,
        });
        els.push(el);
        t = el.t1 + ctx.beat * 0.3;
      } else {
        const el = markerStrokesEl(
          [circleAroundPath(mx, my, mw, o.size * 1.1)],
          {
            t0: t,
            dur: 0.52,
            color: PALETTE.danger,
            width: W.body,
            seed,
            amp: 2.4,
          },
        );
        els.push(el);
        t = el.t1 + ctx.beat * 0.3;
      }
    }
  }
  return {
    els,
    endT: t,
    bottomY: o.y + (items.length - 1) * o.lineHeight + o.size * 1.1,
  };
}
