/**
 * 深色封面（graph-vs-loop-vertical 专用，一次性脚本）
 *
 * 复用白板视频自己的矢量元素（手写马克笔字、下划线、板书流程块、荧光笔），
 * 只把「白底深墨」翻成「深底浅墨」——所以封面和成片是同一套笔触/字形/构图，
 * 观众点进来不会觉得走错片子，但主视觉是深色的。
 *
 * 为什么不改 cover.ts：production 的板面风格全是浅色白板（surface 是白/米黄），
 * ink 是 #222 深墨；直接把 surface 调暗会让深墨字看不见。深色封面需要「深底 +
 * 浅墨」整套反过来，是一张独立海报，不进 render 主链路。
 *
 * 跑法：
 *   bun run experiments/whiteboard-poc/dark-cover.ts
 *   → experiments/whiteboard-poc/out/graph-vs-loop-vertical-cover.png
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import {
  markerTextEl,
  textWidth,
} from "../../src/core/whiteboard-video/blocks";
import { markerStrokesEl } from "../../src/core/whiteboard-video/marker";
import { highlightEl } from "../../src/core/whiteboard-video/strokes";
import {
  boardBeats,
  parseBoardBlock,
} from "../../src/core/whiteboard-video/board-block";
import type { TimelineEl } from "../../src/core/whiteboard/types";

// —— 画幅 ——
const W = 1080;
const H = 1920;
/** 取「画完」那一刻的静态终态（所有笔迹动画都已结束）. */
const T = 1e6;

// —— 深色主题：深底 + 浅墨 ——
const BG_TOP = "#0B1220"; // 近黑的蓝
const BG_BOT = "#182338"; // 略亮的板岩蓝
const INK = "#EAF2FB"; // 浅墨（正文/框线/标题）
const SKY = "#38BDF8"; // 亮青：下划线 / 署名（比 #2563EB 在深底上更跳）
const MUTED = "#94A3B8"; // 次要信息
const WARN = "#F59E0B"; // 荧光笔

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};
const el = (e: TimelineEl): void => push(e.svg(T));

/** 一行手写字的宽度（字距与正文同比例）. */
const tw = (s: string, size: number): number => textWidth(s, size, size * 0.06);

/** 居中手写一行字. */
function center(s: string, y: number, size: number, color = INK): void {
  el(
    markerTextEl(s, {
      x: (W - tw(s, size)) / 2,
      y,
      size,
      gap: size * 0.06,
      t0: 0,
      perChar: 0.001,
      color,
      idp: `cv${out.length}`,
    }),
  );
}

/** 左对齐手写一行字. */
function text(
  s: string,
  x: number,
  y: number,
  size: number,
  color = INK,
): void {
  el(
    markerTextEl(s, {
      x,
      y,
      size,
      gap: size * 0.06,
      t0: 0,
      perChar: 0.001,
      color,
      idp: `cv${out.length}`,
    }),
  );
}

/** 标题字号：一行放得下（不换行——信息流小窗第二行会被裁）. */
function fitTitleSize(title: string, base: number): number {
  const max = W * 0.84;
  let size = base;
  while (size > base * 0.5 && tw(title, size) > max) size -= 2;
  return size;
}

// ==== 背景：深色渐变 + 极淡网格（呼应成片的 grid 底纹）====
push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(
  `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${BG_TOP}"/>` +
    `<stop offset="100%" stop-color="${BG_BOT}"/>` +
    `</linearGradient>` +
    `<pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">` +
    `<path d="M60 0H0V60" fill="none" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="1.5"/>` +
    `</pattern>` +
    `</defs>`,
);
push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
push(`<rect width="${W}" height="${H}" fill="url(#grid)"/>`);

// 细边框（浅一点，跟成片的板框呼应）
const m = 16;
push(
  `<rect x="${m}" y="${m}" width="${W - m * 2}" height="${H - m * 2}" ` +
    `fill="none" stroke="${INK}" stroke-opacity="0.28" stroke-width="3" rx="6"/>`,
);

