/**
 * PoC: VideoScribe 手部素材接入（Sparkol hands library）
 *
 * 素材来源是 VideoScribe 自己的 hands 库，`assets/sparkol/` 下：
 * - `hands-index.json` 336 条元数据，含 `drawOffset` / `moveOffset`；
 * - `<group>/<slug>-draw.png` 笔尖着纸的手，`-move.png` 提笔移动的手；
 * - `pens/` 组只有笔没有手，人名组（matt/hannah/suneeta…）才是实拍手臂。
 *
 * ## 笔尖坐标不能直接用 drawOffset
 *
 * 十字标实测：`drawOffset` 系统性地偏在真实笔尖的**左上方**，源图上差
 * 20–60px（`suneeta-black-marker` 声明 `(57,-16)`，y 甚至在图外，真实
 * 笔尖在 `(43,114)`）。照它对位，笔尖会离笔迹一段距离。
 *
 * 所以笔尖从 **alpha 通道实测**：这些手臂图没有投影（不透明包围盒紧贴
 * 手臂），沿笔轴方向取最外沿的那一层不透明像素，在其中求质心 —— 着纸点
 * 是笔头**面**的中心，取单个极角像素会偏外 6–8px（460 显示宽实测），
 * 表现为"墨迹落在笔尖下方"。用哪个角由 `drawOffset` 判断——它虽然不
 * 精确，但足以指出笔是朝左上还是朝右上（库里有左手素材）。这样把元数据
 * 可靠的部分（朝向）和像素可靠的部分（精确位置）各取所长。
 *
 * 两态切换是 VideoScribe 观感的一半：落笔用 draw 图 + drawOffset，抬笔
 * 移动用 move 图 + moveOffset。同一支笔的两张图手型不同，切换时手会做出
 * "压下去 / 提起来"的动作。
 *
 * ## 为什么内联 base64 而不是 resourcesDir
 *
 * 实测（1080×1920 同一帧，重复 4 次取均值）：
 * ```
 * resourcesDir=N disk=N →  75ms      resourcesDir=Y disk=N → 608ms
 * resourcesDir=N disk=Y →  64ms      resourcesDir=Y disk=Y → 1396ms
 * ```
 * 只要给 resvg 传 `resourcesDir`，每帧成本涨 8 倍以上（横屏同样复现），
 * 一条 20s 竖屏视频从 45s 变成 6 分钟。所以手部 PNG 走内联 data URI，并且
 * **在装载期一次性缩到实际显示尺寸**再编码——直接内联原图（800×1250、
 * 数百 KB）会让每帧 SVG 膨胀到 MB 级，resvg 每帧都要重解一次大图。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { fmt } from "../whiteboard/index";
import type { PenPose } from "../whiteboard/index";
import type { Orientation } from "./layout";

/**
 * 手部贴图在 1080 宽画幅下的默认显示宽度（px）。
 *
 * 460 偏小 —— 手臂看着像根细杆，"有人在写"的存在感不够。500 是在"手够
 * 显眼"和"不盖住正在写的字"之间试出来的：再大就会挡住下一行内容。
 */
export const DEFAULT_HAND_SIZE = 500;

/** 判定"笔已着纸"的 lift 阈值. */
const DOWN_LIFT = 0.02;

export interface HandAsset {
  slug: string;
  name: string;
  group: string;
  drawPath: string;
  movePath: string;
  /** 笔尖在 draw 图内的像素坐标（可为负）. */
  drawTip: readonly [number, number];
  moveTip: readonly [number, number];
  /** draw 图的像素尺寸. */
  width: number;
  height: number;
  /** true = 手画在内容**下面**（库里仅 3 条如此）. */
  handBehind: boolean;
}

interface RawHand {
  name: string;
  group?: string;
  slug: string;
  handBehind?: boolean;
  drawOffset?: [number, number];
  moveOffset?: [number, number];
}

