/**
 * @module core/whiteboard-video/shapes
 *
 * 设计稿 §4「主要元素样式」：容器（矩形框/圆角框/云朵框/对话框/便签纸）与
 * 连接件（箭头/曲线箭头/虚线箭头/大括号/星形标注）。
 *
 * ## 为什么容器比配色更要紧
 *
 * 现状的板面是"文字裸排在白底上"，一段里的标题、要点、插图之间没有任何
 * 分组信号，读者得自己猜哪几行是一组。容器是最廉价的分组手段——一个框把
 * 三行圈起来，胜过任何对齐微调。
 *
 * ## 全部返回折线组，不返回 SVG 字符串
 *
 * 这些函数只算**几何**（`Pt[][]`），交给 marker.ts 的笔迹带去描。所以每个
 * 形状都自动获得：手抖、逐笔书写动画、笔尖跟随、可换色换粗细。如果这里直接
 * 吐 `<path>`，就得为每个形状再实现一遍书写动画。
 *
 * 例外是便签纸（{@link stickyNoteSvg}）——它有实心底色，本质是"贴上去的
 * 一张纸"而不是"画出来的一个框"，走淡入贴入而不是笔描。
 */

import type { Pt } from "../whiteboard/index";
import { arrowHead, ellipsePts, fmt } from "../whiteboard/index";

/** 矩形框（设计稿 §4「矩形框」）：一笔画完，收笔在起点处拐过一点. */
export function rectPath(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y + h * 0.004],
    [x + w * 0.055, y - h * 0.004],
  ];
}

/**
 * 圆角框（设计稿 §4「圆角框」）：四条边 + 四个角的圆弧采样。
 *
 * 圆角半径默认取短边的 14%，并且**上限 32px**：半径随框等比放大时，一个很
 * 宽的框会变成胶囊形——设计稿的圆角框在任何尺寸下都是"带圆角的矩形"，圆角
 * 是个固定的小倒角，不是形状特征。
 */
export function roundRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radius?: number,
): Pt[] {
  const r = Math.min(radius ?? Math.min(w, h) * 0.14, 32, w / 2, h / 2);
  // 圆角采样数随半径走，不写死。写死 6 段时，小倒角看不出问题，但"胶囊形"
  // 端点（流程图的起止节点，r ≈ 半高）每个角只有 6 段、直边又极短，整个形状
  // 读起来是个**斜切的六边形**而不是圆角矩形。
  const steps = Math.max(6, Math.min(20, Math.round(r / 1.6)));
  const arc = (cx: number, cy: number, from: number): Pt[] =>
    ellipsePts(cx, cy, r, r, from, 90, steps);
  return [
    [x + r, y],
    [x + w - r, y],
    ...arc(x + w - r, y + r, -90),
    [x + w, y + h - r],
    ...arc(x + w - r, y + h - r, 0),
    [x + r, y + h],
    ...arc(x + r, y + h - r, 90),
    [x, y + r],
    ...arc(x + r, y + r, 180),
    // 收笔沿顶边多走一点（同 rectPath 的理由：读成"角"而不是"刺"）
    [x + r + w * 0.05, y],
  ];
}

/**
 * 云朵框（设计稿 §4「云朵框」）：一圈外凸的弧连成闭合轮廓。
 *
 * 用**奇数个**凸包（这里顶 3 / 侧 1 / 底 3）：偶数个会在左右对称轴上出现
 * 两个等大的包，读起来像并排的两团棉花而不是一朵云。
 *
 * ## 为什么不是"每个包画一段弧再首尾相连"
 *
 * 那是最直觉的做法，也是前两版的做法，但它做不对：折线要把上一个包的**终点**
 * 直连到下一个包的起点，而这两个端点必然已经绕到包的内侧，于是每个接缝处都多出
 * 一个向内的钩子——放大到思维气泡那种尺寸就是一圈倒刺。调弧长治不了根：弧画长了
 * 钩子更深，画短了外凸消失、整朵云退化成带三个缺口的圆角矩形。两个方向都试过。
 *
 * 所以改成**求并集的外轮廓**：绕中心按角度采样，每个方向上取所有包里最远的那个
 * 交点。轮廓天然没有接缝（它不是拼出来的），外凸形状完全由包的位置决定。代价是
 * 每个采样点要对 6 个椭圆各解一次二次方程——只在构造期算一次，不在每帧热路径上。
 */
