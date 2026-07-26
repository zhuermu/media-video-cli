/**
 * 「白板视频设计系统 2.0」自绘海报
 *
 * 用**本项目自己的元素库**把设计稿画出来——十四个板块，一笔都不用外部素材。
 * 这既是成果展示，也是最严格的一次自检：设计稿是人画的，这张是代码画的，
 * 两张并排放，缺什么、哪里不像，一眼就看出来。
 *
 * 跑法：
 *   bun run experiments/design-poster.ts
 *   → experiments/design-poster.png
 *
 * 与两张 design-sheet 的分工：sheet 是「元素逐个平铺」的验收表（改一个元素看
 * 一眼），poster 是「整套系统摆在一起」的观感检查（看配色、密度、风格是否统一）。
 */

import { writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

import {
  BOARD_BACKGROUNDS,
  BOARD_DESIGN,
  backgroundDefs,
  boardCornersSvg,
  boardStyleFor,
} from "../src/core/whiteboard-video/board";
import { markerTextEl, textWidth } from "../src/core/whiteboard-video/blocks";
import {
  areaChart,
  barChart,
  funnelChart,
  gauge,
  lineChart,
  pieChart,
  pyramidChart,
  radarChart,
  timeline,
} from "../src/core/whiteboard-video/charts";
import type { ChartDrawing } from "../src/core/whiteboard-video/charts";
import {
  flowChart,
  list,
  mindMap,
  orgChart,
  table,
} from "../src/core/whiteboard-video/diagrams";
import type { DiagramDrawing } from "../src/core/whiteboard-video/diagrams";
import {
  STATUS_KINDS,
  cornerDecorPath,
  dividerPaths,
  hatchDefs,
  hatchSvg,
  highlightBoxSvg,
  radiatingPaths,
  statusBadgePaths,
  statusColor,
} from "../src/core/whiteboard-video/emphasis";
import { markerStrokesEl } from "../src/core/whiteboard-video/marker";
import { INK_ROLES, PALETTE } from "../src/core/whiteboard-video/palette";
import {
  SCENE_LABELS,
  SCENE_NAMES,
  partColor,
  scene,
} from "../src/core/whiteboard-video/scenes";
import {
  LINE_W,
  biArrow,
  brushStrokesEl,
  chalkStrokesEl,
  curvedArrow,
  dashedStrokesEl,
  dottedStrokesEl,
  gradientStrokeSvg,
  highlightEl,
  lightningPath,
  straightArrow,
  straightLine,
  watercolorSvg,
  wavyLine,
} from "../src/core/whiteboard-video/strokes";
import {
  badgePath,
  bookmarkPath,
  bracePath,
  burstPath,
  circlePath,
  cloudPath,
  diamondPath,
  ellipsePath,
  flagPaths,
  labelPath,
  loopArrowPaths,
  parallelogramPath,
  polygonPath,
  rectPath,
  roundRectPath,
  scrollPaths,
  speechBoxPath,
  starPath,
  stickyNoteSvg,
  tagPaths,
  tapeSvg,
  thoughtBubblePaths,
  trapezoidPath,
  trianglePath,
} from "../src/core/whiteboard-video/shapes";
import {
  ICON_CATEGORIES,
  iconPaths,
  iconsInCategory,
} from "../src/core/whiteboard/index";

const W = 1840;
const H = 1620;
const T = 9999;

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};

type P = readonly [number, number];

function draw(
  paths: readonly (readonly P[])[],
  color: string,
  width: number,
  seed: string,
  amp = 1.8,
): void {
  if (paths.length === 0) return;
  push(
    markerStrokesEl(paths, {
      t0: 0,
      dur: 1,
      color,
      width,
      seed,
      amp,
      overshoot: false,
    }).svg(T),
  );
}

