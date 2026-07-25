/**
 * PoC: 手势动作系统（写字之外的那些手）
 *
 * 白板视频里手只干一件事（握笔写）就太单薄了。VideoScribe 的素材库其实
 * 按**动作**分了几类，同一个人（persona）各有一套：
 *
 * | 角色     | 素材命名                     | 锚点含义       | 讲什么 |
 * |----------|------------------------------|----------------|--------|
 * | `write`  | `<p>-<tool>`（marker/pencil…）| 笔尖着纸点     | 从零画出来 |
 * | `erase`  | `<p>-adult-eraser`           | 擦头接触面     | 推翻/否定/修正 |
 * | `carry`  | `<p>-adult-move-in-hand`     | **被搬物**落点 | 引入外部素材（照片/图表/logo） |
 * | `point`  | `<p>-adult-move-in-finger`   | 指尖           | 指示/强调/点数 |
 *
 * ## 两条必须分开的锚点规则
 *
 * `write`/`erase`/`point` 的接触点在**像素里**（笔尖、擦头、指尖都是不透明
 * 区域朝某个角的最外沿），alpha 实测最准（见 hand.ts）。
 *
 * `carry` 不同：`move-in-hand` 声明的偏移是 `(-134,-20)` 这种大负值，落在
 * 图**外**——因为它标的不是手上的某个点，而是"被搬的东西该放在哪"。这类
 * 只能用声明值，实测无从下手。
 *
 * ## 尺寸按高度对齐，不按宽度
 *
 * 这些素材的原图宽度差得很远（书写手 768、`move-in-hand` 只有 289，因为
 * 竖着的掌心横向占不了多少），按宽度归一会把掌心那张放大到荒谬的比例。
 * 按**手臂高度**归一，同一个人的各种手势才是同一条手臂。
 *
 * ## 手势线索（HandCue）与帧装配
 *
 * 书写手由 `penPoseAt` 从"哪个元素正在被画"反推；手势手则由手势元素自己
 * 给出 `hand(t)`。帧装配的规则是**手势优先**：任一手势元素在当帧给出线索
 * 就画它，否则回退书写手。同一时刻不出现两只手（一个人只有一双手，两只
 * 手同时出现在白板上会立刻出戏）。
 *
 * ## 还能加的动作（都能用现有素材拼出来，按"这个动作能讲什么"排）
 *
 * - **换笔换色**：`write` 角色按墨色挑素材已经做了（{@link pickGesture}）。
 *   再往上一层是"叙事分色"——正文黑、结论红、旁注蓝，换色时让手带着新颜色
 *   的笔从画面外进来，观众自然知道要换个层次讲了。
 * - **划掉**（`write` + 一条横杠）：比擦除更轻的否定。擦掉是"这条不算了"，
 *   划掉是"这条我保留着让你看见它被否了"——留痕本身是信息。
 * - **圈注**（`write` + 椭圆）：留痕的强调，和 {@link pointEl} 的不留痕强调
 *   互补。要观众记住 → 圈注；只要观众此刻看一眼 → 点指。
 * - **搬走**（`carry` 反向）：`carryInEl` 的时间轴倒过来，把落位的东西端出
 *   画面。用于"这一段讲完了，收走，换下一个"，比直接淡出更有交接感。
 * - **拖动重排**（`carry` 两点之间）：把已经在板上的元素移到新位置，用来
 *   表达"这两件事其实该放在一起"。
 * - **递进指数**（`point` 连点多处）：指着 1、2、3 依次点，配合口播数点。
 * - **整板擦净**（`erase` 全画幅 + 多行）：章节切换。比运镜切场更"白板"，
 *   因为它承认了前一段的存在再把它清掉。
 * - **手掌压平**（`carry` 的 draw 态停在原处轻压）：给刚搬进来的东西"按实"，
 *   一个很短的收尾动作，能显著减少"图是凭空贴上去的"感觉。
 *
 * 素材侧的边界：`move-in-*` 每人只有一张图（没有 `-move` 态），所以搬移类
 * 动作的手型是固定的，只能靠位置/旋转/镜像做出变化；`Seasonal` 组里还有
 * 骷髅手、女巫手、板刷（`board-wiper`）这类，能用但会带很强的节日语气，
 * 默认不进清单（见 {@link listGestures}）。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  clamp01,
  cumLengths,
  easeInOutSine,
  easeOutCubic,
  fmt,
  pointAtLength,
  polylineAttr,
  slicePolyline,
} from "../whiteboard/index";
import type { Pt, TimelineEl } from "../whiteboard/index";
import {
  ARM_DISPLAY_HEIGHT,
  DEFAULT_ARM_MODE,
  canvasHandScale,
  pngSize,
  prepareImage,
} from "./hand";
import type {
  AnchorMode,
  ArmMode,
  HandCue,
  HandImage,
  HandTwoState,
} from "./hand";

/** 手势角色（决定锚点语义与可用的动画）. */
export type GestureRole = "write" | "erase" | "carry" | "point";

