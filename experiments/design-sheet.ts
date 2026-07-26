/**
 * 设计稿对照表（image1 目视验收工具）
 *
 * 把新建的元素库按 `assets/design/image1.png` 的板块顺序铺成一张图，用来
 * **并排比对**设计稿与实现。这是本次对齐工作唯一的验收手段：元素是不是"像
 * 设计稿"没法写成断言，只能看。
 *
 * 跑法：
 *   bun run experiments/design-sheet.ts
 *   → experiments/design-sheet.png
 *
 * 所有元素都在 t=∞ 求值（取画完的终态）。动画本身由整片渲染验收，这里只管
 * 静态形状对不对。
 */

import { writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

import {
  BOARD_DESIGN,
  BOARD_BACKGROUNDS,
  backgroundDefs,
  boardCornersSvg,
  boardStyleFor,
} from "../src/core/whiteboard-video/board";
import { markerTextEl, textWidth } from "../src/core/whiteboard-video/blocks";
import { markerStrokesEl } from "../src/core/whiteboard-video/marker";
import {
  INK_ROLES,
  PALETTE,
  highlightOf,
} from "../src/core/whiteboard-video/palette";
import {
  LINE_W,
  curvedArrow,
  dashedArrowEl,
  dashedStrokesEl,
  highlightEl,
  scribbleEl,
  straightArrow,
  straightLine,
} from "../src/core/whiteboard-video/strokes";
import {
  bracePath,
  cloudPath,
  rectPath,
  roundRectPath,
  speechBoxPath,
  starCalloutPaths,
  stickyNoteSvg,
} from "../src/core/whiteboard-video/shapes";
import { iconPaths } from "../src/core/whiteboard/index";

const W = 1680;
const H = 1260;
/** 取终态的时刻（所有元素都远远画完）. */
const T = 9999;

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};