function text(
  s: string,
  x: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void {
  push(
    markerTextEl(s, {
      x,
      y,
      size,
      gap: size * 0.06,
      t0: 0,
      perChar: 0.01,
      color,
      idp: `t${out.length}`,
    }).svg(T),
  );
}

const tw = (s: string, size: number): number => textWidth(s, size, size * 0.06);

function textCenter(
  s: string,
  cx: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void {
  text(s, cx - tw(s, size) / 2, y, size, color);
}

/** 小标注（元素名）. */
function cap(s: string, cx: number, y: number): void {
  textCenter(s, cx, y, 17, PALETTE.muted);
}

/** 板块面板：白底圆角卡 + 蓝色标签页眉（同设计稿的板块结构）. */
function panel(
  title: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#FFFFFF" stroke="#E3E8EE" stroke-width="2"/>`,
  );
  const size = 21;
  const lw = tw(title, size) + 26;
  push(
    `<rect x="${x + 14}" y="${y - 12}" width="${lw}" height="${size + 16}" rx="8" fill="${PALETTE.primary}" opacity="0.15"/>`,
  );
  text(title, x + 27, y - 4, size, PALETTE.ink);
}

function chart(d: ChartDrawing, seed: string, w = 2.6): void {
  draw(d.strokes, PALETTE.ink, w, seed, 0.9);
  for (const f of d.fills) push(f);
}

function diagram(d: DiagramDrawing, seed: string, w = 2.4): void {
  draw(d.strokes, PALETTE.ink, w, seed, 0.8);
  for (const f of d.fills ?? []) push(f);
  const bars = d.slots.map(
    (s) =>
      [
        [s.x + s.w * 0.2, s.y + s.size * 0.6],
        [s.x + s.w * 0.8, s.y + s.size * 0.6],
      ] as P[],
  );
  draw(bars, PALETTE.muted, 1.8, `${seed}s`, 0.4);
}

push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(
  `<defs>${hatchDefs("pHatch", "muted")}${BOARD_BACKGROUNDS.map((b) => backgroundDefs(b, `pbg-${b}`)).join("")}</defs>`,
);
push(`<rect width="${W}" height="${H}" fill="#F6F8FB"/>`);

// ---- 海报页眉 ----
textCenter("白板视频设计系统 2.0", W / 2, 26, 52);
draw(
  [straightLine(W / 2 - 300, 100, W / 2 + 300, 100)],
  PALETTE.primary,
  9,
  "hd",
  2.2,
);
textCenter("更丰富的表达，让知识更生动", W / 2, 112, 26, PALETTE.muted);
// 页眉两侧的装饰放射线
draw(
  radiatingPaths(W / 2 - 372, 52, 14, 34, 6, 10),
  PALETTE.primary,
  3,
  "hr1",
  0.6,
);
draw(
  radiatingPaths(W / 2 + 372, 52, 14, 34, 6, 10),
  PALETTE.primary,
  3,
  "hr2",
  0.6,
);

const R1 = 190;
const R1H = 236;

// ================= §1 白板基础样式 =================
{
  const x = 40;
  const w = 404;
  panel("1. 白板基础样式", x, R1, w, R1H);
  const bx = x + 22;
  const by = R1 + 26;
  const bw = w - 44;
  const bh = 116;
  const st = boardStyleFor("plain", BOARD_DESIGN);
  push(
    `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#fff" stroke="${st.frame}" stroke-width="3" rx="3"/>`,
  );
  push(boardCornersSvg(bx, by, bw, bh, st, 0.8));
  textCenter("手绘 · 简洁 · 知识传递感", bx + bw / 2, by + bh / 2 - 14, 24);
  // 六种背景小样
  const names = ["纯白", "米白", "网格", "横线", "点阵", "纸纹"] as const;
  const keys = ["plain", "cream", "grid", "lined", "dots", "texture"] as const;
  const sw = (bw - 5 * 8) / 6;
  keys.forEach((k, i) => {
    const sx = bx + i * (sw + 8);
    const sy = by + bh + 18;
    const s2 = boardStyleFor(k, BOARD_DESIGN);
    push(
      `<rect x="${sx}" y="${sy}" width="${sw}" height="40" fill="${s2.surface}" stroke="#D6DDE4" stroke-width="1.5" rx="3"/>`,
    );
    if (backgroundDefs(k) !== "") {
      push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="40" fill="url(#pbg-${k})" rx="3"/>`,
      );
    }
    cap(names[i]!, sx + sw / 2, sy + 46);
  });
}

// ================= §2 线条样式 =================
{
  const x = 464;
  const w = 436;
  panel("2. 线条样式", x, R1, w, R1H);
  const lx = x + 24;
  const lw = 150;
  const items: Array<[string, (ly: number) => void]> = [
    [
      "粗线",
      (ly) =>
        draw(
          [straightLine(lx, ly, lx + lw, ly)],
          PALETTE.ink,
          LINE_W.bold,
          "b",
        ),
    ],
    [
      "中线",
      (ly) =>
        draw(
          [straightLine(lx, ly, lx + lw, ly)],
          PALETTE.ink,
          LINE_W.medium,
          "m",
        ),
    ],
    [
      "细线",
      (ly) =>
        draw(
          [straightLine(lx, ly, lx + lw, ly)],
          PALETTE.ink,
          LINE_W.thin,
          "t",
        ),
    ],
    [
      "虚线",
      (ly) =>
        push(
          dashedStrokesEl([straightLine(lx, ly, lx + lw, ly)], {
            t0: 0,
            dur: 1,
            color: PALETTE.ink,
            width: LINE_W.medium,
            seed: "da",
          }).svg(T),
        ),
    ],
    [
      "点线",
      (ly) =>
        push(
          dottedStrokesEl([straightLine(lx, ly, lx + lw, ly)], {
            t0: 0,
            dur: 1,
            color: PALETTE.ink,
            width: LINE_W.medium,
            seed: "do",
          }).svg(T),
        ),
    ],
  ];
  items.forEach(([label, fn], i) => {
    const ly = R1 + 40 + i * 38;
    fn(ly);
    cap(label, lx + lw + 34, ly - 9);
  });
  const rx = lx + 214;
  const rItems: Array<[string, (ly: number) => void]> = [
    [
      "箭头线",
      (ly) =>
        draw(
          straightArrow(rx, ly, rx + 118, ly, 15),
          PALETTE.ink,
          LINE_W.medium,
          "ar",
          1,
        ),
    ],
    [
      "双向箭头",
      (ly) =>
        draw(
          biArrow(rx, ly, rx + 118, ly, 14),
          PALETTE.ink,
          LINE_W.medium,
          "bi",
          1,
        ),
    ],
    [
      "曲线箭头",
      (ly) =>
        draw(
          curvedArrow(rx, ly + 12, rx + 118, ly - 10, 0.3, 15),
          PALETTE.ink,
          LINE_W.medium,
          "cu",
          1,
        ),
    ],
    [
      "波浪线",
      (ly) =>
        draw(
          wavyLine(rx, ly, 118, 7, 3),
          PALETTE.ink,
          LINE_W.medium,
          "wv",
          0.8,
        ),
    ],
    [
      "闪电线",
      (ly) =>
        draw(
          [lightningPath(rx + 40, ly - 16, 40, 40)],
          PALETTE.warn,
          LINE_W.medium,
          "lt",
          0.8,
        ),
    ],
  ];
  rItems.forEach(([label, fn], i) => {
    const ly = R1 + 40 + i * 38;
    fn(ly);
    cap(label, rx + 152, ly - 9);
  });
}

// ================= §3 色彩方案 =================
{
  const x = 920;
  const w = 280;
  panel("3. 色彩方案", x, R1, w, R1H);
  INK_ROLES.forEach((role, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = x + 26 + col * 132;
    const cy = R1 + 44 + row * 50;
    push(`<circle cx="${cx}" cy="${cy}" r="17" fill="${PALETTE[role]}"/>`);
    text(PALETTE[role], cx + 24, cy - 14, 15, PALETTE.muted);
    text(role, cx + 24, cy + 3, 13, PALETTE.muted);
  });
}

// ================= §4 手绘笔触效果 =================
{
  const x = 1220;
  const w = 580;
  panel("4. 手绘笔触效果", x, R1, w, R1H);
  const cw = (w - 48) / 3;
  const cells: Array<[string, (cx: number, cy: number) => void]> = [
    [
      "马克笔质感",
      (cx, cy) =>
        draw(
          [straightLine(cx - 52, cy, cx + 52, cy)],
          PALETTE.primary,
          14,
          "mk",
          1.6,
        ),
    ],
    [
      "毛笔笔触",
      (cx, cy) =>
        push(
          brushStrokesEl(
            [
              [
                [cx - 54, cy + 8],
                [cx, cy - 8],
                [cx + 54, cy + 4],
              ],
            ],
            {
              t0: 0,
              dur: 1,
              color: PALETTE.ink,
              width: 17,
              seed: "br",
              amp: 1.2,
              overshoot: false,
            },
          ).svg(T),
        ),
    ],
    [
      "荧光笔效果",
      (cx, cy) =>
        push(
          highlightEl(cx - 52, cy - 13, 104, {
            t0: 0,
            dur: 1,
            color: PALETTE.warn,
            height: 26,
            seed: "hl",
          }).svg(T),
        ),
    ],
    [
      "粉笔效果",
      (cx, cy) =>
        push(
          chalkStrokesEl([straightLine(cx - 52, cy, cx + 52, cy)], {
            t0: 0,
            dur: 1,
            color: PALETTE.muted,
            width: 13,
            seed: "ch",
          }).svg(T),
        ),
    ],
    [
      "水彩涂抹",
      (cx, cy) =>
        push(
          watercolorSvg(cx - 54, cy - 20, 108, 40, {
            color: PALETTE.danger,
            seed: "wc",
            opacity: 0.42,
          }),
        ),
    ],
    [
      "渐变笔触",
      (cx, cy) =>
        push(
          gradientStrokeSvg("pGrad", [cx - 52, cy], [cx + 52, cy], 18, [
            PALETTE.accent2,
            PALETTE.info,
          ]),
        ),
    ],
  ];
  cells.forEach(([label, fn], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = x + 24 + cw * (col + 0.5);
    const cy = R1 + 52 + row * 100;
    fn(cx, cy);
    cap(label, cx, cy + 26);
  });
}

const R2 = 480;
const R2H = 470;

// ================= §5 主要图形元素 =================
{
  const x = 40;
  const w = 600;
  panel("5. 主要图形元素", x, R2, w, R2H);
  const cw = 66;
  const ch = 48;
  const gx = (w - 40 - cw * 7) / 6;
  const cells: Array<[string, (sx: number, sy: number) => void]> = [
    [
      "矩形",
      (sx, sy) => draw([rectPath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s1"),
    ],
    [
      "圆角矩形",
      (sx, sy) => draw([roundRectPath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s2"),
    ],
    [
      "圆形",
      (sx, sy) =>
        draw(
          [circlePath(sx + cw / 2, sy + ch / 2, ch / 2)],
          PALETTE.ink,
          2.6,
          "s3",
        ),
    ],
    [
      "椭圆",
      (sx, sy) =>
        draw(
          [ellipsePath(sx + cw / 2, sy + ch / 2, cw / 2, ch / 2)],
          PALETTE.ink,
          2.6,
          "s4",
        ),
    ],
    [
      "三角形",
      (sx, sy) => draw([trianglePath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s5"),
    ],
    [
      "菱形",
      (sx, sy) => draw([diamondPath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s6"),
    ],
    [
      "梯形",
      (sx, sy) => draw([trapezoidPath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s7"),
    ],
    [
      "平行四边形",
      (sx, sy) =>
        draw([parallelogramPath(sx, sy, cw, ch)], PALETTE.ink, 2.6, "s8"),
    ],
    [
      "五边形",
      (sx, sy) =>
        draw(
          [polygonPath(sx + cw / 2, sy + ch / 2, cw / 2, ch / 2, 5)],
          PALETTE.ink,
          2.6,
          "s9",
        ),
    ],
    [
      "六边形",
      (sx, sy) =>
        draw(
          [polygonPath(sx + cw / 2, sy + ch / 2, cw / 2, ch / 2, 6, 0)],
          PALETTE.ink,
          2.6,
          "s10",
        ),
    ],
    [
      "云朵",
      (sx, sy) => draw([cloudPath(sx, sy, cw, ch)], PALETTE.ink, 2.4, "s11"),
    ],
    [
      "对话框",
      (sx, sy) =>
        draw([speechBoxPath(sx, sy, cw, ch * 0.76)], PALETTE.ink, 2.4, "s12"),
    ],
    [
      "思维气泡",
      (sx, sy) =>
        draw(thoughtBubblePaths(sx, sy, cw, ch), PALETTE.ink, 2.2, "s13"),
    ],
    [
      "爆炸框",
      (sx, sy) =>
        draw(
          [burstPath(sx + cw / 2, sy + ch / 2, cw / 2, ch / 2)],
          PALETTE.ink,
          2.2,
          "s14",
        ),
    ],
    [
      "便签纸",
      (sx, sy) => push(stickyNoteSvg(sx + cw * 0.1, sy, cw * 0.8, ch, {})),
    ],
    [
      "卷轴",
      (sx, sy) => draw(scrollPaths(sx, sy, cw, ch), PALETTE.ink, 2.2, "s16"),
    ],
    [
      "直线箭头",
      (sx, sy) =>
        draw(
          straightArrow(sx, sy + ch / 2, sx + cw, sy + ch / 2, 13),
          PALETTE.ink,
          2.6,
          "s17",
          0.8,
        ),
    ],
    [
      "弯曲箭头",
      (sx, sy) =>
        draw(
          curvedArrow(sx, sy + ch * 0.8, sx + cw, sy + ch * 0.2, 0.32, 13),
          PALETTE.ink,
          2.6,
          "s18",
          0.8,
        ),
    ],
    [
      "双向箭头",
      (sx, sy) =>
        draw(
          biArrow(sx, sy + ch / 2, sx + cw, sy + ch / 2, 12),
          PALETTE.ink,
          2.6,
          "s19",
          0.8,
        ),
    ],
    [
      "循环箭头",
      (sx, sy) =>
        draw(
          loopArrowPaths(sx + cw / 2, sy + ch / 2, ch / 2, 62, 13),
          PALETTE.ink,
          2.6,
          "s20",
          0.8,
        ),
    ],
    [
      "大括号",
      (sx, sy) =>
        draw(
          [bracePath(sx + cw * 0.3, sy, ch, 20)],
          PALETTE.ink,
          2.6,
          "s21",
          0.8,
        ),
    ],
    [
      "星形",
      (sx, sy) =>
        draw(
          [starPath(sx + cw / 2, sy + ch / 2, ch / 2)],
          PALETTE.ink,
          2.4,
          "s22",
        ),
    ],
    [
      "旗帜",
      (sx, sy) =>
        draw(
          flagPaths(sx + cw * 0.2, sy, cw * 0.6, ch),
          PALETTE.ink,
          2.6,
          "s23",
        ),
    ],
    [
      "标签",
      (sx, sy) =>
        draw(
          [labelPath(sx, sy + ch * 0.22, cw, ch * 0.56)],
          PALETTE.ink,
          2.6,
          "s24",
        ),
    ],
    [
      "书签",
      (sx, sy) =>
        draw(
          [bookmarkPath(sx + cw * 0.28, sy, cw * 0.44, ch)],
          PALETTE.ink,
          2.6,
          "s25",
        ),
    ],
    [
      "徽章",
      (sx, sy) =>
        draw(
          [badgePath(sx + cw / 2, sy + ch / 2, ch / 2)],
          PALETTE.ink,
          2.4,
          "s26",
        ),
    ],
    [
      "吊牌",
      (sx, sy) =>
        draw(
          tagPaths(sx + cw * 0.14, sy, cw * 0.72, ch),
          PALETTE.ink,
          2.4,
          "s27",
        ),
    ],
    [
      "胶带",
      (sx, sy) =>
        push(
          tapeSvg(sx + cw / 2, sy + ch / 2, cw, ch * 0.52, {
            fill: PALETTE.warn,
          }),
        ),
    ],
  ];
  cells.forEach(([label, fn], i) => {
    const col = i % 7;
    const row = Math.floor(i / 7);
    const sx = x + 20 + col * (cw + gx);
    const sy = R2 + 30 + row * (ch + 62);
    fn(sx, sy);
    cap(label, sx + cw / 2, sy + ch + 12);
  });
}

// ================= §6 图标库（分类） =================
{
  const x = 660;
  const w = 620;
  panel("6. 常用贴图 / 图标库（分类）", x, R2, w, R2H);
  const cats = Object.keys(ICON_CATEGORIES);
  const colW = (w - 40) / 2;
  cats.forEach((cat, ci) => {
    const col = ci % 2;
    const row = Math.floor(ci / 2);
    const bx = x + 20 + col * colW;
    const by = R2 + 26 + row * 88;
    text(cat, bx, by, 18, PALETTE.primary);
    const icons = iconsInCategory(cat).slice(0, 5);
    icons.forEach((name, i) => {
      const cx = bx + 30 + i * 58;
      const cy = by + 48;
      draw(iconPaths(name, cx, cy, 46), PALETTE.ink, 2.6, `ic${name}`, 0.7);
    });
  });
}

// ================= §7 数据可视化 =================
{
  const x = 1300;
  const w = 500;
  panel("7. 数据可视化元素", x, R2, w, R2H);
  const bw = 128;
  const bh = 66;
  const gx = (w - 40 - bw * 3) / 2;
  const items: Array<[string, (bx: number, by: number) => void]> = [
    [
      "柱状图",
      (bx, by) =>
        chart(
          barChart(
            { x: bx, y: by, w: bw, h: bh },
            { values: [0.45, 0.72, 0.34, 0.92] },
          ),
          "c1",
        ),
    ],
    [
      "折线图",
      (bx, by) =>
        chart(
          lineChart(
            { x: bx, y: by, w: bw, h: bh },
            { values: [0.2, 0.5, 0.36, 0.72, 0.9] },
          ),
          "c2",
        ),
    ],
    [
      "面积图",
      (bx, by) =>
        chart(
          areaChart(
            { x: bx, y: by, w: bw, h: bh },
            { values: [0.3, 0.58, 0.42, 0.78, 0.94] },
          ),
          "c3",
        ),
    ],
    [
      "饼图",
      (bx, by) =>
        chart(
          pieChart(bx + bw / 2, by + bh / 2, bh / 2, {
            values: [3, 2, 1.4, 1],
          }),
          "c4",
        ),
    ],
    [
      "环形图",
      (bx, by) =>
        chart(
          pieChart(bx + bw / 2, by + bh / 2, bh / 2, {
            values: [3, 2, 1.5],
            innerRatio: 0.55,
          }),
          "c5",
        ),
    ],
    [
      "雷达图",
      (bx, by) =>
        chart(
          radarChart(bx + bw / 2, by + bh / 2, bh / 2, {
            values: [0.9, 0.6, 0.8, 0.45, 0.75],
          }),
          "c6",
        ),
    ],
    [
      "漏斗图",
      (bx, by) =>
        chart(funnelChart({ x: bx, y: by, w: bw, h: bh }, { levels: 4 }), "c7"),
    ],
    [
      "金字塔",
      (bx, by) =>
        chart(
          pyramidChart({ x: bx, y: by, w: bw, h: bh }, { levels: 4 }),
          "c8",
        ),
    ],
    [
      "仪表盘",
      (bx, by) =>
        chart(gauge(bx + bw / 2, by + bh * 0.7, bh / 2, { value: 0.72 }), "c9"),
    ],
    [
      "时间轴",
      (bx, by) =>
        chart(
          timeline(
            { x: bx, y: by + bh * 0.3, w: bw, h: bh * 0.4 },
            { nodes: 4, doneUpTo: 1 },
          ),
          "c10",
        ),
    ],
  ];
  items.forEach(([label, fn], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const bx = x + 20 + col * (bw + gx);
    const by = R2 + 34 + row * (bh + 34);
    fn(bx, by);
    cap(label, bx + bw / 2, by + bh + 8);
  });
}

const R3 = 990;
const R3H = 300;

// ================= §8 表格 & 列表 =================
{
  const x = 40;
  const w = 520;
  panel("8. 表格 & 列表样式", x, R3, w, R3H);
  diagram(
    table({ x: x + 20, y: R3 + 34, w: 150, h: 108, rows: 4, cols: 3 }),
    "t1",
  );
  cap("基础表格", x + 95, R3 + 150);
  const lx = x + 190;
  diagram(
    list({
      x: lx,
      y: R3 + 34,
      w: 110,
      lineHeight: 27,
      count: 4,
      kind: "todo",
      size: 18,
      checked: [0, 2],
    }),
    "l1",
  );
  cap("待办清单", lx + 55, R3 + 150);
  const ox = lx + 112;
  diagram(
    list({
      x: ox,
      y: R3 + 34,
      w: 100,
      lineHeight: 27,
      count: 4,
      kind: "ordered",
      size: 18,
    }),
    "l2",
  );
  cap("有序列表", ox + 50, R3 + 150);
  const ux = ox + 104;
  diagram(
    list({
      x: ux,
      y: R3 + 34,
      w: 100,
      lineHeight: 27,
      count: 4,
      kind: "bullet",
      size: 18,
    }),
    "l3",
  );
  cap("无序列表", ux + 50, R3 + 150);
  // 分隔线 + 大括号收纳示意
  draw(dividerPaths(x + 24, R3 + 196, w - 48), PALETTE.muted, 2.2, "dv", 0.6);
  cap("分隔线 / 表格与列表可与容器、强调件自由组合", x + w / 2, R3 + 232);
}

// ================= §9 流程 & 结构图 =================
{
  const x = 580;
  const w = 500;
  panel("9. 流程 & 结构图", x, R3, w, R3H);
  diagram(
    flowChart({
      x: x + 16,
      y: R3 + 30,
      w: 108,
      nodeH: 27,
      gap: 20,
      nodes: [
        { kind: "terminal" },
        { kind: "step" },
        { kind: "decision" },
        { kind: "terminal" },
      ],
    }),
    "f1",
  );
  cap("流程图", x + 70, R3 + 226);
  diagram(
    mindMap({
      cx: x + 216,
      cy: R3 + 116,
      centerW: 74,
      centerH: 30,
      branches: 3,
      branchW: 72,
      branchH: 26,
      spread: 34,
    }),
    "m1",
  );
  cap("思维导图", x + 246, R3 + 226);
  diagram(
    orgChart({
      x: x + 350,
      y: R3 + 44,
      w: 152,
      nodeH: 28,
      gap: 34,
      children: 3,
    }),
    "o1",
  );
  cap("组织架构", x + 426, R3 + 226);
}

// ================= §10 场景化组件 =================
{
  const x = 1100;
  const w = 700;
  panel("10. 场景化组件", x, R3, w, R3H);
  const cw = (w - 40) / 5;
  SCENE_NAMES.forEach((name, i) => {
    const bx = x + 20 + cw * i + 8;
    const by = R3 + 34;
    const d = scene(name, { x: bx, y: by, w: cw - 16, h: 172 });
    d.parts.forEach((part, k) => {
      draw(part.paths, partColor(part), 2.4, `sc${name}${k}`, 0.7);
    });
    cap(SCENE_LABELS[name], bx + (cw - 16) / 2, by + 186);
  });
}

const R4 = 1330;
const R4H = 200;

// ================= §11 字体推荐 =================
{
  const x = 40;
  const w = 400;
  panel("11. 字体推荐（手写风格）", x, R4, w, R4H);
  text("中文：站酷快乐体", x + 22, R4 + 28, 24);
  text("英文：Patrick Hand", x + 22, R4 + 66, 24);
  text("标题粗 · 副标题中 · 正文常规", x + 22, R4 + 106, 18, PALETTE.muted);
  text("中英分别挑字体，混排同基线", x + 22, R4 + 136, 18, PALETTE.muted);
}

// ================= §12 装饰元素 =================
{
  const x = 460;
  const w = 400;
  panel("12. 装饰元素", x, R4, w, R4H);
  const y = R4 + 60;
  draw(radiatingPaths(x + 48, y, 14, 32, 8), PALETTE.warn, 2.6, "d1", 0.6);
  cap("放射线", x + 48, y + 40);
  push(hatchSvg("pHatch", x + 104, y - 26, 72, 52));
  cap("阴影底纹", x + 140, y + 40);
  draw(
    [cornerDecorPath(x + 202, y - 26, 20, "tl")],
    PALETTE.ink,
    2.6,
    "d2",
    0.6,
  );
  draw(
    [cornerDecorPath(x + 268, y + 26, 20, "br")],
    PALETTE.ink,
    2.6,
    "d3",
    0.6,
  );
  cap("角落装饰", x + 235, y + 40);
  push(
    highlightEl(x + 296, y - 14, 76, {
      t0: 0,
      dur: 1,
      color: PALETTE.warn,
      height: 26,
      seed: "d4",
    }).svg(T),
  );
  cap("强调线", x + 334, y + 40);
  draw(dividerPaths(x + 24, y + 78, w - 48), PALETTE.muted, 2.2, "d5", 0.6);
  cap("分隔线", x + w / 2, y + 92);
}

// ================= §13 状态 & 强调 =================
{
  const x = 880;
  const w = 420;
  panel("13. 状态 & 强调", x, R4, w, R4H);
  const labels: Record<string, string> = {
    important: "重要",
    info: "提示",
    caution: "注意",
    success: "成功",
    error: "错误",
  };
  STATUS_KINDS.forEach((kind, i) => {
    const cx = x + 46 + i * 76;
    const cy = R4 + 48;
    draw(
      statusBadgePaths(kind, cx, cy, 19),
      statusColor(kind),
      2.6,
      `b${kind}`,
      0.7,
    );
    cap(labels[kind]!, cx, cy + 26);
  });
  push(highlightBoxSvg(x + 26, R4 + 118, 122, 30, "warn"));
  text("高亮背景", x + 32, R4 + 118, 24);
  text("重点文字", x + 190, R4 + 118, 24);
  draw(
    [
      [
        [x + 188, R4 + 154],
        [x + 292, R4 + 154],
      ],
    ],
    PALETTE.danger,
    3,
    "ku",
    0.7,
  );
}

// ================= §14 使用示例 =================
{
  const x = 1320;
  const w = 480;
  panel("14. 使用示例", x, R4, w, R4H);
  const steps: Array<[string, string]> = [
    ["question", "问题提出"],
    ["magnifier", "分析过程"],
    ["lightbulb", "解决方案"],
    ["trophy", "最终效果"],
  ];
  const bw = 82;
  const bh = 66;
  const gap = (w - 40 - bw * 4) / 3;
  steps.forEach(([icon, label], i) => {
    const bx = x + 20 + i * (bw + gap);
    const by = R4 + 34;
    const accent = i === steps.length - 1 ? PALETTE.success : PALETTE.ink;
    draw([roundRectPath(bx, by, bw, bh)], accent, 2.4, `u${i}`, 0.7);
    draw(
      iconPaths(icon, bx + bw / 2, by + bh / 2, 36),
      accent,
      2.4,
      `ui${i}`,
      0.7,
    );
    cap(label, bx + bw / 2, by + bh + 10);
    if (i < steps.length - 1) {
      draw(
        straightArrow(
          bx + bw + gap * 0.18,
          by + bh / 2,
          bx + bw + gap * 0.82,
          by + bh / 2,
          11,
        ),
        PALETTE.primary,
        2.4,
        `ua${i}`,
        0.6,
      );
    }
  });
  cap("组合以上元素，即可构造完整的讲解段落", x + w / 2, R4 + 152);
}

// ---- 页脚 ----
draw([straightLine(40, H - 54, W - 40, H - 54)], PALETTE.muted, 2, "ft", 0.5);
textCenter(
  "设计原则：简单、清晰、统一、聚焦内容 —— 让观众注意力集中在知识本身",
  W / 2,
  H - 40,
  21,
  PALETTE.muted,
);

push(`</svg>`);

const svg = out.join("\n");
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = new URL("./design-poster.png", import.meta.url).pathname;
writeFileSync(dest, png);
console.error(`→ ${dest}`);
