/**
 * 设计稿 2.0 对照表（image2 目视验收工具）
 *
 * 按 `assets/design/image2.png` 的板块顺序铺开新增的元素，用来并排比对。
 * 与 `design-sheet.ts`（1.0 基础元素）分开：两张图各自对应一份设计稿，混在
 * 一张里会挤到看不清，而目视验收的前提是看得清。
 *
 * 跑法：
 *   bun run experiments/design-sheet-2.ts
 *   → experiments/design-sheet-2.png
 *
 * 所有元素在 t=∞ 求值（终态）。图表的 `fills` 在 `strokes` 之后叠加，与真实
 * 渲染顺序一致（先描轮廓、后涂色）。
 */

import { writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

import { markerTextEl, textWidth } from "../src/core/whiteboard-video/blocks";
import {
  areaChart,
  barChart,
  compareChart,
  gauge,
  lineChart,
  pieChart,
  pyramidChart,
  funnelChart,
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
  LINE_W,
  biArrow,
  dottedStrokesEl,
  lightningPath,
  straightLine,
  wavyLine,
} from "../src/core/whiteboard-video/strokes";
import {
  badgePath,
  bookmarkPath,
  burstPath,
  circlePath,
  diamondPath,
  ellipsePath,
  flagPaths,
  labelPath,
  loopArrowPaths,
  parallelogramPath,
  polygonPath,
  scrollPaths,
  tagPaths,
  tapeSvg,
  thoughtBubblePaths,
  trapezoidPath,
  trianglePath,
} from "../src/core/whiteboard-video/shapes";

const W = 1720;
const H = 1620;
const T = 9999;

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};

