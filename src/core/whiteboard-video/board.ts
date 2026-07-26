/**
 * PoC: 白板底面
 *
 * 现状问题：`frames.ts` 的纸面是「暖白 rect + 点阵 pattern」——观感是
 * 笔记本纸，不是白板。参考图的白板感来自四件事：冷白板面、日光灯斜向
 * 反光、边缘压暗、铝合金外框。
 *
 * 分层设计（关键取舍）：
 * - **板面**在画布层（随运镜移动）——它是"被写的那块面"；
 * - **反光 / 暗角 / 铝框**在屏幕固定层（不随运镜移动）——真实拍摄是
 *   机位固定、灯不动，只有内容在画。若让光斑跟着画布走，运镜时会看到
 *   光斑滑动，立刻假。
 *
 * 全部用渐变实现，不用滤镜、不用位图：resvg 滤镜支持有限，位图会击穿
 * `frames.ts` 的"无字体快路径"性能预算（0.03s/帧）。
 */

import { fmt } from "../whiteboard/index";

/** 屏幕参考宽度：屏幕固定层的厚度按 viewW/此值缩放，保证运镜缩放时视觉厚度不变. */
const SCREEN_W = 1080;

export interface BoardStyle {
  /** 板面主色（冷白；纯白刺眼且显脏）. */
  surface: string;
  /** 板面边缘的极轻冷灰（营造大平面的光衰减）. */
  surfaceEdge: string;
  /** 铝框主色. */
  frame: string;
  /** 铝框高光. */
  frameLight: string;
  /** 铝框暗部. */
  frameDark: string;
  /** 侧边/顶部框厚度（屏幕像素）. */
  frameSide: number;
  frameTop: number;
  /** 底部笔槽高度（0 = 无笔槽；竖版建议 0，笔槽吃字幕安全区）. */
  trayHeight: number;
  /** 日光灯反光强度 0..1. */
  glare: number;
  /** 边缘压暗强度 0..1. */
  vignette: number;
  /** 四角包角件（设计稿 §1 的深灰圆角角件）；0 = 不画. */
  cornerSize?: number;
}

/**
 * 带铝框的白板。
 *
 * 板面基色刻意压到冷灰白（而非接近纯白）：白板的"亮"来自高光，板面
 * 本身在照片里是灰白的。若板面已是 #fafcfd，白色反光就没有对比余量，
 * 加多少 glare 都看不见——这是前一版反光"等于没画"的根因。
 */
export const BOARD: BoardStyle = {
  surface: "#f2f6f8",
  surfaceEdge: "#e4eaee",
  frame: "#9ba3aa",
  frameLight: "#dee4e8",
  frameDark: "#5d646b",
  frameSide: 13,
  frameTop: 18,
  trayHeight: 0,
  glare: 1,
  // 压暗只做"边缘收口"，过强会变成渐变背景而不是白板
  vignette: 0.32,
};

/**
 * 无框变体：机位怼在板面中段，看不到边框。
 * 竖屏里一圈灰边容易被读成"视频有黑边"，而反光+压暗已经足够传达"这是
 * 一块白板"。
 */
export const BOARD_FRAMELESS: BoardStyle = {
  ...BOARD,
  frameSide: 0,
  frameTop: 0,
  vignette: 0.42,
};

/**
 * VideoScribe 风格画布。
 *
 * 参考站的画布是**干净的近白纸面**：没有铝框、没有日光灯反光、几乎没有
 * 暗角——所有注意力给内容。前面那套"真实白板"的光学层（反光/压暗/金属
 * 框）反而会削弱它，所以这里全部关掉，只留极轻的边缘收口避免死平。
 */
export const BOARD_PAPER: BoardStyle = {
  surface: "#ffffff",
  surfaceEdge: "#f4f6f7",
  frame: "#d8dde1",
  frameLight: "#eef1f3",
  frameDark: "#c2c9ce",
  frameSide: 0,
  frameTop: 0,
  trayHeight: 0,
  glare: 0,
  vignette: 0.14,
};

// ---- 设计稿 §2：白板背景样式（可选） ----

