/**
 * 诊断：笔尖 pose 与可见笔迹的对位误差。
 *
 * 渲染一行手写文本的若干时刻，在 pose 处画十字标 + 字框参考线。
 * 排查工具，不参与流水线。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { fmt, penPoseAt } from "../../src/core/whiteboard/index";
import type { TimelineEl } from "../../src/core/whiteboard/index";
import { markerTextEl } from "../../src/core/whiteboard-video/blocks";
import {
  findHand,
  handSvg,
  listHands,
  loadHand,
} from "../../src/core/whiteboard-video/hand";

import { repoAssetsRoot } from "../../src/core/whiteboard-video/config";

/** 仓库的素材根（手势库与插画库都在这儿）. */
const ASSETS = repoAssetsRoot();
const here = new URL(".", import.meta.url).pathname;
const out = join(here, "stills");
await mkdir(out, { recursive: true });
const hands = listHands(join(ASSETS, "sparkol"));
const asset = findHand(hands, process.env["HAND"] ?? "suneeta-black-marker");
const hand =
  asset === null ? null : loadHand(asset, { canvasWidth: 1080, handSize: 460 });

const SIZE = 118;
const X = 90;
const Y = 200;
const el = markerTextEl("为什么要做", {
  x: X,
  y: Y,
  size: SIZE,
  gap: SIZE * 0.06,
  t0: 0,
  perChar: 0.5,
  color: "#22262b",
  idp: "d",
});

const penEls: TimelineEl[] = [el];

function frame(t: number): string {
  const pose = penPoseAt(t, penEls, 31);
  const marks: string[] = [
    `<line x1="0" y1="${Y}" x2="1080" y2="${Y}" stroke="#0a0" stroke-width="1"/>`,
    `<line x1="0" y1="${fmt(Y + SIZE * 0.879)}" x2="1080" y2="${fmt(Y + SIZE * 0.879)}" stroke="#00f" stroke-width="1"/>`,
    `<line x1="0" y1="${Y + SIZE}" x2="1080" y2="${Y + SIZE}" stroke="#0a0" stroke-width="1"/>`,
  ];
  if (pose !== null) {
    marks.push(
      `<line x1="${fmt(pose.x - 40)}" y1="${fmt(pose.y)}" x2="${fmt(pose.x + 40)}" y2="${fmt(pose.y)}" stroke="#f00" stroke-width="2"/>`,
      `<line x1="${fmt(pose.x)}" y1="${fmt(pose.y - 40)}" x2="${fmt(pose.x)}" y2="${fmt(pose.y + 40)}" stroke="#f00" stroke-width="2"/>`,
    );
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="700" viewBox="0 0 1080 700">`,
    `<rect width="1080" height="700" fill="#fff"/>`,
    el.svg(t),
    pose !== null && hand !== null ? handSvg(pose, hand) : "",
    ...marks,
    `</svg>`,
  ].join("");
}

for (const t of [0.18, 0.42, 0.9, 1.4, 1.9, 2.3]) {
  const png = new Resvg(frame(t), { font: { loadSystemFonts: false } })
    .render()
    .asPng();
  await writeFile(join(out, `tipdiag-${t}.png`), png);
}
console.error("→ stills/tipdiag-*.png");
