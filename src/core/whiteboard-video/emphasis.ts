/**
 * @module core/whiteboard-video/emphasis
 *
 * 设计稿 2.0 §13「状态 & 强调」+ §12「装饰元素」。
 *
 * ## 状态徽章为什么靠形状而不只靠颜色
 *
 * 五个状态（重要/提示/注意/成功/错误）在设计稿里既有颜色也有形状：注意是
 * **三角形**里的感叹号，成功是**圆形**里的对勾，错误是圆里的叉。形状冗余是
 * 刻意的——投屏偏色、手机自动色温、以及色觉障碍观众，都会让"红 vs 绿"失效，
 * 而三角和圆的区别永远在。所以本模块的每个状态都自带形状，不允许只换颜色。
 *
 * ## 装饰件为什么要能"不占版式"
 *
 * §12 的东西（放射线、阴影底纹、角落装饰）都是垫在内容周围的，它们不该参与
 * 版式计算——否则加一条装饰线就要重排整段。所以这些函数只接收"要装饰谁"的
 * 矩形，自己往外长，不返回任何尺寸信息。
 */

import type { Pt } from "../whiteboard/index";
import { ellipsePts, fmt } from "../whiteboard/index";
import { arrowHead } from "../whiteboard/index";
import { PALETTE } from "./palette";
import type { InkRole } from "./palette";
import { polygonPath } from "./shapes";

/** 设计稿 2.0 §13 的五种状态. */
export const STATUS_KINDS = [
  "important",
  "info",
  "caution",
  "success",
  "error",
] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

export function isStatusKind(v: string): v is StatusKind {
  return (STATUS_KINDS as readonly string[]).includes(v);
}

/** 每种状态的语义色角色（与 §3 八色板对齐）. */
export const STATUS_ROLE: Readonly<Record<StatusKind, InkRole>> = {
  important: "danger",
  info: "primary",
  caution: "warn",
  success: "success",
  error: "danger",
};

/** 状态徽章的颜色. */
export function statusColor(kind: StatusKind): string {
  return PALETTE[STATUS_ROLE[kind]];
}

/**
 * 状态徽章（§13）：外框（圆或三角）+ 内部符号。
 *
 * 返回折线组，按描画顺序：先外框、后符号。感叹号的点单独一笔（一段极短的线，
 * 靠笔迹带的圆端帽渲成圆点）——把点和竖线连成一笔会得到一根长竖线，读不出
 * 感叹号。
 */
export function statusBadgePaths(
  kind: StatusKind,
  cx: number,
  cy: number,
  r: number,
): Pt[][] {
  const paths: Pt[][] = [];
  if (kind === "caution") {
    // 三角形警告：顶点朝上，内部感叹号略微下移（三角形上方窄）
    paths.push(polygonPath(cx, cy + r * 0.08, r * 1.12, r * 1.12, 3));
    paths.push([
      [cx, cy - r * 0.28],
      [cx, cy + r * 0.3],
    ]);
    paths.push([
      [cx, cy + r * 0.56],
      [cx, cy + r * 0.58],
    ]);
    return paths;
  }
  paths.push(ellipsePts(cx, cy, r, r, -95, 372, 44));
  switch (kind) {
    case "important":
      paths.push([
        [cx, cy - r * 0.48],
        [cx, cy + r * 0.16],
      ]);
      paths.push([
        [cx, cy + r * 0.44],
        [cx, cy + r * 0.46],
      ]);
      break;
    case "info":
      // 小写 i：点在上、竖在下
      paths.push([
        [cx, cy - r * 0.46],
        [cx, cy - r * 0.44],
      ]);
      paths.push([
        [cx, cy - r * 0.18],
        [cx, cy + r * 0.48],
      ]);
      break;
    case "success":
      paths.push([
        [cx - r * 0.42, cy + r * 0.02],
        [cx - r * 0.1, cy + r * 0.36],
        [cx + r * 0.46, cy - r * 0.34],
      ]);
      break;
    case "error":
      paths.push([
        [cx - r * 0.34, cy - r * 0.34],
        [cx + r * 0.34, cy + r * 0.34],
      ]);
      paths.push([
        [cx + r * 0.34, cy - r * 0.34],
        [cx - r * 0.34, cy + r * 0.34],
      ]);
      break;
  }
  return paths;
}

// ---- §13 强调标记 ----

/**
 * 手绘圈图（§13「手绘圈图」）：把一个词圈起来。
 *
 * 用**椭圆**而不是圆：被圈的对象几乎总是一段横向的文字，圆会把上下留出大片
 * 空白、左右又圈不住。多绕出 20° 是真人画圈的收笔（越过起点一点）。
 */
export function circleAroundPath(
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 0.14,
): Pt[] {
  const rx = (w / 2) * (1 + pad);
  const ry = (h / 2) * (1 + pad * 2.2);
  return ellipsePts(x + w / 2, y + h / 2, rx, ry, -100, 380, 56);
}