/**
 * 设计稿 §2 的六种背景。
 *
 * `plain` 之外的五种都是**纸张**语义（网格/横线/米白/纸纹/点阵），它们的作用
 * 是给大片空白一点结构，让画面在内容还没写满时不至于死平。
 *
 * 实现上一律用 SVG `<pattern>`，不用位图：
 * - 位图要走 resvg 的图片解码，会击穿每帧预算（见 render.ts 的两条约束）；
 * - pattern 是矢量，运镜缩放时纹理跟着板面一起缩，符合"纹理长在板上"。
 *
 * 纹理**必须极淡**（线 opacity ≤ 0.1）。这不是保守：格线一旦看得清，观众
 * 会把它当成内容的一部分去对齐，而手写笔迹是抖的，永远对不齐格子——于是
 * 画面立刻显得"没做好"。纹理的正确强度是"注意不到，但拿掉会觉得空"。
 */
export type BoardBackground =
  "plain" | "grid" | "lined" | "cream" | "texture" | "dots";

export const BOARD_BACKGROUNDS: readonly BoardBackground[] = [
  "plain",
  "grid",
  "lined",
  "cream",
  "texture",
  "dots",
];

export function isBoardBackground(v: string): v is BoardBackground {
  return (BOARD_BACKGROUNDS as readonly string[]).includes(v);
}

/** 各背景的底色（`cream` 是米白纸，其余沿用板面色）. */
export function backgroundSurface(bg: BoardBackground): {
  surface: string;
  surfaceEdge: string;
} {
  if (bg === "cream") return { surface: "#FAF6EC", surfaceEdge: "#F2EBDA" };
  return { surface: "#FFFFFF", surfaceEdge: "#F4F6F7" };
}

/** 纹理线色：冷灰蓝，比纯灰更像真实纸张的印刷格线. */
const GRID_LINE = "#8FA3B8";

/** 网格/点阵的格距（px，1080 宽下约 20 格）. */
const GRID_STEP = 54;
/** 横线纸的行距（贴近手写行高）. */
const RULE_STEP = 76;

/**
 * 背景纹理的 `<pattern>` defs（无纹理时返回空串）。
 *
 * `patternUnits="userSpaceOnUse"` 是必须的：默认的 `objectBoundingBox` 会
 * 让格距随被填充矩形的尺寸变化，而背景矩形铺的是"当前视口 ×2"（随运镜变），
 * 于是格子会在运镜时忽大忽小。
 *
 * `id` 可覆盖：设计稿对照表要在同一张 SVG 里同时展示六种背景，固定 id 会
 * 让后面的 pattern 覆盖前面的。
 */
export function backgroundDefs(bg: BoardBackground, id = "pocBg"): string {
  const p = (inner: string, step: number): string =>
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${step}" height="${step}">${inner}</pattern>`;
  switch (bg) {
    case "grid":
      return p(
        `<path d="M ${GRID_STEP} 0 L 0 0 0 ${GRID_STEP}" fill="none" stroke="${GRID_LINE}" stroke-width="1.4" opacity="0.16"/>`,
        GRID_STEP,
      );
    case "lined":
      // 只有横线（横线纸没有竖线），行距比网格大
      return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${RULE_STEP}" height="${RULE_STEP}"><path d="M 0 ${RULE_STEP} L ${RULE_STEP} ${RULE_STEP}" fill="none" stroke="${GRID_LINE}" stroke-width="1.6" opacity="0.18"/></pattern>`;
    case "dots":
      return p(
        `<circle cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="2.1" fill="${GRID_LINE}" opacity="0.26"/>`,
        GRID_STEP,
      );
    case "texture": {
      // 纸纹：两组不同频率的斜向短线交叉，模拟纤维。确定性摆放（无随机），
      // 否则每帧重算会"沸腾"。
      const s = 26;
      return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}"><path d="M0 ${s} L ${s} 0 M ${s * 0.5} ${s} L ${s} ${s * 0.5} M 0 ${s * 0.5} L ${s * 0.5} 0" fill="none" stroke="#A8B4BE" stroke-width="0.9" opacity="0.1"/></pattern>`;
    }
    case "cream":
    case "plain":
      return "";
  }
}

/**
 * 背景纹理层：铺在板面之上、内容之下，随运镜移动（纹理长在板上）。
 * 无纹理背景返回空串。
 */