/** 读 PNG 头的 IHDR 取尺寸；不是 PNG 返回 null. */
export function pngSize(path: string): { w: number; h: number } | null {
  let head: Buffer;
  try {
    head = readFileSync(path).subarray(0, 24);
  } catch {
    return null;
  }
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

/**
 * 列出所有本地已下全分辨率、且可用于书写的手。
 *
 * 过滤掉两类：
 * - `pens` 组（只有笔，没有手）；
 * - `*-move-in-hand` / `*-move-in-finger`（用于把图片"搬"进画面的手势，
 *   笔尖偏移是 -134 这种大负值，不是书写用的）。
 */
export function listHands(sparkolDir: string): HandAsset[] {
  const idxPath = join(sparkolDir, "hands-index.json");
  if (!existsSync(idxPath)) return [];
  let raw: RawHand[];
  try {
    raw = JSON.parse(readFileSync(idxPath, "utf8")) as RawHand[];
  } catch {
    return [];
  }
  const out: HandAsset[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    const group = h.group ?? "";
    if (group === "" || group === "pens") continue;
    if (/-move-in-(hand|finger)$/.test(h.slug)) continue;
    // 库里存在同名不同 id 的条目（如 matt-black-pencil ×2），文件会互相
    // 覆盖，这里按 slug 去重，先到先得
    const key = `${group}/${h.slug}`;
    if (seen.has(key)) continue;
    const drawPath = join(sparkolDir, group, `${h.slug}-draw.png`);
    const movePath = join(sparkolDir, group, `${h.slug}-move.png`);
    if (!existsSync(drawPath)) continue;
    const size = pngSize(drawPath);
    if (size === null) continue;
    seen.add(key);
    out.push({
      slug: h.slug,
      name: h.name,
      group,
      drawPath,
      movePath: existsSync(movePath) ? movePath : drawPath,
      drawTip: h.drawOffset ?? [0, 0],
      moveTip: h.moveOffset ?? h.drawOffset ?? [0, 0],
      width: size.w,
      height: size.h,
      handBehind: h.handBehind === true,
    });
  }
  return out;
}

/** 单张贴图的运行时数据（已缩放 + 已编码）. */
export interface HandImage {
  uri: string;
  w: number;
  h: number;
  /** 缩放后的锚点坐标（书写手 = 笔尖；搬移手 = 被搬物落点）. */
  tipX: number;
  tipY: number;
  /**
   * 手臂断口（缩放后坐标）：素材里手臂到这里就没了，下面是透明留白。
   *
   * 有了它才能把手臂**接到画面外**（见 {@link handCueSvg}）。测不出来时
   * 为 undefined，此时不接 —— 宁可断口露着，也不要凭空画一条不知从哪来
   * 的胳膊。
   */
  arm?: ArmCuff;
  /** 手腕位置（袖口切断用）；量不出来为 undefined. */
  wrist?: Wrist;
}

/** 两态贴图（落笔/抬笔，或手势的接触/离开态）. */
export interface HandTwoState {
  draw: HandImage;
  move: HandImage;
  /**
   * 手臂怎么收尾（见 {@link ArmMode}）。由画幅朝向决定，装载时就定下来。
   * 省略时按 `"extend"`。
   */
  armMode?: ArmMode;
}

export interface HandRuntime extends HandTwoState {
  asset: HandAsset;
}

/** alpha 判定为"实体"的阈值（这些图无投影，低阈值即可）. */
const ALPHA_SOLID = 24;

/**
 * 笔头带宽（相对图宽）：从最外沿往笔身方向取这么一层，在其中求质心。
 *
 * 3.2% 是从实拍素材反推的：768px 宽的原图上约 25px，正好覆盖一个马克笔
 * 头的着纸面，再往里就吃进笔杆/手指了。
 */
const NIB_BAND_RATIO = 0.032;

/**
 * 从 RGBA 像素里找笔尖着纸点。
 *
 * 两步：
 * 1. 沿对角方向 d（笔指向的那个角）求投影最小的不透明像素——它是笔头的
 *    最外沿；
 * 2. 在「投影 ≤ 最外沿 + 笔头带宽」的像素集合里求**质心**。
 *
 * 只做第 1 步（早先的实现）会把锚点钉在抗锯齿边缘的那一个角像素上，
 * 它比真实着纸点偏外 6–8px（460 显示宽下实测），观感就是"笔尖悬在
 * 笔迹的左上方一点、墨迹反而落在笔尖下方"。着纸点是笔头**面**的中心，
 * 不是轮廓的极角，所以要在笔头这一层里取质心。
 *
 * @param upLeft true = 笔朝左上（右手常见），false = 朝右上（左手素材）
 * @returns null 表示整图透明
 */
function measureTip(
  px: Uint8Array,
  w: number,
  h: number,
  upLeft: boolean,
): { x: number; y: number } | null {
  /** 像素在笔轴方向上的投影（越小越靠笔尖）. */
  const proj = (x: number, y: number): number => (upLeft ? x : w - 1 - x) + y;

  let best = Number.POSITIVE_INFINITY;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (px[(row + x) * 4 + 3]! <= ALPHA_SOLID) continue;
      const cost = proj(x, y);
      if (cost < best) best = cost;
    }
  }
  if (best === Number.POSITIVE_INFINITY) return null;

  // 对角投影的"一层"厚度换算：proj 是 x+y，沿对角前进 1px 使 proj 增
  // 约 √2，所以带宽要乘 √2 才对应几何上的 NIB_BAND_RATIO 层厚
  const band = Math.max(2, w * NIB_BAND_RATIO * Math.SQRT2);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (px[(row + x) * 4 + 3]! <= ALPHA_SOLID) continue;
      if (proj(x, y) > best + band) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  return n === 0 ? null : { x: sx / n, y: sy / n };
}

/**
 * 锚点来源：
 * - `"nib"` alpha 实测（书写笔尖 / 橡皮擦接触面 / 指尖）；
 * - `"declared"` 用素材声明的偏移（`move-in-*` 这类把物件"搬"进画面的
 *   手势，锚点是**被搬物**的落点，常在图外——像素里没有可测的东西）。
 */
export type AnchorMode = "nib" | "declared";

/** 判定断口所需的最少实体像素（比这更细的是笔杆或手指，不是手臂）. */
const ARM_MIN_WIDTH_PX = 4;

/**
 * 断口最小宽度（相对图宽）—— 低于此视为杂散像素，不是手臂。
 *
 * 实测 500px 宽的贴图底部有一段 8px 的纯黑残留，按它接出去会变成一根黑线。
 */