export function cloudPath(x: number, y: number, w: number, h: number): Pt[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  // 各凸包的中心与半径（相对框归一化后再缩放）
  const lobes: Array<[number, number, number, number]> = (
    [
      [0.2, 0.62, 0.2, 0.34],
      [0.36, 0.3, 0.22, 0.36],
      [0.62, 0.26, 0.2, 0.34],
      [0.82, 0.52, 0.18, 0.32],
      [0.7, 0.8, 0.2, 0.28],
      [0.42, 0.84, 0.22, 0.28],
    ] as Array<[number, number, number, number]>
  ).map(([fx, fy, frx, fry]) => [
    x + w * fx,
    y + h * fy,
    w * frx,
    h * fry,
  ]) as Array<[number, number, number, number]>;

  /** 从中心沿 (dx,dy) 射出，与某个椭圆边界的最远交点距离（无交点返回 0）. */
  const reach = (
    dx: number,
    dy: number,
    lx: number,
    ly: number,
    rx: number,
    ry: number,
  ): number => {
    const ax = (cx - lx) / rx;
    const ay = (cy - ly) / ry;
    const bx = dx / rx;
    const by = dy / ry;
    const qa = bx * bx + by * by;
    const qb = 2 * (ax * bx + ay * by);
    const qc = ax * ax + ay * ay - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (qa === 0 || disc <= 0) return 0;
    const t = (-qb + Math.sqrt(disc)) / (2 * qa);
    return t > 0 ? t : 0;
  };

  const steps = 72;
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let r = 0;
    for (const [lx, ly, rx, ry] of lobes) {
      const t = reach(dx, dy, lx, ly, rx, ry);
      if (t > r) r = t;
    }
    // 兜底：所有包都不含中心时（不该发生）给个最小半径，避免退化成一个点
    if (r <= 0) r = Math.min(w, h) * 0.25;
    pts.push([cx + dx * r, cy + dy * r]);
  }
  // 显式用首点收尾，而不是让循环多跑一圈到 2π：`Math.sin(2π)` 是 -2.4e-16 而不是
  // 0，那样得到的"末点"与首点差 1e-14，闭合判断（以及下游任何按端点相等做的
  // 优化）会失效。
  pts.push(pts[0]!);
  return pts;
}

/**
 * 对话框（设计稿 §4「对话框」）：圆角矩形 + 左下角尖尾。
 *
 * 尖尾必须**长在边上**（从底边的某一点出发、回到底边的另一点），不能是独立
 * 的三角形：独立三角形与框之间会留一条描边缝，笔迹带的半透明叠色会让那条缝
 * 显出来。
 */
export function speechBoxPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radius?: number,
): Pt[] {
  const r = Math.min(radius ?? Math.min(w, h) * 0.12, 28, w / 2, h / 2);
  const arc = (cx: number, cy: number, from: number): Pt[] =>
    ellipsePts(cx, cy, r, r, from, 90, 6);
  // 尖尾在底边靠左 22%~38% 处，向下伸出 h*0.3
  const tailX0 = x + w * 0.38;
  const tailX1 = x + w * 0.22;
  const tailTip: Pt = [x + w * 0.16, y + h + h * 0.3];
  return [
    [x + r, y],
    [x + w - r, y],
    ...arc(x + w - r, y + r, -90),
    [x + w, y + h - r],
    ...arc(x + w - r, y + h - r, 0),
    [tailX0, y + h],
    tailTip,
    [tailX1, y + h],
    [x + r, y + h],
    ...arc(x + r, y + h - r, 90),
    [x, y + r],
    ...arc(x + r, y + r, 180),
    [x + r + w * 0.05, y],
  ];
}

/**
 * 大括号（设计稿 §4「大括号」）：竖向 `{`，用于把多行归拢到一个结论。
 *
 * 三个 x 位置必须**明显分开**：中尖在 `x`、两臂在 `x + depth/2`、上下两端
 * 在 `x + depth`。第一版把两臂放在 `x + depth*0.2`（离中尖只有 5px），渲出来
 * 是一个 `C` 而不是 `{`——大括号的辨识特征就是"中间那个尖比两臂更突出"，
 * 尖不够深就退化成括号。
 */