export function backgroundSvg(
  bg: BoardBackground,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  id = "pocBg",
): string {
  if (backgroundDefs(bg) === "") return "";
  return `<rect x="${fmt(vx - vw * 0.5)}" y="${fmt(vy - vh * 0.5)}" width="${fmt(vw * 2)}" height="${fmt(vh * 2)}" fill="url(#${id})"/>`;
}

/** 按背景样式派生板面样式（底色随背景变，光学层沿用传入的基样式）. */
export function boardStyleFor(
  bg: BoardBackground,
  base: BoardStyle = BOARD_PAPER,
): BoardStyle {
  return { ...base, ...backgroundSurface(bg) };
}

/**
 * 设计稿 §1 的白板：细边框 + 四角深灰圆角包角。
 *
 * 与 `BOARD`（拍摄感真实白板）的区别是**光学层全关**：设计稿是一张平面
 * 设计图，没有日光灯反光、没有金属渐变。保留极轻暗角只为避免大白面死平。
 *
 * 包角件是这块板"是白板"的主要视觉信号——比边框本身更管用。设计稿的边框
 * 只有几像素，真正让人认出是白板的是那四个深色角件。
 */
export const BOARD_DESIGN: BoardStyle = {
  surface: "#FFFFFF",
  surfaceEdge: "#F7F9FA",
  frame: "#C9D1D8",
  frameLight: "#E8EDF1",
  frameDark: "#AAB4BD",
  frameSide: 7,
  frameTop: 7,
  trayHeight: 0,
  glare: 0,
  vignette: 0.1,
  cornerSize: 38,
};

/** 板面 + 反光 + 暗角 + 铝框共用的 defs（每帧一份，id 固定）. */
export function boardDefs(s: BoardStyle = BOARD): string {
  return [
    // 板面：中心亮、四周极轻转冷（大平面的光衰减）
    `<radialGradient id="pocSurface" cx="46%" cy="34%" r="82%">`,
    `<stop offset="0%" stop-color="${s.surface}"/>`,
    `<stop offset="62%" stop-color="${s.surface}"/>`,
    `<stop offset="100%" stop-color="${s.surfaceEdge}"/>`,
    `</radialGradient>`,
    // 日光灯反光带：软边（两端透明、中段亮）
    `<linearGradient id="pocGlare" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>`,
    `<stop offset="28%" stop-color="#ffffff" stop-opacity="0.85"/>`,
    `<stop offset="62%" stop-color="#ffffff" stop-opacity="0.5"/>`,
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>`,
    `</linearGradient>`,
    // 暗角：四边各一条（线性，向内衰减到透明）
    `<linearGradient id="pocVigT" x1="0%" y1="0%" x2="0%" y2="100%">`,
    `<stop offset="0%" stop-color="#4a5560" stop-opacity="0.16"/>`,
    `<stop offset="100%" stop-color="#4a5560" stop-opacity="0"/>`,
    `</linearGradient>`,
    `<linearGradient id="pocVigB" x1="0%" y1="100%" x2="0%" y2="0%">`,
    `<stop offset="0%" stop-color="#4a5560" stop-opacity="0.2"/>`,
    `<stop offset="100%" stop-color="#4a5560" stop-opacity="0"/>`,
    `</linearGradient>`,
    `<linearGradient id="pocVigL" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#4a5560" stop-opacity="0.14"/>`,
    `<stop offset="100%" stop-color="#4a5560" stop-opacity="0"/>`,
    `</linearGradient>`,
    `<linearGradient id="pocVigR" x1="100%" y1="0%" x2="0%" y2="0%">`,
    `<stop offset="0%" stop-color="#4a5560" stop-opacity="0.14"/>`,
    `<stop offset="100%" stop-color="#4a5560" stop-opacity="0"/>`,
    `</linearGradient>`,
    // 铝框：斜向金属渐变
    `<linearGradient id="pocFrame" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${s.frameLight}"/>`,
    `<stop offset="38%" stop-color="${s.frame}"/>`,
    `<stop offset="70%" stop-color="${s.frameDark}"/>`,
    `<stop offset="100%" stop-color="${s.frame}"/>`,
    `</linearGradient>`,
    // 笔槽：上暗下亮（凹槽）
    `<linearGradient id="pocTray" x1="0%" y1="0%" x2="0%" y2="100%">`,
    `<stop offset="0%" stop-color="${s.frameDark}"/>`,
    `<stop offset="42%" stop-color="${s.frame}"/>`,
    `<stop offset="100%" stop-color="${s.frameLight}"/>`,
    `</linearGradient>`,
  ].join("");
}