function draw(
  paths: readonly (readonly [number, number][])[],
  color: string,
  width: number,
  seed: string,
  amp = 2,
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

function textCenter(
  s: string,
  cx: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void {
  text(s, cx - textWidth(s, size, size * 0.06) / 2, y, size, color);
}

function sectionLabel(s: string, x: number, y: number): void {
  const size = 25;
  const w = textWidth(s, size, size * 0.06) + 32;
  push(
    `<rect x="${x - 13}" y="${y - 9}" width="${w}" height="${size + 19}" rx="9" fill="${PALETTE.primary}" opacity="0.13"/>`,
  );
  text(s, x, y, size, PALETTE.ink);
}

/** 图表：先描 strokes 再叠 fills（与真实渲染顺序一致）. */
function chart(d: ChartDrawing, color: string, seed: string, w = 3.2): void {
  draw(d.strokes, color, w, seed, 1.2);
  for (const f of d.fills) push(f);
}

/** 结构图：骨架 + 用短横线示意每个文字位（本表不排真文字）. */
function diagram(d: DiagramDrawing, seed: string, w = 3): void {
  draw(d.strokes, PALETTE.ink, w, seed, 1.1);
  for (const f of d.fills ?? []) push(f);
  // 文字位画成一条淡横线：证明 slot 落在格子里，同时不与手写文字抢注意力
  const bars = d.slots.map(
    (s) =>
      [
        [s.x + s.w * 0.18, s.y + s.size * 0.6],
        [s.x + s.w * 0.82, s.y + s.size * 0.6],
      ] as [number, number][],
  );
  draw(bars, PALETTE.muted, 2, `${seed}slot`, 0.6);
}

push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(`<defs>${hatchDefs("sheetHatch", "muted")}</defs>`);
push(`<rect width="${W}" height="${H}" fill="#F7F9FB"/>`);

textCenter("白板视频设计系统 2.0 · 元素对照表", W / 2, 26, 46);
draw(
  [straightLine(W / 2 - 330, 100, W / 2 + 330, 100)],
  PALETTE.primary,
  LINE_W.bold,
  "hdr",
  2.4,
);

// ================= §2 线条样式（2.0 新增） =================
{
  const x = 48;
  const y = 148;
  sectionLabel("2. 线条样式（新增）", x, y);
  const lw = 250;
  const rows: Array<[string, (ly: number) => void]> = [
    [
      "点线",
      (ly) =>
        push(
          dottedStrokesEl([straightLine(x, ly, x + lw, ly)], {
            t0: 0,
            dur: 1,
            color: PALETTE.ink,
            width: LINE_W.medium,
            seed: "dot",
          }).svg(T),
        ),
    ],
    [
      "双向箭头",
      (ly) =>
        draw(
          biArrow(x, ly, x + lw, ly, 18),
          PALETTE.ink,
          LINE_W.medium,
          "bi",
          1.2,
        ),
    ],
    [
      "波浪线",
      (ly) =>
        draw(wavyLine(x, ly, lw, 8, 3), PALETTE.ink, LINE_W.medium, "wv", 1),
    ],
  ];
  rows.forEach(([label, fn], i) => {
    const ly = y + 62 + i * 52;
    fn(ly);
    text(label, x + lw + 22, ly - 14, 22, PALETTE.muted);
  });
  // 闪电线（竖向）
  draw(
    [lightningPath(x + 30, y + 226, 60, 96)],
    PALETTE.warn,
    LINE_W.medium,
    "lt",
    1,
  );
  text("闪电线", x + 100, y + 258, 22, PALETTE.muted);
}

// ================= §3 色彩方案 2.0（八色） =================
{
  const x = 430;
  const y = 148;
  sectionLabel("3. 色彩方案（八色）", x, y);
  INK_ROLES.forEach((role, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = x + col * 168;
    const sy = y + 58 + row * 76;
    push(
      `<circle cx="${sx + 24}" cy="${sy + 22}" r="22" fill="${PALETTE[role]}"/>`,
    );
    text(PALETTE[role], sx + 54, sy + 6, 18, PALETTE.muted);
    text(role, sx + 54, sy + 30, 16, PALETTE.muted);
  });
}

// ================= §5 图形元素（2.0 新增） =================
{
  const x = 800;
  const y = 148;
  sectionLabel("5. 图形元素（新增）", x, y);
  const cw = 96;
  const chh = 74;
  const gap = 20;
  const cells: Array<[string, (sx: number, sy: number) => void]> = [
    [
      "圆形",
      (sx, sy) =>
        draw(
          [circlePath(sx + cw / 2, sy + chh / 2, Math.min(cw, chh) / 2)],
          PALETTE.ink,
          3.4,
          "c1",
        ),
    ],
    [
      "椭圆",
      (sx, sy) =>
        draw(
          [ellipsePath(sx + cw / 2, sy + chh / 2, cw / 2, chh / 2)],
          PALETTE.ink,
          3.4,
          "c2",
        ),
    ],
    [
      "三角形",
      (sx, sy) => draw([trianglePath(sx, sy, cw, chh)], PALETTE.ink, 3.4, "c3"),
    ],
    [
      "菱形",
      (sx, sy) => draw([diamondPath(sx, sy, cw, chh)], PALETTE.ink, 3.4, "c4"),
    ],
    [
      "梯形",
      (sx, sy) =>
        draw([trapezoidPath(sx, sy, cw, chh)], PALETTE.ink, 3.4, "c5"),
    ],
    [
      "平行四边形",
      (sx, sy) =>
        draw([parallelogramPath(sx, sy, cw, chh)], PALETTE.ink, 3.4, "c6"),
    ],
    [
      "五边形",
      (sx, sy) =>
        draw(
          [polygonPath(sx + cw / 2, sy + chh / 2, cw / 2, chh / 2, 5)],
          PALETTE.ink,
          3.4,
          "c7",
        ),
    ],
    [
      "六边形",
      (sx, sy) =>
        draw(
          [polygonPath(sx + cw / 2, sy + chh / 2, cw / 2, chh / 2, 6, 0)],
          PALETTE.ink,
          3.4,
          "c8",
        ),
    ],
    [
      "思维气泡",
      (sx, sy) =>
        draw(thoughtBubblePaths(sx, sy, cw, chh), PALETTE.ink, 3, "c9"),
    ],
    [
      "爆炸框",
      (sx, sy) =>
        draw(
          [burstPath(sx + cw / 2, sy + chh / 2, cw / 2, chh / 2)],
          PALETTE.ink,
          3,
          "c10",
        ),
    ],
    [
      "卷轴",
      (sx, sy) => draw(scrollPaths(sx, sy, cw, chh), PALETTE.ink, 3, "c11"),
    ],
    [
      "循环箭头",
      (sx, sy) =>
        draw(
          loopArrowPaths(sx + cw / 2, sy + chh / 2, Math.min(cw, chh) / 2),
          PALETTE.ink,
          3.4,
          "c12",
        ),
    ],
    [
      "旗帜",
      (sx, sy) =>
        draw(
          flagPaths(sx + cw * 0.2, sy, cw * 0.62, chh),
          PALETTE.ink,
          3.4,
          "c13",
        ),
    ],
    [
      "标签",
      (sx, sy) =>
        draw(
          [labelPath(sx, sy + chh * 0.2, cw, chh * 0.56)],
          PALETTE.ink,
          3.4,
          "c14",
        ),
    ],
    [
      "书签",
      (sx, sy) =>
        draw(
          [bookmarkPath(sx + cw * 0.3, sy, cw * 0.4, chh)],
          PALETTE.ink,
          3.4,
          "c15",
        ),
    ],
    [
      "徽章",
      (sx, sy) =>
        draw(
          [badgePath(sx + cw / 2, sy + chh / 2, Math.min(cw, chh) / 2)],
          PALETTE.ink,
          3,
          "c16",
        ),
    ],
    [
      "吊牌",
      (sx, sy) =>
        draw(
          tagPaths(sx + cw * 0.14, sy, cw * 0.72, chh),
          PALETTE.ink,
          3.2,
          "c17",
        ),
    ],
    [
      "胶带",
      (sx, sy) =>
        push(
          tapeSvg(sx + cw / 2, sy + chh / 2, cw, chh * 0.5, {
            fill: PALETTE.warn,
          }),
        ),
    ],
  ];
  cells.forEach(([label, fn], i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const sx = x + col * (cw + gap);
    const sy = y + 62 + row * (chh + 58);
    fn(sx, sy);
    textCenter(label, sx + cw / 2, sy + chh + 12, 20, PALETTE.muted);
  });
}

// ================= §7 数据可视化 =================
{
  const x = 48;
  const y = 560;
  sectionLabel("7. 数据可视化元素", x, y);
  const bw = 150;
  const bh = 110;
  const gapX = 42;
  const gapY = 74;
  const perRow = 6;
  const cell = (i: number): { x: number; y: number } => ({
    x: x + (i % perRow) * (bw + gapX),
    y: y + 64 + Math.floor(i / perRow) * (bh + gapY),
  });
  const items: Array<[string, (b: { x: number; y: number }) => void]> = [
    [
      "柱状图",
      (b) =>
        chart(
          barChart({ ...b, w: bw, h: bh }, { values: [0.45, 0.72, 0.34, 0.9] }),
          PALETTE.ink,
          "bar",
        ),
    ],
    [
      "折线图",
      (b) =>
        chart(
          lineChart(
            { ...b, w: bw, h: bh },
            { values: [0.2, 0.45, 0.35, 0.7, 0.62, 0.92] },
          ),
          PALETTE.ink,
          "line",
        ),
    ],
    [
      "面积图",
      (b) =>
        chart(
          areaChart(
            { ...b, w: bw, h: bh },
            { values: [0.3, 0.55, 0.4, 0.75, 0.68, 0.95] },
          ),
          PALETTE.ink,
          "area",
        ),
    ],
    [
      "饼图",
      (b) =>
        chart(
          pieChart(b.x + bw / 2, b.y + bh / 2, bh / 2, {
            values: [3, 2, 1.4, 1],
          }),
          PALETTE.ink,
          "pie",
        ),
    ],
    [
      "环形图",
      (b) =>
        chart(
          pieChart(b.x + bw / 2, b.y + bh / 2, bh / 2, {
            values: [3, 2, 1.5],
            innerRatio: 0.56,
          }),
          PALETTE.ink,
          "donut",
        ),
    ],
    [
      "雷达图",
      (b) =>
        chart(
          radarChart(b.x + bw / 2, b.y + bh / 2, bh / 2, {
            values: [0.9, 0.6, 0.75, 0.4, 0.8],
          }),
          PALETTE.ink,
          "radar",
        ),
    ],
    [
      "漏斗图",
      (b) =>
        chart(
          funnelChart({ ...b, w: bw, h: bh }, { levels: 4 }),
          PALETTE.ink,
          "funnel",
        ),
    ],
    [
      "金字塔",
      (b) =>
        chart(
          pyramidChart({ ...b, w: bw, h: bh }, { levels: 4 }),
          PALETTE.ink,
          "pyr",
        ),
    ],
    [
      "仪表盘",
      (b) =>
        chart(
          gauge(b.x + bw / 2, b.y + bh * 0.66, bh / 2, { value: 0.72 }),
          PALETTE.ink,
          "gauge",
        ),
    ],
    [
      "时间轴",
      (b) =>
        chart(
          timeline(
            { ...b, y: b.y + bh * 0.3, w: bw, h: bh * 0.4 },
            { nodes: 4, doneUpTo: 1 },
          ),
          PALETTE.ink,
          "tl",
        ),
    ],
  ];
  items.forEach(([label, fn], i) => {
    const b = cell(i);
    fn(b);
    textCenter(label, b.x + bw / 2, b.y + bh + 14, 21, PALETTE.muted);
  });
  // 对比图（单独占一格，需要写 VS）
  const b = cell(10);
  const cmp = compareChart({ ...b, w: bw, h: bh }, { left: 0.55, right: 0.85 });
  chart(cmp, PALETTE.ink, "cmp");
  textCenter("VS", cmp.gap.x + cmp.gap.w / 2, b.y + bh * 0.4, 26, PALETTE.ink);
  textCenter("对比图", b.x + bw / 2, b.y + bh + 14, 21, PALETTE.muted);
}

// ================= §8 表格 & 列表 =================
{
  const x = 48;
  const y = 1000;
  sectionLabel("8. 表格 & 列表样式", x, y);
  diagram(table({ x, y: y + 62, w: 210, h: 128, rows: 4, cols: 3 }), "tbl");
  textCenter("基础表格", x + 105, y + 202, 21, PALETTE.muted);
  const lx = x + 268;
  diagram(
    list({
      x: lx,
      y: y + 62,
      w: 150,
      lineHeight: 34,
      count: 4,
      kind: "todo",
      size: 22,
      checked: [0, 2],
    }),
    "lst1",
  );
  textCenter("待办清单", lx + 70, y + 202, 21, PALETTE.muted);
  const ox = lx + 200;
  diagram(
    list({
      x: ox,
      y: y + 62,
      w: 140,
      lineHeight: 34,
      count: 4,
      kind: "ordered",
      size: 22,
    }),
    "lst2",
  );
  textCenter("有序列表", ox + 65, y + 202, 21, PALETTE.muted);
  const ux = ox + 190;
  diagram(
    list({
      x: ux,
      y: y + 62,
      w: 140,
      lineHeight: 34,
      count: 4,
      kind: "bullet",
      size: 22,
    }),
    "lst3",
  );
  textCenter("无序列表", ux + 65, y + 202, 21, PALETTE.muted);
}

// ================= §9 流程 & 结构图 =================
{
  const x = 900;
  const y = 1000;
  sectionLabel("9. 流程 & 结构图", x, y);
  diagram(
    flowChart({
      x,
      y: y + 62,
      w: 130,
      nodeH: 34,
      gap: 26,
      nodes: [
        { kind: "terminal" },
        { kind: "step" },
        { kind: "decision" },
        { kind: "terminal" },
      ],
    }),
    "flow",
  );
  textCenter("流程图", x + 65, y + 312, 21, PALETTE.muted);
  diagram(
    mindMap({
      cx: x + 250,
      cy: y + 160,
      centerW: 96,
      centerH: 40,
      branches: 3,
      branchW: 92,
      branchH: 34,
      spread: 46,
    }),
    "mind",
  );
  textCenter("思维导图", x + 290, y + 312, 21, PALETTE.muted);
  diagram(
    orgChart({
      x: x + 470,
      y: y + 76,
      w: 260,
      nodeH: 36,
      gap: 44,
      children: 3,
    }),
    "org",
  );
  textCenter("组织架构", x + 600, y + 312, 21, PALETTE.muted);
}

// ================= §13 状态 & 强调 =================
{
  const x = 48;
  const y = 1400;
  sectionLabel("13. 状态 & 强调", x, y);
  const labels: Record<string, string> = {
    important: "重要",
    info: "提示",
    caution: "注意",
    success: "成功",
    error: "错误",
  };
  STATUS_KINDS.forEach((kind, i) => {
    const cx = x + 34 + i * 96;
    const cy = y + 96;
    draw(
      statusBadgePaths(kind, cx, cy, 24),
      statusColor(kind),
      3.4,
      `st${kind}`,
      1,
    );
    textCenter(labels[kind]!, cx, cy + 34, 20, PALETTE.muted);
  });
  // 高亮背景 + 重点文字
  const hx = x + 520;
  push(highlightBoxSvg(hx - 4, y + 76, 154, 34, "warn"));
  text("高亮背景", hx, y + 76, 26);
  textCenter("重点文字", hx + 250, y + 76, 26, PALETTE.ink);
  draw(
    [
      [
        [hx + 180, y + 116],
        [hx + 320, y + 116],
      ],
    ],
    PALETTE.danger,
    4,
    "keyu",
    1,
  );
}

// ================= §12 装饰元素 =================
{
  const x = 1010;
  const y = 1400;
  sectionLabel("12. 装饰元素", x, y);
  draw(
    radiatingPaths(x + 44, y + 96, 18, 40, 8),
    PALETTE.warn,
    3.2,
    "rad",
    0.8,
  );
  textCenter("放射线", x + 44, y + 132, 20, PALETTE.muted);
  push(hatchSvg("sheetHatch", x + 122, y + 68, 92, 56));
  textCenter("阴影底纹", x + 168, y + 132, 20, PALETTE.muted);
  draw(
    [cornerDecorPath(x + 258, y + 68, 26, "tl")],
    PALETTE.ink,
    3.4,
    "cd1",
    0.8,
  );
  draw(
    [cornerDecorPath(x + 344, y + 124, 26, "br")],
    PALETTE.ink,
    3.4,
    "cd2",
    0.8,
  );
  textCenter("角落装饰", x + 300, y + 132, 20, PALETTE.muted);
  draw(dividerPaths(x + 400, y + 96, 180), PALETTE.muted, 3, "dv", 0.8);
  textCenter("分隔线", x + 490, y + 132, 20, PALETTE.muted);
}

push(`</svg>`);

const svg = out.join("\n");
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = new URL("./design-sheet-2.png", import.meta.url).pathname;
writeFileSync(dest, png);
console.error(`→ ${dest}`);