const ARM_MIN_WIDTH_RATIO = 0.06;

/** 收笔渐尖区的高度（相对图高）：在这个窗口里找手臂的真实截面. */
const ARM_TAPER_ZONE = 0.12;

/** 估斜率的纵向基线（px）：太短会被抗锯齿噪声带偏. */
const ARM_SLOPE_BASE = 24;

/** 斜率上限：噪声导致的荒谬值会让手臂横着飞出去. */
const ARM_MAX_SLOPE = 1.2;

/** 手臂断口（缩放后坐标）+ 手臂朝向. */
export interface ArmCuff {
  /** 从这一行开始往外接. */
  y: number;
  x0: number;
  x1: number;
  /** 手臂中线的 dx/dy：正值 = 往右下走. */
  slope: number;
  fill: string;
}

/**
 * 手臂的处理方式。
 *
 * - `"cuff"` 在手腕处切断，加一个袖口。**默认**：读起来是"手从袖子里伸
 *   出来"，不需要交代手臂去哪了。
 * - `"extend"` 顺着手臂方向补一条同色带子接出画面。只在量不出手腕时兜底，
 *   或者调用方**自己把手放得足够大**、真手臂本来就快出画时用。
 *
 * ## 为什么不靠放大解决
 *
 * 直觉做法是"把手放大到手臂自然出画"。量过之后不行：素材里笔尖到手臂
 * 末端只有**图宽的 1.2 倍**，而横版（1920×1080）标题行到底边是图宽的
 * 1.9 倍。要让写标题时手臂出画，贴图得有 805px 宽 —— **占画宽 42%**，
 * 马克笔自己就占掉三分之一画面，会盖住正在写的字。竖版更离谱（要 2.8 倍，
 * 手比画幅还宽）。
 *
 * 所以补一条假手臂和放大都不成立，切断才是对的：观众不会追问手臂在哪，
 * 但会立刻注意到一条断在画面正中的胳膊。
 */
/**
 * `"none"`：什么都不补。给**根本没有手臂的光标**用（只有一支笔的模式）——笔素材
 * 下方是投影而不是前臂，套袖口或接带子都会在投影上长出一块莫名的色块。
 * 只有笔的模式因此绕开了上面整段权衡：没有手臂，就没有收尾问题。
 */
export type ArmMode = "extend" | "cuff" | "none";

/** 手腕（缩放后坐标）：前臂最细处，袖口就套在这儿. */
export interface Wrist {
  /** 手腕中心. */
  cx: number;
  cy: number;
  /** 手腕处的半宽. */
  halfWidth: number;
  /** 手臂中线的 dx/dy. */
  slope: number;
}

/** 一行的实体像素统计. */
function rowSpan(
  px: Uint8Array,
  w: number,
  y: number,
): { x0: number; x1: number; n: number; fill: string } | null {
  let x0 = -1;
  let x1 = -1;
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const row = y * w;
  for (let x = 0; x < w; x++) {
    const i = (row + x) * 4;
    if (px[i + 3]! <= ALPHA_SOLID) continue;
    if (x0 < 0) x0 = x;
    x1 = x;
    n++;
    r += px[i]!;
    g += px[i + 1]!;
    b += px[i + 2]!;
  }
  if (n === 0) return null;
  const hex = (v: number): string =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return { x0, x1, n, fill: `#${hex(r)}${hex(g)}${hex(b)}` };
}

/**
 * 找手腕：手掌之后前臂最细的那一行。
 *
 * 宽度剖面很有辨识度（实测书写手，250px 宽下）：手掌在 y≈80 处最宽 112px，
 * 收窄到 y≈168 的 47px，再重新变宽成前臂 87px。那个极小值就是手腕。
 *
 * 找法：先在上半段取手掌峰，再往下走到宽度不再变窄为止。找不到（有些
 * 手势的掌心是竖着的，没有明显收腰）就返回 null —— 此时退回接出画面，
 * 宁可手臂长一点，也不要在错误的地方切一刀。
 */
function measureWrist(px: Uint8Array, w: number, h: number): Wrist | null {
  const width: number[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (px[(row + x) * 4 + 3]! > ALPHA_SOLID) n++;
    }
    width.push(n);
  }
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (width[y]! >= ARM_MIN_WIDTH_PX) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0 || bottom - top < 40) return null;

  // 手掌峰：上半段最宽的一行（笔尖那几行很细，不会被误判成峰）
  const palmEnd = top + Math.round((bottom - top) * WRIST_SEARCH_ZONE);
  let palmY = top;
  for (let y = top; y <= palmEnd; y++) {
    if (width[y]! > width[palmY]!) palmY = y;
  }
  // 从手掌峰往下找极小值：宽度回升到极小值的 1.12 倍就算过了手腕
  let minY = palmY;
  for (let y = palmY + 1; y <= bottom; y++) {
    if (width[y]! < width[minY]!) {
      minY = y;
      continue;
    }
    if (width[y]! > width[minY]! * WRIST_REBOUND) break;
  }
  if (minY === palmY || width[minY]! < ARM_MIN_WIDTH_PX) return null;

  const at = rowSpan(px, w, minY);
  if (at === null) return null;
  const ref = rowSpan(px, w, Math.min(bottom, minY + ARM_SLOPE_BASE));
  let slope = 0;
  if (ref !== null) {
    const d = Math.min(bottom, minY + ARM_SLOPE_BASE) - minY;
    if (d > 0) {
      slope = (ref.x0 + ref.x1) / 2 - (at.x0 + at.x1) / 2;
      slope = Math.max(-ARM_MAX_SLOPE, Math.min(ARM_MAX_SLOPE, slope / d));
    }
  }
  return {
    cx: (at.x0 + at.x1) / 2,
    cy: minY,
    halfWidth: (at.x1 - at.x0 + 1) / 2,
    slope,
  };
}

