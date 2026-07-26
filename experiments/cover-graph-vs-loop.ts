/**
 * 「Loop 还是 Graph」白板视频封面自绘
 *
 * 用项目自己的白板元素库画封面，而不是从成片抽帧——抽帧要么带烧进画面的字幕，
 * 要么被手部遮挡，而且首屏三秒决定完播，封面上该有的是**对比结构**（一个圈
 * 对三个节点）而不是某一段的中途状态。
 *
 * 跑法：
 *   bun run experiments/cover-graph-vs-loop.ts
 *   → experiments/cover-graph-vs-loop.png（1920×1080）
 *
 * 版式取舍：
 * - 标题一行到底，字号 104——封面在信息流里被压成小窗，18px 以下的字等于没写。
 * - 左右对照而不是上下叠：观众扫封面是横向扫的，左「一个圈」右「三个节点」，
 *   不读字也能看懂这条片子在比什么。
 * - 底部金句是全片结论（一个 loop 就是 graph 里的一个节点），用荧光笔压住，
 *   它比标题更能决定点不点进来。
 */

import { writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

import { markerTextEl, textWidth } from "../src/core/whiteboard-video/blocks";
import {
  BOARD_DESIGN,
  backgroundDefs,
  boardCornersSvg,
  boardStyleFor,
} from "../src/core/whiteboard-video/board";
import { markerStrokesEl } from "../src/core/whiteboard-video/marker";
import { PALETTE } from "../src/core/whiteboard-video/palette";
import {
  circlePath,
  loopArrowPaths,
  roundRectPath,
} from "../src/core/whiteboard-video/shapes";
import {
  curvedArrow,
  highlightEl,
  straightArrow,
} from "../src/core/whiteboard-video/strokes";

const W = 1920;
const H = 1080;
const T = 9999; // 取「画完」那一刻的静态帧

type P = readonly [number, number];

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};

function draw(
  paths: readonly (readonly P[])[],
  color: string,
  width: number,
  seed: string,
  amp = 1.4,
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

const tw = (s: string, size: number): number => textWidth(s, size, size * 0.06);

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
      perChar: 0.001,
      color,
      idp: `c${out.length}`,
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
  text(s, cx - tw(s, size) / 2, y, size, color);
}

// ---------- 板面 ----------
const style = boardStyleFor("grid", BOARD_DESIGN);
push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(`<defs>${backgroundDefs("grid", "coverGrid")}</defs>`);
push(`<rect width="${W}" height="${H}" fill="${style.surface}"/>`);
push(`<rect width="${W}" height="${H}" fill="url(#coverGrid)"/>`);
push(
  `<rect x="18" y="18" width="${W - 36}" height="${H - 36}" fill="none" stroke="${style.frame}" stroke-width="4" rx="4"/>`,
);
push(boardCornersSvg(18, 18, W - 36, H - 36, style, 1.1));

// ---------- 标题 ----------
const TITLE = "Loop 还是 Graph";
const TITLE_SIZE = 112;
textCenter(TITLE, W / 2, 72, TITLE_SIZE);
draw(
  [
    [
      [W / 2 - tw(TITLE, TITLE_SIZE) / 2, 208],
      [W / 2 + tw(TITLE, TITLE_SIZE) / 2, 208],
    ],
  ],
  PALETTE.primary,
  10,
  "ul",
  2.4,
);
textCenter(
  "一场冷静的审计：什么真变了，什么只是换了层漆",
  W / 2,
  232,
  40,
  PALETTE.muted,
);

// ---------- 左：一个 loop ----------
{
  const cx = 470;
  const cy = 620;
  const r = 168;
  draw([circlePath(cx, cy, r)], PALETTE.ink, 5, "lc", 1.2);
  draw(loopArrowPaths(cx, cy, r + 34, 58, 30), PALETTE.primary, 5, "la", 1.1);
  textCenter("loop", cx, cy - 66, 78);
  textCenter("一个 agent 自己转", cx, cy + 24, 34, PALETTE.muted);
  // 四步环绕圈摆（竖排会压到底部金句，也读不出「这是一个循环」）
  textCenter("discover", cx, cy - r - 96, 36, PALETTE.muted);
  textCenter("execute", cx, cy + r + 44, 36, PALETTE.muted);
  text("plan", cx + r + 62, cy - 18, 36, PALETTE.muted);
  text("verify", cx - r - 158, cy - 18, 36, PALETTE.muted);
}

// ---------- 中：VS ----------
textCenter("VS", W / 2, 560, 96, PALETTE.warn);

// ---------- 右：三个节点的 graph ----------
{
  const nx = 1120;
  const nw = 300;
  const nh = 96;
  const gap = 62;
  const nodes: Array<[string, number]> = [
    ["research", 430],
    ["write", 430 + nh + gap],
    ["review", 430 + (nh + gap) * 2],
  ];
  nodes.forEach(([label, y], i) => {
    draw([roundRectPath(nx, y, nw, nh)], PALETTE.ink, 5, `n${i}`, 1);
    textCenter(label, nx + nw / 2, y + nh / 2 - 25, 46);
    if (i < nodes.length - 1) {
      draw(
        straightArrow(
          nx + nw / 2,
          y + nh + 8,
          nx + nw / 2,
          y + nh + gap - 8,
          20,
        ),
        PALETTE.primary,
        5,
        `na${i}`,
        0.8,
      );
    }
  });
  // review → write 的回头边（routing）
  const wy = nodes[1]![1] + nh / 2;
  const ry = nodes[2]![1] + nh / 2;
  draw(
    curvedArrow(nx + nw + 18, ry, nx + nw + 18, wy, 0.55, 20),
    PALETTE.danger,
    4.5,
    "back",
    0.8,
  );
  text("不合格 route 回去", nx + nw + 92, wy + 34, 32, PALETTE.danger);
  textCenter("graph", nx + nw / 2, 300, 76);
  textCenter("三个专职节点", nx + nw / 2, 382, 36, PALETTE.muted);
}

// ---------- 底部金句 ----------
{
  const line = "一个 loop 就是 graph 里的一个节点";
  const size = 60;
  const w = tw(line, size);
  push(
    highlightEl(W / 2 - w / 2 - 18, 876, w + 36, {
      t0: 0,
      dur: 1,
      color: PALETTE.warn,
      height: 74,
      seed: "hl",
    }).svg(T),
  );
  textCenter(line, W / 2, 872, size);
}

// ---------- 署名 ----------
{
  const sig = "二木";
  const cta = "关注二木 · 聊大模型落地";
  const sx = W - 60 - tw(cta, 30);
  text(sig, sx, 962, 52, PALETTE.primary);
  text(cta, sx, 1024, 30, PALETTE.muted);
}

push("</svg>");

const svg = out.join("\n");
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = new URL("./cover-graph-vs-loop.png", import.meta.url).pathname;
writeFileSync(dest, png);
console.error(`→ ${dest}`);