/** 角色 → 锚点来源. */
const ROLE_ANCHOR: Record<GestureRole, AnchorMode> = {
  write: "nib",
  erase: "nib",
  carry: "declared",
  point: "nib",
};

export interface GestureAsset {
  role: GestureRole;
  /** 人物组（matt / hannah / suneeta …）——同一个人各角色要配套用. */
  persona: string;
  slug: string;
  name: string;
  drawPath: string;
  /** 无 `-move.png` 的素材（move-in 类）回退到 draw. */
  movePath: string;
  drawAnchor: readonly [number, number];
  moveAnchor: readonly [number, number];
  width: number;
  height: number;
  /** 笔具种类（role=write）. */
  tool?: string;
  /** 笔具颜色（role=write，从 slug 认出来的）. */
  inkHex?: string;
}

interface RawHand {
  name: string;
  group?: string;
  slug: string;
  handBehind?: boolean;
  drawOffset?: [number, number];
  moveOffset?: [number, number];
}

/** slug 里的笔具关键词 → 规范笔具名（顺序敏感：先长后短）. */
const TOOL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/paint-brush/, "brush"],
  [/fountain-pen/, "fountain-pen"],
  [/ball-pen|ballpoint/, "ball-pen"],
  [/sharpie/, "sharpie"],
  [/marker/, "marker"],
  [/pencil/, "pencil"],
  [/crayon/, "crayon"],
  [/chalk/, "chalk"],
  [/biro/, "biro"],
];

/**
 * slug 里的颜色词 → 墨色。
 *
 * 这是"笔具↔墨色"这条线的关键：观众会把手里那支笔的颜色和纸上的笔迹
 * 颜色联系起来，红笔画黑线会立刻显假。所以选笔要按要画的墨色来选。
 */
const COLOR_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bblack\b|black-/, "#22262b"],
  [/\bblue\b|blue-/, "#2452c8"],
  [/\bred\b|red-/, "#c8362c"],
  [/\bgreen\b|green-/, "#1f8a54"],
  [/\borange\b|orange-/, "#e0761c"],
  [/\bwhite\b|white-/, "#f4f4f2"],
  [/\bsilver\b|silver-/, "#8b929b"],
];

function classify(slug: string): GestureRole | null {
  if (/-move-in-(hand|hands)$/.test(slug)) return "carry";
  if (/-move-in-(finger|fingers)$/.test(slug)) return "point";
  if (/-eraser$/.test(slug)) return "erase";
  return "write";
}

/** 从 slug 猜笔具与墨色（认不出就不填，调用方按默认处理）. */
function toolOf(slug: string): { tool?: string; inkHex?: string } {
  const out: { tool?: string; inkHex?: string } = {};
  for (const [re, name] of TOOL_WORDS) {
    if (re.test(slug)) {
      out.tool = name;
      break;
    }
  }
  for (const [re, hex] of COLOR_WORDS) {
    if (re.test(slug)) {
      out.inkHex = hex;
      break;
    }
  }
  return out;
}

/**
 * 列出本地已下、可用的全部手势素材（含书写手）。
 *
 * 与 hand.ts 的 `listHands` 的区别：那个只要"能写字的手"，会把 move-in /
 * eraser 全部过滤掉；这里要的正是它们。
 */
export function listGestures(sparkolDir: string): GestureAsset[] {
  const idxPath = join(sparkolDir, "hands-index.json");
  if (!existsSync(idxPath)) return [];
  let raw: RawHand[];
  try {
    raw = JSON.parse(readFileSync(idxPath, "utf8")) as RawHand[];
  } catch {
    return [];
  }
  const out: GestureAsset[] = [];
  const seen = new Set<string>();
  for (const h of raw) {
    const persona = h.group ?? "";
    // pens 组只有笔没有手（拿不出手势）；Seasonal 是万圣节骷髅手之类，
    // 混进正片会很突兀，要用得显式点名，不进默认清单
    if (persona === "" || persona === "pens" || persona === "Seasonal") {
      continue;
    }
    const role = classify(h.slug);
    if (role === null) continue;
    const key = `${persona}/${h.slug}`;
    if (seen.has(key)) continue;
    const drawPath = join(sparkolDir, persona, `${h.slug}-draw.png`);
    if (!existsSync(drawPath)) continue;
    const size = pngSize(drawPath);
    if (size === null) continue;
    seen.add(key);
    const movePath = join(sparkolDir, persona, `${h.slug}-move.png`);
    out.push({
      role,
      persona,
      slug: h.slug,
      name: h.name,
      drawPath,
      movePath: existsSync(movePath) ? movePath : drawPath,
      drawAnchor: h.drawOffset ?? [0, 0],
      moveAnchor: h.moveOffset ?? h.drawOffset ?? [0, 0],
      width: size.w,
      height: size.h,
      ...(role === "write" ? toolOf(h.slug) : {}),
    });
  }
  return out;
}