/** 手掌峰在实体区上部的这个比例内找. */
const WRIST_SEARCH_ZONE = 0.45;

/** 宽度回升到极小值的这个倍数，就认为已经过了手腕. */
const WRIST_REBOUND = 1.12;

/**
 * 量出手臂的真实截面和朝向，用来把手臂接到画面外。
 *
 * 素材里的手臂**不是平口截断，而是渐尖收笔**：实测 500px 宽的书写手贴图，
 * 手臂在 y=703 处宽 163px，到 y=767 收成 8px 的尖。所以"最靠下那一行"量到
 * 的是笔尖粗细的残迹，照它接出去是一根线；要在收笔区里找最宽的那一行，
 * 那才是手臂的真实粗细。
 *
 * 手臂还是斜的（这只手向右下伸出，84px 高度里中线右移 35px，约 22°）。
 * 只按竖直方向接会明显拐一下，所以顺带量出中线斜率。
 */
function measureArmCuff(px: Uint8Array, w: number, h: number): ArmCuff | null {
  const minWidth = Math.max(ARM_MIN_WIDTH_PX, w * ARM_MIN_WIDTH_RATIO);
  let bottom = -1;
  for (let y = h - 1; y >= Math.floor(h * 0.5); y--) {
    const s = rowSpan(px, w, y);
    if (s !== null && s.n >= ARM_MIN_WIDTH_PX) {
      bottom = y;
      break;
    }
  }
  if (bottom < 0) return null;

  // 收笔区里最宽的一行 = 手臂真实截面（同宽时取更靠下的，接缝更短）
  const top = Math.max(
    Math.floor(h * 0.5),
    Math.round(bottom - h * ARM_TAPER_ZONE),
  );
  let best: { y: number; s: NonNullable<ReturnType<typeof rowSpan>> } | null =
    null;
  for (let y = bottom; y >= top; y--) {
    const s = rowSpan(px, w, y);
    if (s === null) continue;
    if (best === null || s.n > best.s.n) best = { y, s };
  }
  if (best === null || best.s.n < minWidth) return null;

  const refY = Math.max(top, best.y - ARM_SLOPE_BASE);
  const ref = rowSpan(px, w, refY);
  let slope = 0;
  if (ref !== null && best.y > refY) {
    const cx = (best.s.x0 + best.s.x1) / 2;
    const rcx = (ref.x0 + ref.x1) / 2;
    slope = (cx - rcx) / (best.y - refY);
    slope = Math.max(-ARM_MAX_SLOPE, Math.min(ARM_MAX_SLOPE, slope));
  }
  return {
    y: best.y,
    x0: best.s.x0,
    x1: best.s.x1,
    slope,
    fill: best.s.fill,
  };
}

/**
 * 一次 resvg 渲染同时完成三件事：缩到显示尺寸、拿到 RGBA 像素实测锚点、
 * 重新编码为 data URI。
 *
 * 比内联原图省下每帧几百 KB 的解码量；`render().pixels` 直接给 RGBA，
 * 不需要额外的 PNG 解码依赖或 ffmpeg 子进程。
 */