export function bracePath(x: number, y: number, h: number, depth = 26): Pt[] {
  const my = y + h / 2;
  const arm = x + depth * 0.5;
  const end = x + depth;
  return [
    [end, y],
    [arm + depth * 0.08, y + h * 0.05],
    [arm, y + h * 0.16],
    [arm, y + h * 0.4],
    // 中尖：从上臂斜切到最左，再斜回下臂（两段折线夹出一个尖）
    [x, my],
    [arm, y + h * 0.6],
    [arm, y + h * 0.84],
    [arm + depth * 0.08, y + h * 0.95],
    [end, y + h],
  ];
}

/** 五角星（设计稿 §4「星形标注」）：一笔连线成星. */
export function starPath(cx: number, cy: number, r: number): Pt[] {
  const order = [0, 2, 4, 1, 3, 0];
  return order.map((k) => {
    const a = (-90 + k * 72) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/**
 * 星形标注（设计稿 §4）：星 + 引线。用于"这一条最重要"。
 *
 * 引线从星的右下角出发，是因为标注对象通常在星的右侧（先看到星、顺着线看到
 * 内容）。星在左、内容在右符合从左到右的阅读顺序。
 */
export function starCalloutPaths(
  cx: number,
  cy: number,
  r: number,
  leadTo?: Pt,
): Pt[][] {
  const paths: Pt[][] = [starPath(cx, cy, r)];
  if (leadTo !== undefined) {
    paths.push([[cx + r * 0.8, cy + r * 0.6], leadTo]);
  }
  return paths;
}

// ---- 便签纸（实心，贴入而不是笔描） ----

/** 便签纸配色（设计稿 §4 的淡黄纸 + 红图钉）. */
export const STICKY_FILL = "#FDF3C8";
export const STICKY_EDGE = "#E8D9A0";
export const STICKY_PIN = "#E74C3C";

/**
 * 便签纸（设计稿 §4「便签纸」）：淡黄纸片 + 右上角图钉 + 轻微倾斜。
 *
 * 倾斜角作为参数而不是随机：同一段里两张便签若角度随机，观感是"歪了"；
 * 显式给 ±2~4° 才读成"随手贴的"。
 *
 * 返回静态 SVG（调用方用 `fadeGroup` 贴入）：便签是被**贴上去**的实物，
 * 不是被画出来的线条——让笔去描一张实心纸片会很怪。
 */
export function stickyNoteSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { rotDeg?: number; pin?: boolean } = {},
): string {
  const rot = o.rotDeg ?? -2.5;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const parts: string[] = [
    `<g transform="rotate(${fmt(rot)} ${fmt(cx)} ${fmt(cy)})">`,
    // 纸片本体：右下角一个小折角（真便签贴上去后角会翘）
    `<path d="${[
      `M ${fmt(x)} ${fmt(y)}`,
      `H ${fmt(x + w)}`,
      `V ${fmt(y + h - h * 0.14)}`,
      `L ${fmt(x + w - w * 0.14)} ${fmt(y + h)}`,
      `H ${fmt(x)}`,
      `Z`,
    ].join(
      " ",
    )}" fill="${STICKY_FILL}" stroke="${STICKY_EDGE}" stroke-width="2"/>`,
    // 折角的暗面（让翘角读成三维）
    `<path d="${[
      `M ${fmt(x + w)} ${fmt(y + h - h * 0.14)}`,
      `L ${fmt(x + w - w * 0.14)} ${fmt(y + h - h * 0.14)}`,
      `L ${fmt(x + w - w * 0.14)} ${fmt(y + h)}`,
      `Z`,
    ].join(" ")}" fill="${STICKY_EDGE}" opacity="0.7"/>`,
  ];
  if (o.pin !== false) {
    parts.push(
      `<circle cx="${fmt(x + w * 0.5)}" cy="${fmt(y + h * 0.09)}" r="${fmt(Math.min(w, h) * 0.075)}" fill="${STICKY_PIN}"/>`,
      `<circle cx="${fmt(x + w * 0.5 - Math.min(w, h) * 0.025)}" cy="${fmt(y + h * 0.09 - Math.min(w, h) * 0.025)}" r="${fmt(Math.min(w, h) * 0.024)}" fill="#ffffff" opacity="0.55"/>`,
    );
  }
  parts.push(`</g>`);
  return parts.join("");
}

// ---- 2.0 §5：基本几何形 ----

/**
 * 正 n 边形（三角/五边/六边形共用）。
 *
 * `rotDeg` 默认 -90，即**顶点朝上**。多边形朝向是辨识特征：六边形顶点朝上
 * 是"蜂巢/模块"，平边朝上是"螺母"；三角形顶点朝上才是"三角形"，朝下会被
 * 读成"警告标志缺了个感叹号"。
 */
export function polygonPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  sides: number,
  rotDeg = -90,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = ((rotDeg + (360 * i) / sides) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** 圆（设计稿 2.0 §5「圆形」）：起笔略过头，收笔越过起点一点（真人画圈）. */
export function circlePath(cx: number, cy: number, r: number): Pt[] {
  return ellipsePts(cx, cy, r, r, -95, 372, 60);
}

/** 椭圆（§5「椭圆」）. */
export function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Pt[] {
  return ellipsePts(cx, cy, rx, ry, -95, 372, 64);
}

/** 三角形（§5）. */
export function trianglePath(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x + w / 2, y],
    [x + w, y + h],
    [x, y + h],
    [x + w / 2, y],
    [x + w * 0.56, y + h * 0.05],
  ];
}

/** 菱形（§5）. */
export function diamondPath(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
    [x + w / 2, y],
    [x + w * 0.56, y + h * 0.05],
  ];
}