/**
 * 画布层：板面。铺满当前视口（含余量），随运镜移动。
 */
export function boardSurfaceSvg(
  vx: number,
  vy: number,
  vw: number,
  vh: number,
): string {
  return `<rect x="${fmt(vx - vw * 0.5)}" y="${fmt(vy - vh * 0.5)}" width="${fmt(vw * 2)}" height="${fmt(vh * 2)}" fill="url(#pocSurface)"/>`;
}

/**
 * 屏幕固定层：日光灯反光 + 四边压暗 + 铝合金外框（+ 可选笔槽）。
 * 必须最后绘制（叠在内容之上）——真实白板的反光会盖住笔迹。
 */
export function boardOverlaySvg(
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  s: BoardStyle = BOARD,
): string {
  // 厚度按缩放换算，保证运镜 zoom 时框的视觉厚度不变
  const k = vw / SCREEN_W;
  const side = s.frameSide * k;
  const top = s.frameTop * k;
  const tray = s.trayHeight * k;
  const parts: string[] = [];

  // —— 日光灯反光：两条斜带（一条宽而弱、一条窄而亮） ——
  if (s.glare > 0) {
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    parts.push(
      `<g transform="rotate(-13 ${fmt(cx)} ${fmt(cy)})">`,
      `<rect x="${fmt(vx - vw * 0.35)}" y="${fmt(vy + vh * 0.055)}" width="${fmt(vw * 1.7)}" height="${fmt(vh * 0.115)}" fill="url(#pocGlare)" opacity="${fmt(0.3 * s.glare)}"/>`,
      `<rect x="${fmt(vx - vw * 0.2)}" y="${fmt(vy + vh * 0.086)}" width="${fmt(vw * 1.5)}" height="${fmt(vh * 0.022)}" fill="url(#pocGlare)" opacity="${fmt(0.5 * s.glare)}"/>`,
      // 下半部一条更弱的（第二根灯管）
      `<rect x="${fmt(vx - vw * 0.3)}" y="${fmt(vy + vh * 0.63)}" width="${fmt(vw * 1.6)}" height="${fmt(vh * 0.07)}" fill="url(#pocGlare)" opacity="${fmt(0.16 * s.glare)}"/>`,
      `</g>`,
    );
  }

  // —— 四边压暗 ——
  if (s.vignette > 0) {
    const op = fmt(s.vignette);
    const bandV = vh * 0.16;
    const bandH = vw * 0.16;
    parts.push(
      `<rect x="${fmt(vx)}" y="${fmt(vy)}" width="${fmt(vw)}" height="${fmt(bandV)}" fill="url(#pocVigT)" opacity="${op}"/>`,
      `<rect x="${fmt(vx)}" y="${fmt(vy + vh - bandV)}" width="${fmt(vw)}" height="${fmt(bandV)}" fill="url(#pocVigB)" opacity="${op}"/>`,
      `<rect x="${fmt(vx)}" y="${fmt(vy)}" width="${fmt(bandH)}" height="${fmt(vh)}" fill="url(#pocVigL)" opacity="${op}"/>`,
      `<rect x="${fmt(vx + vw - bandH)}" y="${fmt(vy)}" width="${fmt(bandH)}" height="${fmt(vh)}" fill="url(#pocVigR)" opacity="${op}"/>`,
    );
  }

  // —— 铝合金外框：四条边 + 内侧高光线 + 外侧暗线 ——
  // 厚度为 0 时整块跳过：否则外/内两个同形矩形会因缠绕规则相消，
  // 得到一个什么都不画（或反而糊掉画面）的 path。
  const bottom = tray > 0 ? tray : side;
  if (side <= 0 && top <= 0 && tray <= 0) {
    // 无框也可能有包角件（设计稿的"只有四个角"变体）
    parts.push(boardCornersSvg(vx, vy, vw, vh, s, k));
    return parts.join("");
  }
  parts.push(
    `<path fill="url(#pocFrame)" d="${[
      `M ${fmt(vx)} ${fmt(vy)}`,
      `H ${fmt(vx + vw)}`,
      `V ${fmt(vy + vh)}`,
      `H ${fmt(vx)}`,
      `Z`,
      `M ${fmt(vx + side)} ${fmt(vy + top)}`,
      `V ${fmt(vy + vh - bottom)}`,
      `H ${fmt(vx + vw - side)}`,
      `V ${fmt(vy + top)}`,
      `Z`,
    ].join(" ")}"/>`,
    // 内侧高光（框与板面的交界，金属反射一条亮线）
    `<rect x="${fmt(vx + side)}" y="${fmt(vy + top)}" width="${fmt(vw - side * 2)}" height="${fmt(vh - top - bottom)}" fill="none" stroke="${s.frameLight}" stroke-width="${fmt(1.6 * k)}" opacity="0.9"/>`,
    // 板面内缘投影（框把光挡住，板面靠框一圈略暗）
    `<rect x="${fmt(vx + side)}" y="${fmt(vy + top)}" width="${fmt(vw - side * 2)}" height="${fmt(vh - top - bottom)}" fill="none" stroke="#8d959c" stroke-width="${fmt(3 * k)}" opacity="0.16"/>`,
    // 外缘暗线
    `<rect x="${fmt(vx + 0.5 * k)}" y="${fmt(vy + 0.5 * k)}" width="${fmt(vw - k)}" height="${fmt(vh - k)}" fill="none" stroke="${s.frameDark}" stroke-width="${fmt(k)}" opacity="0.7"/>`,
  );

  // —— 笔槽（可选） ——
  if (tray > 0) {
    parts.push(
      `<rect x="${fmt(vx + side * 0.4)}" y="${fmt(vy + vh - tray)}" width="${fmt(vw - side * 0.8)}" height="${fmt(tray)}" fill="url(#pocTray)"/>`,
      `<rect x="${fmt(vx + side * 0.4)}" y="${fmt(vy + vh - tray)}" width="${fmt(vw - side * 0.8)}" height="${fmt(tray * 0.16)}" fill="#6f777e" opacity="0.5"/>`,
    );
  }

  parts.push(boardCornersSvg(vx, vy, vw, vh, s, k));

  return parts.join("");
}