export function prepareImage(
  path: string,
  srcW: number,
  srcH: number,
  scale: number,
  declaredAnchor: readonly [number, number],
  mode: AnchorMode,
): HandImage {
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const srcUri = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image href="${srcUri}" x="0" y="0" width="${w}" height="${h}"/></svg>`;
  const rendered = new Resvg(svg, {
    font: { loadSystemFonts: false },
  }).render();
  const uri = `data:image/png;base64,${Buffer.from(rendered.asPng()).toString("base64")}`;
  const cuff = measureArmCuff(rendered.pixels, rendered.width, rendered.height);
  const wrist = measureWrist(rendered.pixels, rendered.width, rendered.height);
  const attach = (img: HandImage): HandImage => {
    if (cuff !== null) img.arm = cuff;
    if (wrist !== null) img.wrist = wrist;
    return img;
  };
  const fallback: HandImage = attach({
    uri,
    w,
    h,
    tipX: declaredAnchor[0] * scale,
    tipY: declaredAnchor[1] * scale,
  });
  if (mode === "declared") return fallback;
  // drawOffset 只用来判断笔朝哪个角（它的精确值不可靠，见模块注释）
  const upLeft = declaredAnchor[0] <= srcW / 2;
  const tip = measureTip(
    rendered.pixels,
    rendered.width,
    rendered.height,
    upLeft,
  );
  if (tip === null) return fallback;
  return attach({ uri, w, h, tipX: tip.x, tipY: tip.y });
}

export interface LoadHandOpts {
  /** 画幅宽度. */
  canvasWidth: number;
  /**
   * 画幅高度。给了它才能按**短边**定手的大小（见 {@link canvasHandScale}）；
   * 省略时退回只按宽度算——横屏下会把手放大到荒谬的尺寸，仅为兼容早期
   * 只有竖屏时的调用点保留。
   */
  canvasHeight?: number;
  /** 1080 宽画幅下的手部显示宽度. Default {@link DEFAULT_HAND_SIZE}. */
  handSize?: number;
  /** 手臂怎么收尾. Default {@link DEFAULT_ARM_MODE}. */
  armMode?: ArmMode;
}

/**
 * 手的显示比例：按画幅**短边**归一，不是宽度。
 *
 * 一只手在画面里该有多大，取决于镜头离白板多远——两个画幅的短边都是
 * 1080，所以同一个比例在横竖屏下看起来是同一只手。
 *
 * 早先按 `width/1080` 算：横屏 1920 宽 → 1.78 倍，一条手臂纵向 1290px
 * 塞进 1080 高的画面里，直接盖掉半屏内容和正在写的字。
 */
export function canvasHandScale(canvasW: number, canvasH?: number): number {
  return Math.min(canvasW, canvasH ?? canvasW) / 1080;
}

/** 手臂收尾方式的默认值（量不出手腕时的兜底；正常按画幅走 {@link armModeFor}）. */
export const DEFAULT_ARM_MODE: ArmMode = "cuff";

/**
 * 手臂显示高度（1080 短边画幅下），**按画幅朝向直接给像素**，不再从"手宽"换算。
 *
 * 早先是 `handSize × 1210/768` 换算过来的，那个 1210/768 是 suneeta 素材的比例——
 * 换一支手臂更窄的素材，同一个"手宽"会得到完全不同的手臂长度，很容易算错。手势
 * 素材本来就是按**手臂高度**归一的（见 {@link ARM_DISPLAY_HEIGHT}），所以直接给高度。
 *
 * 取值目标是**让手臂伸出画幅**（参考图里前臂都是被画幅边缘切掉的）：
 * 判定标准是**最坏帧**——全片笔尖最高的那一帧（通常是写标题第一个字），此时手臂
 * 另一端仍要在画幅之外。最坏帧不能靠 `marginTop` 估，得实测：`experiments/hand-frame.ts`
 * 探针遍历全片求笔尖屏幕坐标最小的 y，示例文章上是横版 y=126、竖版 y=210。
 *
 * 贴图左上角画在 `笔尖 − tip` 处，故贴图底边 = `penY − tipY + h`。当前取值实测：
 * - 横版 1920×1080，臂高 1550：手宽 818px（43% 画宽），最坏帧底边 y≈1582，余量 502px。
 * - 竖版 1080×1920，臂高 2250：手宽 1187px（110% 画宽），最坏帧底边 y≈2324，余量 404px。
 *
 * 都留了四五百像素余量，而不是刚好够——`marginTop` 或标题字号一改，刚好够就会变成
 * 差一点，而"差一点"的表现是画板中间多出一截斜切的断臂，比手大一点难看得多（1830
 * 那一档就是这样，实测断口正好露在画幅底边内侧）。
 *
 * 这两个值只在手臂**够窄**的素材上成立：手宽 = 高度 × 素材宽高比。所以书写素材由
 * {@link HAND_WRITE_SLUG} 钉死（matt-pencil-1，0.527），不让 `pickGesture` 按"哪支笔
 * 像白板笔"自选——chalk-1（0.750）在竖版会算出 1.7 倍画宽的手。
 */
export const LANDSCAPE_ARM_HEIGHT = 1550;
export const PORTRAIT_ARM_HEIGHT = 2250;

/**
 * 按画幅朝向选手臂收尾方式。
 *
 * - **横版 → `extend`**：手放大后真手臂本身就伸出画幅，顺着方向接一段带子刚好补在
 *   画外，看不见；袖口反而是个突兀的深色方块。
 * - **竖版 → `none`**：竖版手臂高度已经超过画幅高（2250 > 1920），素材自己那段前臂
 *   就伸出画外了，不需要补；补的话那条又粗又长的合成色带会读作假的（纯色、渐变都试过）。
 */
export function armModeFor(orientation: Orientation): ArmMode {
  // 横版：手放大后真手臂本身就伸出画幅，接一段带子刚好补在画外，看不见。
  // 竖版：画幅 1920 高，实测手臂要伸出画幅需要手宽 104% 画宽（比屏幕还宽），
  // 所以补的带子必然有 400px 以上留在画面里——纯色也好、渐变也好，那么长一段
  // 合成肢体都会读作假的（两种都试过）。竖版因此**什么都不补**，让素材自己那段
  // 渐尖收笔的小臂自然收掉。
  return orientation === "landscape" ? "extend" : "none";
}

/** 按画幅朝向选手臂显示高度. */
export function armHeightFor(orientation: Orientation): number {
  return orientation === "landscape"
    ? LANDSCAPE_ARM_HEIGHT
    : PORTRAIT_ARM_HEIGHT;
}

/** 画笔光标类型：只有一支笔 / 手 + 前臂. */
export type CursorKind = "pen" | "hand";

/**
 * 只有笔时的光标显示高度（1080 短边下）。
 *
 * 不能沿用手臂高度：那是按"手 + 前臂"归一的，而笔素材是斜放的笔身，套上去一支笔
 * 会被放大到半个画面。
 */
export const PEN_DISPLAY_HEIGHT = 220;

/** 只有笔的模式默认用哪支笔（银灰细杆，最接近 Apple Pencil 的观感）. */
export const DEFAULT_PEN_SLUG = "black-biro";

/**
 * 手拿笔模式固定用哪张书写素材（用户指定）。
 *
 * 手宽 = 手臂高度 × 素材宽高比，这张是 422×800（0.527）——比 matt 的中位数窄，
 * 放大到手臂出画时手宽还装得下画幅。找不到这个 slug 时回退到该 persona 手臂最窄的
 * 那张（窄 = 同样手臂长度下手更小，更容易让手臂出画）。
 */
export const HAND_WRITE_SLUG = "matt-pencil-1";

/**
 * 装载一只手（draw + move 两态），缩放到该画幅的显示尺寸并编码为 data URI。
 *
 * @throws Error 素材文件读取/解码失败（素材缺失应在 listHands 阶段就发现）
 */
export function loadHand(asset: HandAsset, o: LoadHandOpts): HandRuntime {
  const targetW =
    (o.handSize ?? DEFAULT_HAND_SIZE) *
    canvasHandScale(o.canvasWidth, o.canvasHeight);
  const mk = (path: string, tip: readonly [number, number]): HandImage => {
    const size = pngSize(path) ?? { w: asset.width, h: asset.height };
    return prepareImage(path, size.w, size.h, targetW / size.w, tip, "nib");
  };
  return {
    asset,
    draw: mk(asset.drawPath, asset.drawTip),
    move: mk(asset.movePath, asset.moveTip),
    armMode: o.armMode ?? DEFAULT_ARM_MODE,
  };
}

/**
 * 一只手在 1080 宽画幅下的显示高度（手臂长度）。
 *
 * 书写手素材是 768×1210，按 {@link DEFAULT_HAND_SIZE} 宽显示 → 高 725。
 * 手势素材的原图宽度差得很远（`move-in-hand` 只有 289 宽，因为掌心竖着
 * 占不了多少横向空间），按宽度对齐会把它放大到荒谬的比例；**按高度**
 * 对齐才让同一个人的各种手势看起来是同一条手臂。
 */
export const ARM_DISPLAY_HEIGHT = (DEFAULT_HAND_SIZE * 1210) / 768;

/** 按 slug（或 group/slug）挑一只手；找不到返回 null. */
export function findHand(
  hands: readonly HandAsset[],
  query: string,
): HandAsset | null {
  const q = query.toLowerCase();
  return (
    hands.find((h) => `${h.group}/${h.slug}` === q) ??
    hands.find((h) => h.slug === q) ??
    hands.find((h) => h.slug.includes(q)) ??
    null
  );
}

/**
 * 一帧里"手在哪、以什么姿态"的完整描述。
 *
 * 书写手由 `penPoseAt` 推出（笔尖跟着笔迹），手势手由各自的手势元素
 * 直接给出——两者最终都收敛成 HandCue 交给 {@link handCueSvg} 画，
 * 帧装配因此只需要处理一种东西。
 */
export interface HandCue {
  /** 两态贴图（书写手 = 落笔/抬笔；手势手两态可以是同一张）. */
  rt: HandTwoState;
  /** 锚点落在画布上的位置（笔尖 / 擦头 / 指尖 / 被搬物落点）. */
  x: number;
  y: number;
  /** 0 = 贴板，1 = 抬到最高（>0.02 用 move 态贴图）. */
  lift: number;
  /** 绕锚点旋转（度）. */
  rotDeg?: number;
  /** 绕锚点缩放（在 lift 引起的缩放之上再乘）. */
  scale?: number;
  /** 水平镜像（右手素材镜像成左手，用于从画面左侧入场的手势）. */
  mirror?: boolean;
  /** 整体不透明度（撤手淡出）. Default 1. */
  opacity?: number;
}

/**
 * 手臂往画面外接多长（相对贴图高度的倍数）。
 *
 * 2.4 倍是按最坏情况定的：竖版 1920 高、笔尖写在最靠上的标题行（y≈150），
 * 贴图高 787、断口在 740 左右，还差 1300px 才到底边 —— 787×2.4≈1890 够。
 * 接过头没有代价（画布外会被裁掉），接不够就会重新露出断口。
 */
const ARM_EXTEND_FACTOR = 2.4;

/**
 * 接缝往上叠多少（相对贴图高度）。
 *
 * 从量到的最宽截面**往上**叠一段再起笔：那一段的手臂只会更宽，所以带子的
 * 侧边会被照片盖住，看不到台阶。只叠几像素的话，抗锯齿边缘盖不住，接缝
 * 处会露出一道明显的凹口（实测 8px 不够）。
 */
const ARM_SEAM_OVERLAP = 0.06;

/** 带子比量到的截面略宽一点，确保侧边压在照片下面而不是探出来. */
const ARM_INFLATE_PX = 3;

/**
 * 把手臂从收笔处接到画面外。
 *
 * 素材里的手臂是渐尖收笔的（见 {@link measureArmCuff}），不接的话手臂会在
 * 画面中间尖着断掉。带子顺着量出的中线斜率走，所以接上去是同一条手臂的
 * 延长而不是拐一下。
 *
 * 带子在 `<g>` 里面、画在贴图**之前**，跟着手一起旋转/缩放/镜像。
 */
function armExtensionSvg(img: HandImage): string {
  const arm = img.arm;
  if (arm === undefined) return "";
  const overlap = img.h * ARM_SEAM_OVERLAP;
  const len = img.h * ARM_EXTEND_FACTOR;
  const ox = -img.tipX;
  const oy = -img.tipY;
  const x0 = arm.x0 - ARM_INFLATE_PX;
  const x1 = arm.x1 + ARM_INFLATE_PX;
  const yTop = arm.y - overlap;
  const yBot = arm.y + len;
  const dxTop = -overlap * arm.slope;
  const dxBot = len * arm.slope;
  const pt = (x: number, y: number): string => `${fmt(ox + x)},${fmt(oy + y)}`;
  const points = [
    pt(x0 + dxTop, yTop),
    pt(x1 + dxTop, yTop),
    pt(x1 + dxBot, yBot),
    pt(x0 + dxBot, yBot),
  ].join(" ");
  // 横向筒状明暗：肢体是圆柱，受光后两侧暗、中间亮。
  //
  // 早先这里是一块**纯色**多边形，而且画在贴图**下面**。两个问题叠加起来非常显眼：
  // 纯色让它读作"一张纸"而不是手臂；画在下面则让贴图里那段渐尖收笔的小臂露在
  // 外面，于是色块从锥形手臂两侧支出去，接缝处还有一道硬台阶（竖版尤其明显，
  // 因为要补的长度很长）。
  //
  // 现在改成：画在贴图**上面**（盖住那段锥尖，silhouette 变成等宽的手臂），
  // 并给一道横向三段渐变。参考图里的手臂正是被画幅边缘齐齐切掉的等宽小臂。
  const id = `armx${Math.round(arm.x0)}_${Math.round(arm.y)}`;
  const edge = shade(arm.fill, 0.82);
  const mid = shade(arm.fill, 1.04);
  return (
    `<defs><linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="0%">` +
    `<stop offset="0%" stop-color="${edge}"/>` +
    `<stop offset="38%" stop-color="${mid}"/>` +
    `<stop offset="72%" stop-color="${arm.fill}"/>` +
    `<stop offset="100%" stop-color="${edge}"/>` +
    `</linearGradient></defs>` +
    `<polygon points="${points}" fill="url(#${id})"/>`
  );
}

/** 把 `#rrggbb` 按系数提亮/压暗（>1 提亮），用于手臂的筒状明暗. */
function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * k))),
  );
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 袖口比手腕宽多少（袖子总是比手腕松一圈；等宽会像贴了块胶布）. */
const CUFF_WIDEN = 1.5;

