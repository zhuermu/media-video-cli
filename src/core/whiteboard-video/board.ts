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
  if (side <= 0 && top <= 0 && tray <= 0) return parts.join("");
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

  return parts.join("");
}