export interface GestureRuntime extends HandTwoState {
  asset: GestureAsset;
}

export interface LoadGestureOpts {
  /** 画幅宽度. */
  canvasWidth: number;
  /** 画幅高度（与宽度一起决定手的大小，按短边归一）. */
  canvasHeight?: number;
  /** 1080 短边画幅下的手臂显示高度. Default {@link ARM_DISPLAY_HEIGHT}. */
  armHeight?: number;
  /** 手臂怎么收尾. Default {@link DEFAULT_ARM_MODE}. */
  armMode?: ArmMode;
}

/** 装载一个手势素材（按手臂高度归一，见模块注释）. */
export function loadGesture(
  asset: GestureAsset,
  o: LoadGestureOpts,
): GestureRuntime {
  const targetH =
    (o.armHeight ?? ARM_DISPLAY_HEIGHT) *
    canvasHandScale(o.canvasWidth, o.canvasHeight);
  const mode = ROLE_ANCHOR[asset.role];
  const mk = (path: string, anchor: readonly [number, number]): HandImage => {
    const size = pngSize(path) ?? { w: asset.width, h: asset.height };
    return prepareImage(path, size.w, size.h, targetH / size.h, anchor, mode);
  };
  return {
    asset,
    draw: mk(asset.drawPath, asset.drawAnchor),
    move: mk(asset.movePath, asset.moveAnchor),
    armMode: o.armMode ?? DEFAULT_ARM_MODE,
  };
}