/** 袖口厚度（相对手腕全宽）. */
const CUFF_THICKNESS = 0.68;

/**
 * 切口沿手臂往下挪多少（相对手腕全宽）。
 *
 * 不挪的话切口就压在掌根上，看起来是"手在手掌处被切断"而不是"手从袖子里
 * 伸出来"—— 得留出一小段手腕，袖口才有东西可套。
 */
const CUFF_DROP = 0.55;

/** 袖口往手掌方向叠多少（相对厚度）：盖住切口那条硬边. */
const CUFF_OVERLAP = 0.26;

/** 袖口末端的圆角（相对袖口半宽）：直角会读成一块贴上去的色块. */
const CUFF_CORNER = 0.42;

/** 袖口布料色与袖口内侧的暗部（衬衫的中间调，白板上不消失也不抢眼）. */
const CUFF_FILL = "#4a5560";
const CUFF_EDGE = "#333c45";

/** 袖口末端暗部占厚度的比例（袖筒里的阴影）. */
const CUFF_SHADOW_RATIO = 0.3;

/**
 * 手腕切断 + 袖口。
 *
 * 竖版画幅太高，接手臂要接 1500px，那条色带会横穿半个画面。切到手腕、
 * 套一个袖口，读起来就是"手从袖子里伸出来"——观众不会去想手臂在哪。
 *
 * 切口垂直于手臂轴，不是水平线：手臂是斜的，水平切会切出一个斜楔子。
 * SVG 里用 `clipPath` 的半平面多边形实现（`clipPathUnits` 默认就是当前
 * 用户坐标系，所以直接用贴图的局部坐标即可）。
 *
 * clipPath 的 id 由手腕几何派生：同一只手每帧都是同一个 id（帧之间不会
 * 冲突），不同的手几何不同、id 也不同。
 */