/** 梯形（§5）；`topRatio` 为上底占下底的比例. */
export function trapezoidPath(
  x: number,
  y: number,
  w: number,
  h: number,
  topRatio = 0.58,
): Pt[] {
  const inset = (w * (1 - topRatio)) / 2;
  return [
    [x + inset, y],
    [x + w - inset, y],
    [x + w, y + h],
    [x, y + h],
    [x + inset, y],
    [x + inset + w * 0.05, y],
  ];
}

/** 平行四边形（§5）；`slant` 为顶边右移量占宽的比例. */
export function parallelogramPath(
  x: number,
  y: number,
  w: number,
  h: number,
  slant = 0.24,
): Pt[] {
  const d = w * slant;
  return [
    [x + d, y],
    [x + w, y],
    [x + w - d, y + h],
    [x, y + h],
    [x + d, y],
    [x + d + w * 0.05, y],
  ];
}

// ---- 2.0 §5：气泡与爆炸框 ----

/**
 * 思维气泡（§5「思维气泡」）：主云朵 + 两个递减的小圆点。
 *
 * 与 {@link cloudPath} 的区别是**尾巴**：云朵框是"这是一段旁白"，思维气泡是
 * "这是某人心里想的"，而那串由大到小的圆点就是全部区别。返回多条折线（主体
 * 一条 + 每个圆点一条），因此要用 `markerStrokesEl` 依次描画。
 */
export function thoughtBubblePaths(
  x: number,
  y: number,
  w: number,
  h: number,
): Pt[][] {
  const body = h * 0.74;
  const paths: Pt[][] = [cloudPath(x, y, w, body)];
  // 尾巴：从气泡左下往外，三个递减圆点
  const dots: Array<[number, number, number]> = [
    [x + w * 0.24, y + body + h * 0.1, Math.min(w, h) * 0.062],
    [x + w * 0.14, y + body + h * 0.2, Math.min(w, h) * 0.042],
    [x + w * 0.07, y + body + h * 0.27, Math.min(w, h) * 0.026],
  ];
  for (const [dx, dy, r] of dots)
    paths.push(ellipsePts(dx, dy, r, r, 0, 360, 14));
  return paths;
}

/**
 * 爆炸框（§5「爆炸框」）：内外半径交替的尖角闭合折线。
 *
 * 尖数取偶数且**内外半径差要大**（这里 0.62 : 1）：差太小就变成"边缘不平的
 * 圆"，读不出"爆炸/重点强调"。
 */