/** sRGB 距离（选笔用；感知精度不重要，只要"蓝配蓝、黑配黑"）. */
function hexDist(a: string, b: string): number {
  const p = (s: string): [number, number, number] => [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * 未指定笔具时的挑选顺序（越前越"像白板"）。
 *
 * 白板的原生笔具是马克笔/记号笔——粗、不透明、一笔就是一条带。圆珠笔和
 * 铅笔属于纸，它们画不出画面上那种粗笔迹，手里拿着它却出来一条 13px 宽
 * 的黑带，观众第一眼就觉得不对。
 */
const WRITE_TOOL_PREFERENCE = [
  "marker",
  "sharpie",
  "brush",
  "chalk",
  "crayon",
  "pencil",
  "fountain-pen",
  "biro",
  "ball-pen",
] as const;

export interface PickOpts {
  persona?: string;
  role?: GestureRole;
  /** 要画的墨色（role=write 时按它挑最接近的笔）. */
  ink?: string;
  /** 指定笔具（marker/pencil/chalk/…）. */
  tool?: string;
}

/**
 * 挑一个手势素材。
 *
 * `write` 角色额外按墨色排序 —— 手里的笔和纸上的颜色必须对得上。
 */
export function pickGesture(
  assets: readonly GestureAsset[],
  o: PickOpts,
): GestureAsset | null {
  const role = o.role ?? "write";
  let pool = assets.filter((a) => a.role === role);
  if (o.persona !== undefined) {
    const mine = pool.filter((a) => a.persona === o.persona);
    // 该人物缺这个角色的素材时退回全库，而不是返回 null：宁可换个人的
    // 手，也不要整个动作消失
    if (mine.length > 0) pool = mine;
  }
  if (o.tool !== undefined) {
    const t = pool.filter((a) => a.tool === o.tool);
    if (t.length > 0) pool = t;
  } else if (role === "write") {
    // 没指定笔具时按"像白板"的程度排：马克笔/记号笔是白板的原生笔具，
    // 圆珠笔和铅笔是纸的笔具——它们画不出这么粗的笔迹，观众会觉得别扭。
    for (const tool of WRITE_TOOL_PREFERENCE) {
      const t = pool.filter((a) => a.tool === tool);
      if (t.length > 0) {
        pool = t;
        break;
      }
    }
  }
  if (pool.length === 0) return null;
  if (role === "erase") {
    // 同一个人常有两件擦除素材：`-adult-eraser`（手握板擦）和
    // `-pencil-eraser`（用铅笔尾部的小橡皮）。板擦的动作幅度大、读得清，
    // 铅笔尾橡皮在 1080 宽的画面上几乎看不出在擦什么——默认选板擦。
    const block = pool.filter((a) => !/pencil-eraser$/.test(a.slug));
    if (block.length > 0) pool = block;
  }
  if (role !== "write" || o.ink === undefined) return pool[0]!;
  const ink = o.ink;
  return [...pool].sort(
    (a, b) =>
      hexDist(a.inkHex ?? "#000000", ink) - hexDist(b.inkHex ?? "#000000", ink),
  )[0]!;
}

/** 一个人物的整套手势（缺的角色为 null，调用方降级处理）. */
export interface HandKit {
  persona: string;
  write: GestureRuntime | null;
  erase: GestureRuntime | null;
  carry: GestureRuntime | null;
  point: GestureRuntime | null;
}

/**
 * 装载一个人物的整套手势。
 *
 * @param ink 要画的墨色（决定 write 角色挑哪支笔）
 */
export function loadHandKit(
  assets: readonly GestureAsset[],
  persona: string,
  ink: string,
  o: LoadGestureOpts,
): HandKit {
  const get = (role: GestureRole): GestureRuntime | null => {
    const a = pickGesture(assets, { persona, role, ink });
    return a === null ? null : loadGesture(a, o);
  };
  return {
    persona,
    write: get("write"),
    erase: get("erase"),
    carry: get("carry"),
    point: get("point"),
  };
}

// ---- 手势元素 ----

/**
 * 带手势的时间轴元素：在 `TimelineEl` 上加一个 `hand(t)`。
 *
 * 为什么不复用 `pen(t)`：`penPoseAt` 会把所有 `pen` 元素串成一条连续的
 * 笔轨迹（含元素之间的提笔走位、结尾的退场滑出）。手势不属于那条轨迹
 * ——一只搬东西的手不该"从上一个字的末尾飞过来"，它是从画面外直接进来
 * 的。所以手势自带位置，不参与笔的运动学。
 */
export interface GestureEl extends TimelineEl {
  hand?(t: number): HandCue | null;
  /**
   * 笔轨迹的有效区间，当它与 `[t0, t1]` 不同时给出。
   *
   * 需要它是因为 `penPoseAt` 用元素的 `t0`/`t1` 当作笔的活跃区间，并且在
   * 端点上**强制解包** `pen(t)`。而 {@link eraseEl} 这类包裹型元素的生命
   * 期要盖到"擦完"，比里面那支笔实际写字的时间长得多——不区分的话，擦完
   * 之后书写手会回到最后一个字上悬着不动（视频里能直接看到）。
   */
  penSpan?: readonly [number, number];
}

/**
 * 收集可交给 `penPoseAt` 的笔描元素（按 t0 升序）。
 *
 * 带 `penSpan` 的元素被替换成一个只暴露笔区间的轻量代理，`penPoseAt`
 * 因此不需要知道 `penSpan` 的存在。
 */
export function penElements(els: readonly GestureEl[]): TimelineEl[] {
  const out: TimelineEl[] = [];
  for (const el of els) {
    if (el.pen === undefined) continue;
    const span = el.penSpan;
    if (span === undefined) {
      out.push(el);
      continue;
    }
    if (span[1] <= span[0]) continue;
    out.push({
      t0: span[0],
      t1: span[1],
      svg: () => "",
      pen: (t) => el.pen!(t),
    });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** 从一组元素里取当帧生效的手势线索（多个同时生效时取最后一个）. */
export function activeHandCue(
  els: readonly GestureEl[],
  t: number,
): HandCue | null {
  let hit: HandCue | null = null;
  for (const el of els) {
    if (el.hand === undefined) continue;
    const cue = el.hand(t);
    if (cue !== null) hit = cue;
  }
  return hit;
}

/** 入场方向. */
export type FromSide = "left" | "right" | "top" | "bottom";

/** 入场方向 → 画面外起点的单位方向（指向画面外）. */
function outward(side: FromSide): Pt {
  switch (side) {
    case "left":
      return [-1, 0.28];
    case "right":
      return [1, 0.28];
    case "top":
      return [0.18, -1];
    case "bottom":
      return [0.18, 1];
  }
}

export interface CarryInOpts {
  /** 图片 URI（data: 内联，或帧渲染器能解析的相对路径）. */
  href: string;
  /** 落位框（画布坐标，左上角 + 尺寸）. */
  x: number;
  y: number;
  w: number;
  h: number;
  t0: number;
  /** 搬入行程时长. Default 1.15. */
  dur?: number;
  /** 落位后撤手时长. Default 0.5. */
  release?: number;
  /** 从哪一侧搬进来. Default "right". */
  from?: FromSide;
  /** 搬移手（`carry` 角色；缺素材时传 null → 只有图片滑入，没有手）. */
  hand: GestureRuntime | null;
  /** 画布尺寸（算画面外起点用）. */
  canvasW: number;
  canvasH: number;
  /** 落位后是否画一个手绘框（把外部图片"收"进白板语言里）. */
  frame?: { color: string; width: number };
}

/** 落位过冲：冲过 3% 再回弹，"放下"才有重量. */
const SETTLE_OVERSHOOT = 0.03;

/**
 * 外部图片引入手势：手托着图片从画面外移入落位，然后撤手。
 *
 * 这是"引用外部素材"的专用动作 —— 白板上的东西要么是**画**出来的（笔），
 * 要么是**搬**进来的（手）。一张照片/logo/截图不可能被马克笔画出来，硬
 * 让笔去"扫"它会露馅；搬进来才自洽。
 *
 * 时间线：`[t0, t0+dur]` 行程 → `[t0+dur, t0+dur+release]` 撤手 → 之后定格。
 */
/** carryInEl 的产物：额外报出"落位完成"的时刻（撤手在这之后）. */
export interface CarryElement extends GestureEl {
  landedAt: number;
}

export function carryInEl(o: CarryInOpts): CarryElement {
  const dur = o.dur ?? 1.15;
  const release = o.release ?? 0.5;
  const from = o.from ?? "right";
  const t1 = o.t0 + dur;
  const tEnd = t1 + release;

  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  // 画面外起点：沿出画方向推到"整张图完全在画面外"再多留一点
  const [ox, oy] = outward(from);
  const travel =
    Math.abs(ox) * (o.canvasW / 2 + o.w) + Math.abs(oy) * (o.canvasH / 2 + o.h);
  const startX = cx + ox * travel;
  const startY = cy + oy * travel;

  /** 行程进度 p → 图片中心（含落位过冲）. */
  const centerAt = (p: number): Pt => {
    // 末段 12% 冲过目标 3% 再退回来 —— "放下"这个动作要有重量
    const back =
      p > 0.88 ? Math.sin(((p - 0.88) / 0.12) * Math.PI) * SETTLE_OVERSHOOT : 0;
    const k = easeOutCubic(p) + back;
    return [startX + (cx - startX) * k, startY + (cy - startY) * k];
  };

  /**
   * 手的锚点相对被搬物中心的偏移。
   *
   * `move-in-hand` 声明的锚点在掌心的**左上方**（`matt` 是 `(-134,-20)`，
   * 图宽只有 289）——它标的就是"被搬的东西放这儿"，也就是说素材本身表达
   * 的是「手在物件的右下方托着它」。所以锚点基本就落在物件中心：
   * 从右侧入场直接用原图，从左侧入场镜像。
   *
   * 早先版本把锚点放在物件靠入场那一侧的**边**上（`w*0.34`），结果整只手
   * 被推到物件外侧一个手宽的位置，横屏下直接掉出画面 —— 一帧都看不见手。
   */
  const gripOffset = (): Pt => {
    switch (from) {
      case "right":
        return [o.w * 0.06, o.h * 0.04];
      case "left":
        return [-o.w * 0.06, o.h * 0.04];
      case "bottom":
        return [o.w * 0.04, o.h * 0.06];
      case "top":
        return [o.w * 0.04, -o.h * 0.06];
    }
  };

  const imgSvg = (c: Pt, opacity: number): string => {
    const op = opacity >= 1 ? "" : ` opacity="${fmt(opacity)}"`;
    const fx = c[0] - o.w / 2;
    const fy = c[1] - o.h / 2;
    const frame =
      o.frame === undefined
        ? ""
        : `<rect x="${fmt(fx)}" y="${fmt(fy)}" width="${fmt(o.w)}" height="${fmt(o.h)}" fill="none" stroke="${o.frame.color}" stroke-width="${fmt(o.frame.width)}" stroke-linejoin="round"/>`;
    return (
      `<g${op}><image href="${o.href}" x="${fmt(fx)}" y="${fmt(fy)}" ` +
      `width="${fmt(o.w)}" height="${fmt(o.h)}" preserveAspectRatio="xMidYMid meet"/>${frame}</g>`
    );
  };

  const el: CarryElement = {
    t0: o.t0,
    t1: tEnd,
    landedAt: t1,
    bbox: [o.x - 40, o.y - 40, o.x + o.w + 40, o.y + o.h + 40],
    svg(t) {
      if (t < o.t0) return "";
      if (t >= t1) return imgSvg([cx, cy], 1);
      return imgSvg(centerAt(clamp01((t - o.t0) / dur)), 1);
    },
    hand(t) {
      if (o.hand === null || t < o.t0 || t > tEnd) return null;
      const [gx, gy] = gripOffset();
      if (t <= t1) {
        const c = centerAt(clamp01((t - o.t0) / dur));
        return {
          rt: o.hand,
          x: c[0] + gx,
          y: c[1] + gy,
          // 搬运途中手一直离板一段距离（它托着东西，不是压在板上）
          lift: 0.55,
          mirror: from === "left",
        };
      }
      // 撤手：沿入场方向退出去并淡出。
      //
      // 撤手行程不能用入场那个 travel（它是"整张图移出画面"的距离，
      // 上千像素）——撤手只有半秒，走那么远等于第一帧就消失了，看不出
      // 是"松手退开"。按手臂宽度量级走一段就够读出动作。
      const p = easeInOutSine(clamp01((t - t1) / release));
      const pull = Math.max(320, o.w * 0.8);
      return {
        rt: o.hand,
        x: cx + gx + ox * pull * p,
        y: cy + gy + oy * pull * p,
        lift: 0.55 + p * 0.45,
        mirror: from === "left",
        opacity: 1 - p * 0.85,
      };
    },
  };
  return el;
}

/** 擦拭轨迹的横向外扩（相对行高）——不外扩会在两端留下没擦净的竖边. */
const SCRUB_BLEED = 0.55;

/** 蛇形擦拭路径（橡皮擦是来回搓，不是一笔扫过去）. */
function scrubPath(
  x: number,
  y: number,
  w: number,
  h: number,
  rows: number,
  bleedPx?: number,
): Pt[] {
  const rowH = h / rows;
  const bleed = bleedPx ?? rowH * SCRUB_BLEED;
  const pts: Pt[] = [];
  for (let r = 0; r < rows; r++) {
    const yy = y + (r + 0.5) * rowH;
    const ltr = r % 2 === 0;
    pts.push(
      [ltr ? x - bleed : x + w + bleed, yy],
      [ltr ? x + w + bleed : x - bleed, yy],
    );
  }
  return pts;
}

export interface EraseOpts {
  /**
   * 被擦掉的元素。
   *
   * 注意调用方要用 eraseEl **替换**掉 target（而不是两个都放进场景），
   * 否则未被包裹的那一份会照常画出来，永远擦不掉。
   */
  target: TimelineEl;
  /** 擦除区域（画布坐标）. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 开始擦的时刻（此前 target 原样显示）. */
  t0: number;
  /** 擦除时长. Default 1.0. */
  dur?: number;
  /** 来回行数. Default 3. */
  rows?: number;
  /** 橡皮擦手（缺素材时 null → 只有内容消失，没有手）. */
  hand: GestureRuntime | null;
  /** 擦完留下的残影不透明度（真擦不干净）. Default 0.1. */
  ghost?: number;
  /** mask id 前缀（同帧唯一）. */
  idp: string;
}

/**
 * 橡皮擦手势：把已经画好的东西擦掉。
 *
 * 用途是叙事上的**否定**——"假设我们这样做…（画）…但这行不通（擦）"。
 * 这个动作能表达的东西笔画不出来：观众看到擦除，就知道前面那句是要被
 * 推翻的假设，而不是结论。
 *
 * 实现：把 target 的输出包进一个遮罩里，遮罩 = 白底矩形 − 已走过的擦拭
 * 轨迹（黑）。擦完之后按 `ghost` 留一层淡淡的残影（板擦擦不净是常识，
 * 完全消失反而假）。
 */
/** eraseEl 的产物：额外报出擦除动作自身的区间. */
export interface EraseElement extends GestureEl {
  /**
   * 擦除动作的起止（秒）。
   *
   * 元素的 `t0`/`t1` 是**被包裹内容**的时间轴（帧渲染器按它判断入场），
   * 与擦除动作的区间不是一回事——调用方要接着排下一拍时用这两个。
   */
  eraseT0: number;
  eraseT1: number;
}

export function eraseEl(o: EraseOpts): EraseElement {
  const dur = o.dur ?? 1.0;
  const rows = o.rows ?? 3;
  const ghost = o.ghost ?? 0.1;
  const t1 = o.t0 + dur;
  const rowH = o.h / rows;
  // 擦头宽度要略大于行高，相邻行才能压住彼此的边界
  const scrubW = rowH * 1.35;
  const pts = scrubPath(o.x, o.y, o.w, o.h, rows);
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;
  const pad = scrubW;

  const el: EraseElement = {
    // t0 必须是 target 的起点：帧渲染器按 [t0,t1] 判断元素是否入场，
    // 若从擦除时刻起算，被包裹的内容在擦之前会整段消失
    t0: o.target.t0,
    t1: Math.max(o.target.t1, t1),
    eraseT0: o.t0,
    eraseT1: t1,
    bbox: o.target.bbox,
    svg(t) {
      const inner = o.target.svg(t);
      if (inner === "") return "";
      if (t < o.t0) return inner;
      if (t >= t1) {
        return ghost <= 0 ? "" : `<g opacity="${fmt(ghost)}">${inner}</g>`;
      }
      const drawn = easeInOutSine(clamp01((t - o.t0) / dur)) * total;
      const part = slicePolyline(pts, cum, drawn);
      const box =
        `x="${fmt(o.x - pad)}" y="${fmt(o.y - pad)}" ` +
        `width="${fmt(o.w + pad * 2)}" height="${fmt(o.h + pad * 2)}"`;
      const scrub = (color: string): string =>
        part.length < 2
          ? ""
          : `<polyline points="${polylineAttr(part)}" fill="none" stroke="${color}" ` +
            `stroke-width="${fmt(scrubW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      // 两个互补遮罩：擦过的地方只剩残影，没擦到的地方原样
      const keep =
        `<mask id="${o.idp}erK" maskUnits="userSpaceOnUse" ${box}>` +
        `<rect ${box} fill="#fff"/>${scrub("#000")}</mask>`;
      const gone =
        ghost <= 0 || part.length < 2
          ? ""
          : `<mask id="${o.idp}erG" maskUnits="userSpaceOnUse" ${box}>` +
            `<rect ${box} fill="#000"/>${scrub("#fff")}</mask>`;
      return (
        keep +
        gone +
        `<g mask="url(#${o.idp}erK)">${inner}</g>` +
        (gone === ""
          ? ""
          : `<g opacity="${fmt(ghost)}" mask="url(#${o.idp}erG)">${inner}</g>`)
      );
    },
    hand(t) {
      if (o.hand === null || t < o.t0 || t > t1) return null;
      const drawn = easeInOutSine(clamp01((t - o.t0) / dur)) * total;
      const p = pointAtLength(pts, cum, drawn);
      return { rt: o.hand, x: p[0], y: p[1], lift: 0 };
    },
  };
  // 被包裹的元素若本来是笔描的，它的笔轨迹要继续透出去 —— 否则书写手
  // 不知道这行字正在被写，会提前退场。
  //
  // 但笔的区间只到"开始擦"为止（`penSpan`）：本元素的 t1 延到擦完，把笔
  // 一路带到那时会让擦完之后书写手回到最后一个字上悬着不动。擦除期间画面
  // 上的手由 hand(t) 接管，笔该在此之前正常退场。
  const inner = o.target.pen;
  if (inner !== undefined) {
    const penEnd = Math.min(o.target.t1, o.t0);
    el.penSpan = [o.target.t0, penEnd];
    el.pen = (t) => {
      if (t < o.target.t0 || t > penEnd) return null;
      return inner.call(o.target, t);
    };
  }
  return el;
}

export interface BoardWipeOpts {
  /** 擦除区域（通常是整幅画面）. */
  x: number;
  y: number;
  w: number;
  h: number;
  t0: number;
  /** 擦净时长. Default 1.4. */
  dur?: number;
  /**
   * 来回行数. Default 3。
   *
   * 少而宽，不是多而细：1.4 秒要盖满整幅画面，行数一多手就成了一道模糊的
   * 影子（8 行意味着橡皮擦要跑 12000px，10000px/s）。真人擦白板也是三四道
   * 大幅横扫，不是逐行搓。
   */
  rows?: number;
  /** 橡皮擦手（null → 内容照样被擦掉，只是没有手）. */
  hand: GestureRuntime | null;
  /** mask id 前缀（同帧唯一）. */
  idp: string;
}

/** boardWipeEl 的产物：额外给出当帧的擦除遮罩. */
export interface WipeElement extends GestureEl {
  /**
   * 当帧的擦除遮罩；null = 不在擦除中（内容原样画）。
   *
   * 由**调用方**把整段内容包进 `<g mask="url(#id)">` —— SVG 的遮罩必须在
   * 元素生成时就挂上，没法事后作用于已经输出的兄弟节点。所以整板擦净不能
   * 做成一个普通的时间轴元素，它得能影响别人的输出。
   */
  wipeMask(t: number): { defs: string; id: string } | null;
}

/**
 * 整板擦净：段与段之间的转场。
 *
 * 比硬切好的地方在于它**承认了前一段的存在**再把它清掉 —— 观众看到的是
 * "讲完了，擦掉，换下一个"，而不是画面凭空跳变。硬切在白板语境里尤其突兀：
 * 板上的东西是一笔一笔画上去的，凭空消失不符合这个世界的规则。
 *
 * 与 {@link eraseEl} 的分工：那个擦的是**某个元素**（叙事上的否定），这个
 * 擦的是**整块板面**（结构上的换页），两者语义不同，不该合成一个。
 */
export function boardWipeEl(o: BoardWipeOpts): WipeElement {
  const dur = o.dur ?? 1.4;
  const rows = o.rows ?? 3;
  const t1 = o.t0 + dur;
  const rowH = o.h / rows;
  const scrubW = rowH * 1.25;
  // 外扩必须**封顶**：整板擦净的行高有几百像素，按比例外扩会让每行两端各
  // 有 200px 在画外，橡皮擦有近三成时间是看不见的（一擦板手就不见了）。
  const pts = scrubPath(o.x, o.y, o.w, o.h, rows, Math.min(rowH * 0.2, 70));
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1]!;

  const el: WipeElement = {
    t0: o.t0,
    t1,
    // 自己不画任何东西：它的作用是给别人的输出套遮罩
    svg: () => "",
    wipeMask(t) {
      if (t < o.t0) return null;
      const id = `${o.idp}bw`;
      const box =
        `x="${fmt(o.x - scrubW)}" y="${fmt(o.y - scrubW)}" ` +
        `width="${fmt(o.w + scrubW * 2)}" height="${fmt(o.h + scrubW * 2)}"`;
      if (t >= t1) {
        // 擦完：全黑遮罩 = 内容全部消失（比让调用方去判断 t 更省心）
        return {
          defs: `<mask id="${id}" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="#000"/></mask>`,
          id,
        };
      }
      const drawn = easeInOutSine(clamp01((t - o.t0) / dur)) * total;
      const part = slicePolyline(pts, cum, drawn);
      const cut =
        part.length < 2
          ? ""
          : `<polyline points="${polylineAttr(part)}" fill="none" stroke="#000" ` +
            `stroke-width="${fmt(scrubW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return {
        defs:
          `<mask id="${id}" maskUnits="userSpaceOnUse" ${box}>` +
          `<rect ${box} fill="#fff"/>${cut}</mask>`,
        id,
      };
    },
    hand(t) {
      if (o.hand === null || t < o.t0 || t > t1) return null;
      const drawn = easeInOutSine(clamp01((t - o.t0) / dur)) * total;
      const p = pointAtLength(pts, cum, drawn);
      return { rt: o.hand, x: p[0], y: p[1], lift: 0 };
    },
  };
  return el;
}

export interface PointOpts {
  /** 指示点（画布坐标）. */
  x: number;
  y: number;
  t0: number;
  /** 停留时长（含入场与撤手）. Default 1.3. */
  dur?: number;
  /** 点几下. Default 2. */
  taps?: number;
  /** 指示手（`point` 角色）. */
  hand: GestureRuntime | null;
  /** 从哪一侧伸进来. Default "bottom". */
  from?: FromSide;
  canvasW: number;
  canvasH: number;
  /** 点到时向外扩散的强调环（null = 不要）. */
  ring?: { color: string; r: number; width: number } | null;
}

/** 入场/撤手各占停留时长的比例. */
const POINT_IN = 0.28;
const POINT_OUT = 0.22;

/**
 * 指示/强调手势：伸出食指点在某处，点两下，再撤走。
 *
 * 它替代的是"画个圈圈起来"——圈注是**留痕**的强调（画面上多了一笔），
 * 点指是**不留痕**的强调。当你只想让观众看一眼已经画好的东西（而不是
 * 给它加装饰）时，点指才是对的动作。
 */
export function pointEl(o: PointOpts): GestureEl {
  const dur = o.dur ?? 1.3;
  const taps = o.taps ?? 2;
  const from = o.from ?? "bottom";
  const t1 = o.t0 + dur;
  const [ox, oy] = outward(from);
  const travel =
    Math.abs(ox) * (o.canvasW / 2 + 200) + Math.abs(oy) * (o.canvasH / 2 + 200);

  /** 相对进度 p → 距目标的偏移比例（1 = 还在画面外）. */
  const offsetK = (p: number): number => {
    if (p < POINT_IN) return 1 - easeOutCubic(p / POINT_IN);
    if (p > 1 - POINT_OUT)
      return easeInOutSine((p - (1 - POINT_OUT)) / POINT_OUT);
    return 0;
  };

  /** 点按动作：停留期内 lift 在 0..0.3 之间上下 `taps` 次. */
  const tapLift = (p: number): number => {
    if (p < POINT_IN || p > 1 - POINT_OUT) return 0.4;
    const q = (p - POINT_IN) / (1 - POINT_IN - POINT_OUT);
    return 0.15 - 0.15 * Math.cos(2 * Math.PI * taps * q);
  };

  const el: GestureEl = {
    t0: o.t0,
    t1,
    bbox: [o.x - 260, o.y - 260, o.x + 260, o.y + 260],
    svg(t) {
      if (o.ring == null || t < o.t0 || t > t1) return "";
      const p = clamp01((t - o.t0) / dur);
      if (p < POINT_IN || p > 1 - POINT_OUT) return "";
      const q = (p - POINT_IN) / (1 - POINT_IN - POINT_OUT);
      // 每次点按各放一圈涟漪
      const parts: string[] = [];
      for (let k = 0; k < taps; k++) {
        const local = clamp01(q * taps - k);
        if (local <= 0 || local >= 1) continue;
        const e = easeOutCubic(local);
        parts.push(
          `<circle cx="${fmt(o.x)}" cy="${fmt(o.y)}" r="${fmt(o.ring.r * (0.3 + e * 0.7))}" ` +
            `fill="none" stroke="${o.ring.color}" stroke-width="${fmt(o.ring.width)}" ` +
            `opacity="${fmt(0.55 * (1 - e))}"/>`,
        );
      }
      return parts.join("");
    },
    hand(t) {
      if (o.hand === null || t < o.t0 || t > t1) return null;
      const p = clamp01((t - o.t0) / dur);
      const k = offsetK(p);
      return {
        rt: o.hand,
        x: o.x + ox * travel * k,
        y: o.y + oy * travel * k,
        lift: tapLift(p),
        mirror: from === "left",
      };
    },
  };
  return el;
}