function cuffSvg(
  img: HandImage,
): { clipId: string; defs: string; over: string } | null {
  const wrist = img.wrist;
  if (wrist === undefined) return null;
  const ox = -img.tipX;
  const oy = -img.tipY;
  // 手臂轴（往下）与法向
  const len = Math.hypot(wrist.slope, 1);
  const dx = wrist.slope / len;
  const dy = 1 / len;
  const nx = dy;
  const ny = -dx;

  const wristWidth = wrist.halfWidth * 2;
  const thickness = wristWidth * CUFF_THICKNESS;
  const half = wrist.halfWidth * CUFF_WIDEN;
  // 切口沿手臂往下挪一段，留出手腕
  const drop = wristWidth * CUFF_DROP;
  const cutX = wrist.cx + dx * drop;
  const cutY = wrist.cy + dy * drop;
  const big = img.w + img.h;
  const pt = (x: number, y: number): string => `${fmt(ox + x)},${fmt(oy + y)}`;
  /** 袖口局部坐标：`u` 沿法向（左右），`v` 沿手臂向（下为正）. */
  const at = (u: number, v: number): string =>
    pt(cutX + nx * u + dx * v, cutY + ny * u + dy * v);

  // 保留切口**以上**的半平面
  const clip = [at(big, 0), at(-big, 0), at(-big, -big), at(big, -big)].join(
    " ",
  );
  const clipId = `cuff${Math.round(wrist.cx)}_${Math.round(wrist.cy)}_${Math.round(half)}`;

  /** 一段袖筒；末端两角倒圆——直角会读成一块贴上去的色块. */
  const band = (from: number, to: number, fill: string): string => {
    const r = half * CUFF_CORNER;
    const d = [
      `M ${at(half, from)}`,
      `L ${at(-half, from)}`,
      `L ${at(-half, to - r)}`,
      `Q ${at(-half, to)} ${at(-half + r, to)}`,
      `L ${at(half - r, to)}`,
      `Q ${at(half, to)} ${at(half, to - r)}`,
      `Z`,
    ].join(" ");
    return `<path d="${d}" fill="${fill}"/>`;
  };

  const top = -thickness * CUFF_OVERLAP;
  const shadowFrom = thickness * (1 - CUFF_SHADOW_RATIO);
  const over =
    band(top, thickness, CUFF_FILL) + band(shadowFrom, thickness, CUFF_EDGE);

  return {
    clipId,
    defs: `<clipPath id="${clipId}"><polygon points="${clip}"/></clipPath>`,
    over,
  };
}

