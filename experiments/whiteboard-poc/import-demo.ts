/**
 * 验证 svg-import.ts：把外部下载的线稿 SVG 用马克笔逐笔描出来。
 *
 * 这是"能不能做到 VideoScribe 那种效果"的技术验证点——VideoScribe 的核心
 * 不是渲染，而是「素材是可逐笔绘制的线稿」。若任意第三方描边 SVG 都能进
 * 我们的笔描管线，素材库就不再是瓶颈。
 *
 * 运行（media-video-cli/ 下）：
 *   bun run experiments/whiteboard-poc/import-demo.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  fmt,
  penPoseAt,
  rasterizeVectorFrame,
} from "../../src/core/whiteboard/index";
import type { TimelineEl } from "../../src/core/whiteboard/index";
import {
  BOARD_FRAMELESS,
  boardDefs,
  boardOverlaySvg,
  boardSurfaceSvg,
} from "../../src/core/whiteboard-video/board";
import {
  G,
  markerTextEl,
  textWidth,
} from "../../src/core/whiteboard-video/blocks";
import { markerStrokesEl } from "../../src/core/whiteboard-video/marker";
import {
  markerNibGlowSvg,
  markerPenDefs,
  markerPenStyle,
  markerPenSvg,
} from "../../src/core/whiteboard-video/pen-marker";
import { iconDrawSecFor, importSvg, placeIcon } from "./svg-import";

const INK = "#22262b";
const ACCENT = "#c8483a";
const PEN = markerPenStyle(INK, ACCENT);

const iconDir = join(new URL(".", import.meta.url).pathname, "assets/lucide");
const names = readdirSync(iconDir)
  .filter((f) => f.endsWith(".svg"))
  .sort();

if (names.length === 0) throw new Error(`没有找到 SVG 素材: ${iconDir}`);

/* —— 3 列网格铺开，每个图标下方标注文件名 —— */
const COLS = 3;
const CELL = 300;
const ICON = 176;
const gridW = COLS * CELL;
const x0 = (G.width - gridW) / 2;
const y0 = 470;

const els: TimelineEl[] = [];
let t = 0.4;
const report: string[] = [];

for (const [i, file] of names.entries()) {
  const icon = importSvg(readFileSync(join(iconDir, file), "utf8"));
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const cx = x0 + col * CELL + CELL / 2;
  const cy = y0 + row * CELL + ICON / 2;
  // topDown：按起点从上到下重排，比图标作者的文档顺序更像真人的下笔顺序
  const paths = placeIcon(icon, { cx, cy, size: ICON, order: "topDown" });
  const dur = iconDrawSecFor(paths, ICON);
  report.push(
    `${file.padEnd(22)} 笔画 ${String(icon.strokes.length).padStart(2)} 段` +
      `  采样点 ${String(paths.reduce((a, p) => a + p.length, 0)).padStart(4)}` +
      `  描画 ${dur.toFixed(2)}s` +
      (icon.hasFill ? "  [含填充图形——只描到轮廓]" : ""),
  );

  els.push(
    markerStrokesEl(paths, {
      t0: t,
      dur,
      color: i % 4 === 1 ? ACCENT : INK,
      width: 8,
      seed: `im${i}`,
      amp: 2.0,
    }),
  );
  t += dur + 0.26;

  const label = file.replace(/\.svg$/, "");
  const lsize = 30;
  const lw = textWidth(label, lsize, lsize * 0.06);
  els.push(
    markerTextEl(label, {
      x: cx - lw / 2,
      y: cy + ICON / 2 + 24,
      size: lsize,
      gap: lsize * 0.06,
      t0: t,
      perChar: 0.1,
      color: INK,
      idp: `IL${i}`,
    }),
  );
  t += [...label].length * 0.1 + 0.3;
}

const TITLE = "外部线稿素材导入";
const titleSize = 96;
const titleW = textWidth(TITLE, titleSize, titleSize * 0.06);
els.unshift(
  markerTextEl(TITLE, {
    x: (G.width - titleW) / 2,
    y: 230,
    size: titleSize,
    gap: titleSize * 0.06,
    t0: 0,
    perChar: 0.42,
    color: INK,
    idp: "IT",
  }),
);

const totalSec = t + 1;
const penEls = els.filter(
  (e): e is TimelineEl & { pen: NonNullable<TimelineEl["pen"]> } =>
    e.pen !== undefined,
);

console.error(report.join("\n"));
console.error(
  `总时长 ${totalSec.toFixed(1)}s；网格底边 ${fmt(y0 + Math.ceil(names.length / COLS) * CELL)}`,
);

function frame(t: number): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${G.width}" height="${G.height}" viewBox="0 0 ${G.width} ${G.height}">`,
    `<defs>${boardDefs(BOARD_FRAMELESS)}${markerPenDefs(PEN)}</defs>`,
    boardSurfaceSvg(0, 0, G.width, G.height),
  ];
  for (const el of els) parts.push(el.svg(t));
  const pose = penPoseAt(t, penEls, 31);
  if (pose !== null)
    parts.push(markerNibGlowSvg(pose), markerPenSvg(pose, PEN));
  parts.push(boardOverlaySvg(0, 0, G.width, G.height, BOARD_FRAMELESS));
  parts.push(`</svg>`);
  return parts.join("\n");
}

const outDir = join(new URL(".", import.meta.url).pathname, "stills");
await mkdir(outDir, { recursive: true });
for (const [label, tt] of [
  ["mid", totalSec * 0.45],
  ["final", totalSec - 0.5],
] as const) {
  await rasterizeVectorFrame(frame(tt), join(outDir, `import-${label}.png`));
  console.error(`import-${label} @${tt.toFixed(1)}s`);
}
console.log(`→ ${outDir}/import-final.png`);