/** 笔描一组折线（终态）. */
function draw(
  paths: readonly (readonly [number, number][])[],
  color: string,
  width: number,
  seed: string,
  amp = 2.4,
): void {
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

/**
 * 手写文字（终态）。
 *
 * 不再传 `weight`：字重由字体提供，后处理膨胀会糊掉密笔画字的字腔
 * （见 blocks.ts 的 MARKER_WEIGHT_RATIO 注释）。设计稿 §7 的三档靠字号区分。
 */
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

/** 居中手写文字. */
function textCenter(
  s: string,
  cx: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void {
  text(s, cx - textWidth(s, size, size * 0.06) / 2, y, size, color);
}

/** 板块标题（蓝底圆角标签 + 手写标题，同设计稿的板块头）. */
function sectionLabel(s: string, x: number, y: number): void {
  const size = 26;
  const w = textWidth(s, size, size * 0.06) + 34;
  push(
    `<rect x="${x - 14}" y="${y - 9}" width="${w}" height="${size + 20}" rx="9" fill="${PALETTE.primary}" opacity="0.14"/>`,
  );
  text(s, x, y, size, PALETTE.ink);
}

// ---- 画布 + 六种背景的 pattern defs ----

const bgDefs = BOARD_BACKGROUNDS.map((bg) => backgroundDefs(bg, `bg-${bg}`))
  .filter((s) => s !== "")
  .join("");

push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(`<defs>${bgDefs}</defs>`);
push(`<rect width="${W}" height="${H}" fill="#F7F9FB"/>`);

// ---- 表头 ----
textCenter("白板元素对照表", W / 2, 30, 52);
draw(
  [straightLine(W / 2 - 230, 104, W / 2 + 230, 104)],
  PALETTE.primary,
  LINE_W.bold,
  "hdr",
  3,
);

// ================= §1 白板整体风格 =================
{
  const x = 50;
  const y = 150;
  sectionLabel("1. 白板整体风格", x, y);
  const bx = x;
  const by = y + 56;
  const bw = 470;
  const bh = 250;
  const s = boardStyleFor("plain", BOARD_DESIGN);
  push(
    `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${s.surface}" stroke="${s.frame}" stroke-width="4"/>`,
  );
  push(boardCornersSvg(bx, by, bw, bh, s, 1));
  // 板上示意内容：三条打勾要点 + 一个灯泡
  const items = ["手绘风格", "简洁清晰", "知识传递感"];
  items.forEach((it, i) => {
    const iy = by + 44 + i * 60;
    draw(
      [roundRectPath(bx + 42, iy, 30, 30, 6)],
      PALETTE.primary,
      LINE_W.thin,
      `c${i}`,
      1.2,
    );
    draw(
      [
        [
          [bx + 48, iy + 15],
          [bx + 56, iy + 24],
          [bx + 67, iy + 7],
        ],
      ],
      PALETTE.primary,
      6,
      `ck${i}`,
      1,
    );
    text(it, bx + 90, iy - 3, 32);
  });
  draw(
    iconPaths("lightbulb", bx + 372, by + 118, 118),
    PALETTE.primary,
    LINE_W.medium,
    "bulb",
    2,
  );
}

// ================= §2 白板背景样式 =================
{
  const x = 570;
  const y = 150;
  sectionLabel("2. 白板背景样式", x, y);
  const names: Record<string, string> = {
    plain: "纯白",
    grid: "网格纸",
    lined: "横线纸",
    cream: "米白纸",
    texture: "纸纹肌理",
    dots: "点阵纸",
  };
  const sw = 150;
  const sh = 96;
  BOARD_BACKGROUNDS.forEach((bg, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const sx = x + col * (sw + 22);
    const sy = y + 56 + row * (sh + 56);
    const st = boardStyleFor(bg, BOARD_DESIGN);
    push(
      `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="${st.surface}" stroke="#C9D1D8" stroke-width="2" rx="4"/>`,
    );
    if (backgroundDefs(bg) !== "") {
      push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="url(#bg-${bg})" rx="4"/>`,
      );
    }
    textCenter(names[bg]!, sx + sw / 2, sy + sh + 12, 24, PALETTE.muted);
  });
}

// ================= §3 手绘线条样式 =================
{
  const x = 1130;
  const y = 150;
  sectionLabel("3. 手绘线条样式", x, y);
  const lx = x;
  const lw = 330;
  const rows: Array<[string, () => void]> = [
    [
      "粗线条",
      () =>
        draw(
          [straightLine(lx, 0, lx + lw, 0)],
          PALETTE.ink,
          LINE_W.bold,
          "l1",
          2,
        ),
    ],
    [
      "细线条",
      () =>
        draw(
          [straightLine(lx, 0, lx + lw, 0)],
          PALETTE.ink,
          LINE_W.thin,
          "l2",
          2,
        ),
    ],
    ["虚线条", () => void 0],
    ["箭头线条", () => void 0],
  ];
  rows.forEach(([label], i) => {
    const ly = y + 66 + i * 52;
    if (i === 0) {
      draw(
        [straightLine(lx, ly, lx + lw, ly)],
        PALETTE.ink,
        LINE_W.bold,
        "l1",
        2,
      );
    } else if (i === 1) {
      draw(
        [straightLine(lx, ly, lx + lw, ly)],
        PALETTE.ink,
        LINE_W.thin,
        "l2",
        2,
      );
    } else if (i === 2) {
      push(
        dashedStrokesEl([straightLine(lx, ly, lx + lw, ly)], {
          t0: 0,
          dur: 1,
          color: PALETTE.ink,
          width: LINE_W.medium,
          seed: "l3",
        }).svg(T),
      );
    } else {
      draw(
        straightArrow(lx, ly, lx + lw, ly, 22),
        PALETTE.ink,
        LINE_W.medium,
        "l4",
        1.6,
      );
    }
    text(label, lx + lw + 26, ly - 15, 24, PALETTE.muted);
  });
  // 三条强调笔触
  ["强调色1", "强调色2", "强调色3"].forEach((label, i) => {
    const sx = lx + i * 116;
    const sy = y + 272;
    push(
      scribbleEl(sx, sy, 92, 32, {
        t0: 0,
        dur: 1,
        color: highlightOf(i),
        seed: `sc${i}`,
      }).svg(T),
    );
    textCenter(label, sx + 46, sy + 42, 22, PALETTE.muted);
  });
}

// ================= §4 主要元素样式 =================
{
  const x = 50;
  const y = 524;
  sectionLabel("4. 主要元素样式", x, y);
  const cw = 118;
  const ch = 86;
  const gap = 24;
  const row1Y = y + 60;
  const shapes: Array<[string, (sx: number) => void]> = [
    [
      "矩形框",
      (sx) =>
        draw([rectPath(sx, row1Y, cw, ch)], PALETTE.ink, LINE_W.medium, "s1"),
    ],
    [
      "圆角框",
      (sx) =>
        draw(
          [roundRectPath(sx, row1Y, cw, ch)],
          PALETTE.ink,
          LINE_W.medium,
          "s2",
        ),
    ],
    [
      "云朵框",
      (sx) =>
        draw([cloudPath(sx, row1Y, cw, ch)], PALETTE.ink, LINE_W.medium, "s3"),
    ],
    [
      "对话框",
      (sx) =>
        draw(
          [speechBoxPath(sx, row1Y, cw, ch * 0.78)],
          PALETTE.ink,
          LINE_W.medium,
          "s4",
        ),
    ],
    ["便签纸", (sx) => push(stickyNoteSvg(sx, row1Y, cw * 0.82, ch, {}))],
  ];
  shapes.forEach(([label, fn], i) => {
    const sx = x + i * (cw + gap);
    fn(sx);
    textCenter(label, sx + cw / 2, row1Y + ch + 36, 22, PALETTE.muted);
  });

  const row2Y = y + 252;
  // 箭头
  draw(
    straightArrow(x + 6, row2Y, x + 100, row2Y, 22),
    PALETTE.ink,
    LINE_W.medium,
    "a1",
    1.4,
  );
  textCenter("箭头", x + 53, row2Y + 40, 22, PALETTE.muted);
  // 曲线箭头
  draw(
    curvedArrow(x + 150, row2Y + 24, x + 244, row2Y - 20, 0.34, 22),
    PALETTE.ink,
    LINE_W.medium,
    "a2",
    1.4,
  );
  textCenter("曲线箭头", x + 197, row2Y + 40, 22, PALETTE.muted);
  // 虚线箭头
  push(
    dashedArrowEl(x + 294, row2Y, x + 388, row2Y, {
      t0: 0,
      dur: 1,
      color: PALETTE.ink,
      width: LINE_W.medium,
      seed: "a3",
      headSize: 22,
    }).svg(T),
  );
  textCenter("虚线箭头", x + 341, row2Y + 40, 22, PALETTE.muted);
  // 大括号
  draw(
    [bracePath(x + 452, row2Y - 46, 92, 26)],
    PALETTE.ink,
    LINE_W.medium,
    "a4",
    1.2,
  );
  textCenter("大括号", x + 465, row2Y + 44, 22, PALETTE.muted);
  // 星形标注
  draw(
    starCalloutPaths(x + 560, row2Y - 6, 30, [x + 626, row2Y + 18]),
    PALETTE.warn,
    LINE_W.medium,
    "a5",
    1.4,
  );
  textCenter("星形标注", x + 578, row2Y + 44, 22, PALETTE.muted);
}

// ================= §5 常用图标风格 =================
{
  const x = 760;
  const y = 524;
  sectionLabel("5. 常用图标风格（手绘）", x, y);
  const icons: Array<[string, string]> = [
    ["user", "用户"],
    ["team", "团队"],
    ["target", "目标"],
    ["lightbulb", "想法"],
    ["magnifier", "搜索"],
    ["laptop", "电脑"],
    ["phone", "手机"],
    ["document", "文档"],
    ["database", "数据库"],
    ["cloud", "云服务"],
    ["flow", "流程"],
    ["settings", "设置"],
    ["time", "时间"],
    ["security", "安全"],
    ["trophy", "成功"],
  ];
  const cellW = 108;
  const cellH = 130;
  icons.forEach(([name, label], i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const cx = x + col * cellW + cellW / 2;
    const cy = y + 76 + row * cellH;
    draw(iconPaths(name, cx, cy, 66), PALETTE.ink, 5.5, `ic${name}`, 1.4);
    textCenter(label, cx, cy + 44, 22, PALETTE.muted);
  });
}

// ================= §8 色彩方案 =================
{
  const x = 1310;
  const y = 524;
  sectionLabel("8. 色彩方案", x, y);
  INK_ROLES.forEach((role, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = x + col * 172;
    const sy = y + 66 + row * 92;
    push(
      `<circle cx="${sx + 28}" cy="${sy + 26}" r="25" fill="${PALETTE[role]}"/>`,
    );
    text(PALETTE[role], sx + 62, sy + 10, 19, PALETTE.muted);
    text(role, sx + 62, sy + 36, 17, PALETTE.muted);
  });
}

// ================= §7 字体三档 + 荧光高亮 =================
{
  const x = 50;
  const y = 960;
  sectionLabel("7. 字体样式（三档=字号阶）", x, y);
  text("标题文字", x, y + 60, 62);
  text("副标题文字", x, y + 148, 40, PALETTE.muted);
  // 正文 + 荧光高亮（展示 highlightEl 压在文字下面）
  const bodyY = y + 212;
  push(
    highlightEl(x - 4, bodyY + 4, 250, {
      t0: 0,
      dur: 1,
      color: highlightOf(2),
      height: 34,
      seed: "hl",
    }).svg(T),
  );
  text("正文内容文字示例", x, bodyY, 30);
}

push(`</svg>`);

const svg = out.join("\n");
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = new URL("./design-sheet.png", import.meta.url).pathname;
writeFileSync(dest, png);
console.error(`→ ${dest}`);