// —— 顶部小眉标 ——
const kickerSize = 34;
center("AI AGENT · 冷静审计", H * 0.062, kickerSize, MUTED);

// ==== 标题 + 下划线 ====
const title = "Loop 还是 Graph";
const titleSize = fitTitleSize(title, W * 0.11);
const titleTop = H * 0.12;
center(title, titleTop, titleSize);
const halfW = tw(title, titleSize) / 2;
const ruleY = titleTop + titleSize * 1.22;
el(
  markerStrokesEl(
    [
      [
        [W / 2 - halfW, ruleY],
        [W / 2 + halfW, ruleY],
      ],
    ],
    {
      t0: 0,
      dur: 1,
      color: SKY,
      width: Math.max(7, W * 0.006),
      seed: "cvRule",
      amp: 2.4,
      overshoot: false,
    },
  ),
);

// —— 副标题 ——
const subSize = titleSize * 0.4;
const subY = ruleY + subSize * 1.9;
center("一个 loop 就是 graph 里的一个节点", subY, subSize, MUTED);

// ==== 主视觉：复用成片里那张 graph 流程块（浅墨画在深底上）====
const block = parseBoardBlock(
  "flow",
  "research\nwriter\nreview\nreview -[不合格]-> writer",
);
const boxTop = subY + H * 0.05;
const bottomReserve = H * 0.2;
const box = {
  x: W * 0.1,
  y: boxTop,
  w: W * 0.8,
  h: H - bottomReserve - boxTop,
};
const ctx = { ink: INK, bodySize: titleSize * 0.52, idp: "cvb" };
// 两趟：先量真实底边，再垂直居中（避免图贴顶、下面空一片）
const probe = boardBeats(block, box, ctx);
const usedH = Math.max(0, probe.bottomY - boxTop);
const dy = usedH > 0 && usedH < box.h ? (box.h - usedH) / 2 : 0;
const { beats } = boardBeats(block, { ...box, y: boxTop + dy }, ctx);
let t = 0;
for (const beat of beats) {
  const built = beat.build(t);
  for (const e of built.els) el(e);
  t = built.end;
}

// ==== 金句（荧光笔压住）====
const tagline = "先把 loop 做对，再连成 graph";
const tagSize = titleSize * 0.46;
const tagY = H - bottomReserve + H * 0.055;
const tagW = tw(tagline, tagSize);
el(
  highlightEl(
    W / 2 - tagW / 2 - tagSize * 0.3,
    tagY + tagSize * 0.05,
    tagW + tagSize * 0.6,
    {
      t0: 0,
      dur: 1,
      color: WARN,
      height: tagSize * 1.26,
      seed: "cvHl",
    },
  ),
);
center(tagline, tagY, tagSize);

// ==== 署名 + 关注引导（右下角）====
const nameSize = titleSize * 0.44;
const ctaSize = titleSize * 0.24;
const cta = "关注二木 · 聊大模型落地";
const right = W - m - W * 0.03;
const blockW = Math.max(tw("二木", nameSize), tw(cta, ctaSize));
const sx = right - blockW;
text("二木", sx, H - m - nameSize * 2.6, nameSize, SKY);
text(cta, sx, H - m - ctaSize * 2.2, ctaSize, MUTED);

push("</svg>");

// ==== 光栅化（loadSystemFonts:false —— 文字全走矢量路径，同帧渲染器）====
const svg = out.join("\n");
const outDir = join(import.meta.dir, "out");
mkdirSync(outDir, { recursive: true });
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = join(outDir, "graph-vs-loop-vertical-cover.png");
writeFileSync(dest, png);
console.log(
  `深色封面 ${W}×${H} → ${dest}  (${(png.length / 1024).toFixed(0)} KB)`,
);