/**
 * 箭头指引（§13「箭头指引」）：从注解指向目标的短箭头。
 *
 * 刻意做成**直**箭头：曲线箭头（§5）是"流程走向"，指引箭头是"看这里"，
 * 一直一弯把两种语义分开。
 */
export function pointerArrowPaths(from: Pt, to: Pt, headSize = 18): Pt[][] {
  const shaft: Pt[] = [from, to];
  return [shaft, arrowHead(shaft, headSize)];
}

/**
 * 重点文字下划线（§13「重点文字」）：贴在文字基线下的一条短横。
 *
 * 与标题下划线的区别是**紧贴且略短**（收在文字两端各 2% 以内）：标题下划线是
 * 装饰，重点下划线是"这几个字"，划过头会把相邻的字也圈进去。
 */
export function keyUnderlinePath(
  x: number,
  y: number,
  w: number,
  size: number,
): Pt[] {
  const uy = y + size * 1.04;
  return [
    [x + w * 0.02, uy],
    [x + w * 0.98, uy],
  ];
}

/** 高亮背景（§13「高亮背景」）：垫在文字后的实心块（走淡入，不走笔描）. */
export function highlightBoxSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  role: InkRole = "warn",
  opacity = 0.32,
): string {
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${PALETTE[role]}" opacity="${fmt(opacity)}"/>`;
}

// ---- §12 装饰元素 ----

/**
 * 放射线（§12「放射线」）：从一点向外的短线束，用于"这里很重要/亮了"。
 *
 * 线**不等长**（长短交替）：等长的放射线读成太阳图标，长短交错才读成"闪耀"
 * 的装饰。也刻意不封口——放射线不是一个图形，是一组笔画。
 */
export function radiatingPaths(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  count = 8,
  rotDeg = 0,
): Pt[][] {
  const paths: Pt[][] = [];
  for (let i = 0; i < count; i++) {
    const a = ((rotDeg + (360 * i) / count) * Math.PI) / 180;
    const k = i % 2 === 0 ? 1 : 0.66;
    paths.push([
      [cx + rInner * Math.cos(a), cy + rInner * Math.sin(a)],
      [cx + rOuter * k * Math.cos(a), cy + rOuter * k * Math.sin(a)],
    ]);
  }
  return paths;
}

/**
 * 角落装饰（§12「角落装饰」）：一个 L 形的角标，成对放在对角。
 *
 * `corner` 决定朝向。只画两条边——四个角都画满就变成一个框（那是「高亮框」），
 * 角落装饰的意思是"这块区域"，留开口才不抢内容的注意力。
 */
export function cornerDecorPath(
  x: number,
  y: number,
  size: number,
  corner: "tl" | "tr" | "bl" | "br",
): Pt[] {
  const sx = corner === "tl" || corner === "bl" ? 1 : -1;
  const sy = corner === "tl" || corner === "tr" ? 1 : -1;
  return [
    [x + sx * size, y],
    [x, y],
    [x, y + sy * size],
  ];
}

/**
 * 分隔线（§12「分隔线」）：中间带一个小菱形的横线。
 *
 * 纯横线在白板上会和"下划线""表格线"混淆；中间那个小记号让它明确是**分段**。
 */
export function dividerPaths(x: number, y: number, w: number): Pt[][] {
  const g = Math.min(w * 0.06, 26);
  const d = g * 0.34;
  return [
    [
      [x, y],
      [x + w / 2 - g, y],
    ],
    [
      [x + w / 2 + g, y],
      [x + w, y],
    ],
    [
      [x + w / 2, y - d],
      [x + w / 2 + d, y],
      [x + w / 2, y + d],
      [x + w / 2 - d, y],
      [x + w / 2, y - d],
    ],
  ];
}

/**
 * 阴影底纹（§12「阴影底纹」）：斜线填充的一块区域（走淡入，不走笔描）。
 *
 * 用 pattern 而不是逐条画线：底纹动辄几十条线，逐条描画会占掉整段的时间预算，
 * 而它只是背景。`id` 必须由调用方给且全文档唯一——同一帧里可能有多块底纹。
 */
export function hatchDefs(id: string, role: InkRole = "muted"): string {
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="12" height="12">` +
    `<path d="M0 12 L12 0" fill="none" stroke="${PALETTE[role]}" stroke-width="1.6" opacity="0.5"/></pattern>`
  );
}

/** 阴影底纹的填充块（需先挂 {@link hatchDefs}）. */
export function hatchSvg(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="url(#${id})"/>`;
}

/** 全部装饰件名（供脚本层校验）. */
export const DECOR_NAMES = [
  "radiating",
  "corner",
  "divider",
  "hatch",
  "highlight-box",
  "circle-around",
] as const;

export type DecorName = (typeof DECOR_NAMES)[number];

export function isDecorName(v: string): v is DecorName {
  return (DECOR_NAMES as readonly string[]).includes(v);
}