export function burstPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  spikes = 12,
): Pt[] {
  const pts: Pt[] = [];
  const n = spikes * 2;
  for (let i = 0; i <= n; i++) {
    const a = ((360 * i) / n - 90) * (Math.PI / 180);
    const k = i % 2 === 0 ? 1 : 0.62;
    pts.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return pts;
}

/**
 * 卷轴（§5「卷轴」）：纸面 + 上下两端卷起来的纸卷。
 *
 * 卷边画在**上下**而不是左右：横版画面里左右卷边会把本来就窄的内容区再吃掉
 * 两块，而上下卷边只吃高度，且更像"一张展开的纸"。
 *
 * 每个卷边要画**两条弧**（外缘 + 内缘的卷心）。只画外缘一条时，加上两侧竖边
 * 会得到一个标准的圆柱——和 §6 的「数据库」图标撞成同一个形状。内缘那条短弧
 * 是"纸卷起来了"的唯一证据。
 */
export function scrollPaths(
  x: number,
  y: number,
  w: number,
  h: number,
): Pt[][] {
  const curl = Math.min(h * 0.18, 24);
  const inset = Math.min(w * 0.16, 26);
  return [
    // 纸面两侧
    [
      [x, y + curl],
      [x, y + h - curl],
    ],
    [
      [x + w, y + curl],
      [x + w, y + h - curl],
    ],
    // 上卷：外缘弧 + 卷心（缩进的小半弧，朝向相反）
    ellipsePts(x + w / 2, y + curl, w / 2, curl, 180, 180, 26),
    ellipsePts(
      x + w / 2 - inset * 0.2,
      y + curl,
      w / 2 - inset,
      curl * 0.72,
      0,
      180,
      20,
    ),
    // 下卷
    ellipsePts(x + w / 2, y + h - curl, w / 2, curl, 0, 180, 26),
    ellipsePts(
      x + w / 2 + inset * 0.2,
      y + h - curl,
      w / 2 - inset,
      curl * 0.72,
      180,
      180,
      20,
    ),
  ];
}

/**
 * 循环箭头（§5「循环箭头」）：近乎整圈的弧 + 末端翼，语义是"迭代/重复"。
 *
 * 刻意留 `gapDeg` 的缺口：画满一整圈后箭头会指向自己的起点，读成"闭环已完成"
 * 而不是"还在转"。缺口让人看出这是一个**动作**。
 */
export function loopArrowPaths(
  cx: number,
  cy: number,
  r: number,
  gapDeg = 62,
  headSize = 20,
): Pt[][] {
  const arc = ellipsePts(cx, cy, r, r, -90 + gapDeg / 2, 360 - gapDeg, 48);
  return [arc, arrowHead(arc, headSize)];
}

// ---- 2.0 §5：标记件（旗帜/标签/书签/徽章/吊牌/胶带） ----

/** 旗帜（§5「旗帜」）：竖杆 + 三角旗面. */
export function flagPaths(x: number, y: number, w: number, h: number): Pt[][] {
  return [
    [
      [x, y],
      [x, y + h],
    ],
    [
      [x, y],
      [x + w, y + h * 0.22],
      [x, y + h * 0.44],
    ],
  ];
}

/** 标签（§5「标签」）：右端收尖的横条（像书签带/流程标签）. */
export function labelPath(x: number, y: number, w: number, h: number): Pt[] {
  const tip = Math.min(w * 0.2, h * 0.7);
  return [
    [x, y],
    [x + w - tip, y],
    [x + w, y + h / 2],
    [x + w - tip, y + h],
    [x, y + h],
    [x, y],
    [x + w * 0.06, y],
  ];
}

/** 书签（§5「书签」）：下端开 V 口的竖条. */
export function bookmarkPath(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x + w / 2, y + h - h * 0.26],
    [x, y + h],
    [x, y],
    [x + w * 0.1, y],
  ];
}

/**
 * 徽章（§5「徽章」）：外圈带波形花边的圆。
 *
 * 花边深度取半径的 12%、齿数 10。第一版用 8% / 14 齿：在 37px 半径下齿深只有
 * 3px，渲出来和普通圆没有区别——花边看不见的徽章就只是个圆。深度再往上加就会
 * 和 {@link burstPath}（爆炸框，62%）撞语义，12% 是"看得出是齿、又不像爆炸"
 * 的那一档。
 */
export function badgePath(cx: number, cy: number, r: number, teeth = 10): Pt[] {
  const pts: Pt[] = [];
  const n = teeth * 2;
  for (let i = 0; i <= n; i++) {
    const a = ((360 * i) / n - 90) * (Math.PI / 180);
    const k = i % 2 === 0 ? 1 : 0.88;
    pts.push([cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)]);
  }
  return pts;
}