/**
 * 设计稿 §1 的四角包角件。
 *
 * 画成"L 形圆角块"而不是整个圆角矩形：设计稿里角件是**贴在框上的独立零件**
 * （四个深色块，边中段是浅色框），画成连续圆角框就变成了另一种东西。
 *
 * 每个角一个 path，绕向一致，用 `stroke-linejoin="round"` 得到圆角。
 */
export function boardCornersSvg(
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  s: BoardStyle,
  k: number,
): string {
  const size = (s.cornerSize ?? 0) * k;
  if (size <= 0) return "";
  const t = Math.max(2, 6 * k); // 角件厚度（细一点才像设计稿的包角，不是护栏）
  const r = Math.max(1, 5 * k); // 圆角半径
  const corner = (cx: number, cy: number, sx: number, sy: number): string => {
    // 从水平臂末端 → 拐角 → 竖直臂末端，描一条粗线得到 L 形
    const d = [
      `M ${fmt(cx + sx * size)} ${fmt(cy)}`,
      `L ${fmt(cx + sx * r)} ${fmt(cy)}`,
      `Q ${fmt(cx)} ${fmt(cy)} ${fmt(cx)} ${fmt(cy + sy * r)}`,
      `L ${fmt(cx)} ${fmt(cy + sy * size)}`,
    ].join(" ");
    return (
      `<path d="${d}" fill="none" stroke="#7C868F" stroke-width="${fmt(t)}" ` +
      `stroke-linecap="round"/>`
    );
  };
  const m = t * 0.5; // 让角件压在框的中线上
  return [
    corner(vx + m, vy + m, 1, 1),
    corner(vx + vw - m, vy + m, -1, 1),
    corner(vx + m, vy + vh - m, 1, -1),
    corner(vx + vw - m, vy + vh - m, -1, -1),
  ].join("");
}