/** 手势贴图 SVG：把当前态的锚点对齐到 cue.x / cue.y. */
export function handCueSvg(cue: HandCue): string {
  const down = cue.lift <= DOWN_LIFT;
  const img = down ? cue.rt.draw : cue.rt.move;
  // 抬笔时整体轻微上移并放大：手离板面更远、离镜头更近
  const dy = cue.lift * 22 * (img.w / DEFAULT_HAND_SIZE);
  const scale = (1 + cue.lift * 0.05) * (cue.scale ?? 1);
  const mirror = cue.mirror === true ? " scale(-1,1)" : "";
  const op = cue.opacity ?? 1;
  const opAttr = op >= 1 ? "" : ` opacity="${fmt(op)}"`;
  // 袖口量不出手腕时退回接出画面：宁可手臂长，也不要在错的地方切一刀
  const noArm = cue.rt.armMode === "none";
  const cuff = cue.rt.armMode === "cuff" ? cuffSvg(img) : null;
  const clipAttr = cuff === null ? "" : ` clip-path="url(#${cuff.clipId})"`;
  return [
    `<g${opAttr} transform="translate(${fmt(cue.x)},${fmt(cue.y - dy)}) rotate(${fmt(cue.rotDeg ?? 0)}) scale(${fmt(scale)})${mirror}">`,
    cuff?.defs ?? "",
    `<image${clipAttr} href="${img.uri}" x="${fmt(-img.tipX)}" y="${fmt(-img.tipY)}" width="${fmt(img.w)}" height="${fmt(img.h)}"/>`,
    // 延长带画在贴图**之后**：盖住素材里那段渐尖收笔的小臂，silhouette 才是等宽的
    cuff === null && !noArm ? armExtensionSvg(img) : "",
    cuff?.over ?? "",
    `</g>`,
  ].join("");
}

/**
 * 手部贴图 SVG：把当前态的笔尖点对齐到 pose.x / pose.y。
 *
 * 落笔（lift ≤ 0.02）用 draw 图，抬笔移动用 move 图——两张图的手型不同，
 * 切换本身就是"压下 / 提起"的动作，比给同一张图加位移自然得多。
 */
export function handSvg(pose: PenPose, rt: HandRuntime): string {
  return handCueSvg({ rt, x: pose.x, y: pose.y, lift: pose.lift });
}

/** 目录里已下全分辨率手的分组概览（挑素材用）. */
export function handGroups(sparkolDir: string): Map<string, number> {
  const m = new Map<string, number>();
  if (!existsSync(sparkolDir)) return m;
  for (const entry of readdirSync(sparkolDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // pens 只有笔没有手，listHands 已排除，这里也不该计入
    if (entry.name === "thumbs" || entry.name === "pens") continue;
    const n = readdirSync(join(sparkolDir, entry.name)).filter((f) =>
      f.endsWith("-draw.png"),
    ).length;
    if (n > 0) m.set(basename(entry.name), n);
  }
  return m;
}