/** 吊牌（§5「吊牌」）：斜切一角的矩形 + 挂绳孔. */
export function tagPaths(x: number, y: number, w: number, h: number): Pt[][] {
  const cut = Math.min(w, h) * 0.3;
  const holeR = Math.min(w, h) * 0.09;
  return [
    [
      [x + cut, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y + cut],
      [x + cut, y],
      [x + cut + w * 0.05, y],
    ],
    ellipsePts(x + cut * 0.62, y + cut * 0.62, holeR, holeR, 0, 360, 16),
  ];
}

/**
 * 胶带（§5「胶带」）：半透明斜贴的条，两端为锯齿撕口。
 *
 * 与 {@link stickyNoteSvg} 同类——实心贴入件，不走笔描（胶带是贴上去的）。
 * 撕口用小锯齿而不是直边：直边读成"一个半透明矩形"。
 */
export function tapeSvg(
  cx: number,
  cy: number,
  w: number,
  h: number,
  o: { rotDeg?: number; fill?: string; opacity?: number } = {},
): string {
  const rot = o.rotDeg ?? -8;
  const fill = o.fill ?? "#F59E0B";
  const op = o.opacity ?? 0.3;
  const teeth = 5;
  const step = h / teeth;
  const jag = Math.min(w * 0.05, 7);
  const pts: string[] = [];
  // 左撕口（自上而下锯齿）
  for (let i = 0; i <= teeth; i++) {
    const yy = -h / 2 + step * i;
    pts.push(`${fmt(-w / 2 + (i % 2 === 0 ? 0 : jag))},${fmt(yy)}`);
  }
  // 右撕口（自下而上）
  for (let i = teeth; i >= 0; i--) {
    const yy = -h / 2 + step * i;
    pts.push(`${fmt(w / 2 - (i % 2 === 0 ? 0 : jag))},${fmt(yy)}`);
  }
  return (
    `<g transform="translate(${fmt(cx)},${fmt(cy)}) rotate(${fmt(rot)})">` +
    `<polygon points="${pts.join(" ")}" fill="${fill}" opacity="${fmt(op)}"/></g>`
  );
}

// ---- 形状名字表（供脚本层校验） ----

/** 设计稿 §4/§5 的容器名（可作为"把内容框起来"的外框）. */
export const CONTAINER_NAMES = [
  "rect",
  "round-rect",
  "cloud",
  "speech",
  "sticky",
  "circle",
  "ellipse",
  "triangle",
  "diamond",
  "trapezoid",
  "parallelogram",
  "pentagon",
  "hexagon",
  "burst",
  "label",
] as const;

export type ContainerName = (typeof CONTAINER_NAMES)[number];

export function isContainerName(v: string): v is ContainerName {
  return (CONTAINER_NAMES as readonly string[]).includes(v);
}

/**
 * 按名字取容器轮廓折线（`sticky` 不在此列——它是实心件，走 stickyNoteSvg）。
 * 未知名字回退矩形：宁可框错形状，不要一段内容没有容器。
 */
export function containerPath(
  name: ContainerName,
  x: number,
  y: number,
  w: number,
  h: number,
): Pt[] {
  switch (name) {
    case "round-rect":
      return roundRectPath(x, y, w, h);
    case "cloud":
      return cloudPath(x, y, w, h);
    case "speech":
      return speechBoxPath(x, y, w, h);
    case "circle":
      return circlePath(x + w / 2, y + h / 2, Math.min(w, h) / 2);
    case "ellipse":
      return ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2);
    case "triangle":
      return trianglePath(x, y, w, h);
    case "diamond":
      return diamondPath(x, y, w, h);
    case "trapezoid":
      return trapezoidPath(x, y, w, h);
    case "parallelogram":
      return parallelogramPath(x, y, w, h);
    case "pentagon":
      return polygonPath(x + w / 2, y + h / 2, w / 2, h / 2, 5);
    case "hexagon":
      // 六边形用 rotDeg=0（平顶、左右出尖），与三角/五边形的"顶点朝上"不同：
      // 设计稿 §5 的六边形是平顶的，而顶点朝上的六边形读起来像螺母
      return polygonPath(x + w / 2, y + h / 2, w / 2, h / 2, 6, 0);
    case "burst":
      return burstPath(x + w / 2, y + h / 2, w / 2, h / 2);
    case "label":
      return labelPath(x, y, w, h);
    case "sticky":
    case "rect":
      return rectPath(x, y, w, h);
  }
}
