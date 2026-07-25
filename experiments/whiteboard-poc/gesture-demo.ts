/**
 * gesture-demo — 手势动作系统的关键帧 / 视频。
 *
 * 演示四类手势各自能讲什么：
 * 1. `write` 写标题（笔尖对位的回归验证也在这条上）
 * 2. `carry` 从画面右侧把一张外部图片搬进来（引用外部素材）
 * 3. `erase` 擦掉一条"假设"（叙事上的否定）
 * 4. `point` 指着已经画好的东西强调（不留痕的强调）
 *
 * 运行（media-video-agent/ 下）：
 *   bun run experiments/whiteboard-poc/gesture-demo.ts           # 关键帧
 *   bun run experiments/whiteboard-poc/gesture-demo.ts --video   # mp4
 */

import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import { IoError, RenderError } from "../../src/core/errors/index";
import { DEFAULT_FPS, penPoseAt } from "../../src/core/whiteboard/index";
import type { TimelineEl } from "../../src/core/whiteboard/index";
import {
  BOARD_PAPER,
  boardDefs,
  boardOverlaySvg,
  boardSurfaceSvg,
} from "../../src/core/whiteboard-video/board";
import {
  markerTextEl,
  textWidth,
  titleBlock,
} from "../../src/core/whiteboard-video/blocks";
import type { BlockCtx } from "../../src/core/whiteboard-video/blocks";
import {
  activeHandCue,
  carryInEl,
  eraseEl,
  listGestures,
  loadHandKit,
  penElements,
  pointEl,
} from "../../src/core/whiteboard-video/gestures";
import type {
  GestureEl,
  HandKit,
} from "../../src/core/whiteboard-video/gestures";
import { handCueSvg } from "../../src/core/whiteboard-video/hand";
import { LANDSCAPE } from "../../src/core/whiteboard-video/layout";
import {
  markerPenDefs,
  markerPenStyle,
} from "../../src/core/whiteboard-video/pen-marker";

const INK = "#22262b";
const ACCENT = "#c8483a";
const PEN = markerPenStyle(INK, ACCENT);
const PERSONA = process.env["PERSONA"] ?? "suneeta";

import { repoAssetsRoot } from "../../src/core/whiteboard-video/config";

/** 仓库的素材根（手势库与插画库都在这儿）. */
const ASSETS = repoAssetsRoot();
const here = new URL(".", import.meta.url).pathname;
const sparkolDir = join(ASSETS, "sparkol");
const outDir = join(here, "stills");

const GESTURES = listGestures(sparkolDir);
const roles = new Map<string, string[]>();
for (const g of GESTURES) {
  const list = roles.get(g.persona) ?? [];
  if (!list.includes(g.role)) list.push(g.role);
  roles.set(g.persona, list);
}
console.error(
  `手势素材 ${GESTURES.length} 条：` +
    [...roles].map(([p, r]) => `${p}[${r.join("/")}]`).join(" "),
);

/**
 * 搬进来的"外部图片"。
 *
 * 用仓库里的 Pexels 照片；没有的话退化成一块占位色卡 —— demo 不该因为
 * 素材没下就跑不起来。
 */
function externalImageUri(): string {
  try {
    const stack = [join(here, "assets/pexels")];
    while (stack.length > 0) {
      const d = stack.pop()!;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(jpe?g|png)$/i.test(e.name)) {
          const mime = /\.png$/i.test(e.name) ? "image/png" : "image/jpeg";
          return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
        }
      }
    }
  } catch {
    // 目录不存在 → 用占位色卡
  }
  const ph =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">` +
    `<rect width="640" height="420" fill="#dfe6ee"/>` +
    `<rect x="20" y="20" width="600" height="380" fill="none" stroke="#8a97a6" stroke-width="6" stroke-dasharray="18 12"/>` +
    `<circle cx="220" cy="170" r="60" fill="#b9c6d4"/>` +
    `<path d="M90 360 L260 190 L370 300 L470 210 L560 360 Z" fill="#a8b7c7"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(ph).toString("base64")}`;
}

const l = LANDSCAPE;
const ctx: BlockCtx = { ink: INK, accent: ACCENT, beat: 0.32, layout: l };
const kit: HandKit = loadHandKit(GESTURES, PERSONA, INK, {
  canvasWidth: l.width,
  canvasHeight: l.height,
});
console.error(
  `${PERSONA}: write=${kit.write?.asset.slug ?? "—"} erase=${kit.erase?.asset.slug ?? "—"} ` +
    `carry=${kit.carry?.asset.slug ?? "—"} point=${kit.point?.asset.slug ?? "—"}`,
);

const els: GestureEl[] = [];

/* 1 —— 写标题（书写手） */
const title = titleBlock(
  "手势能讲的事",
  {
    x: l.marginX,
    y: l.marginTop,
    size: l.type.title,
    t0: 0.3,
    perChar: l.type.titlePerChar,
    underline: 1,
    underlineAccent: true,
    idp: "gT",
  },
  ctx,
);
els.push(...title.els);
let t = title.endT + 0.4;

/* 2 —— 搬入外部图片（搬移手） */
const imgW = 620;
const imgH = 410;
const carry = carryInEl({
  href: externalImageUri(),
  x: l.width - l.marginX - imgW,
  y: title.bottomY + 70,
  w: imgW,
  h: imgH,
  t0: t,
  from: "right",
  hand: kit.carry,
  canvasW: l.width,
  canvasH: l.height,
  frame: { color: INK, width: 6 },
});
els.push(carry);
t = carry.t1 + 0.3;

/* 3 —— 写一条"假设"，然后擦掉（橡皮擦手） */
const hypoY = title.bottomY + 110;
const hypoSize = l.type.body;
const hypo = markerTextEl("假设不用手势", {
  x: l.marginX,
  y: hypoY,
  size: hypoSize,
  gap: hypoSize * 0.06,
  t0: t,
  perChar: l.type.bodyPerChar,
  color: INK,
  idp: "gH",
});
const hypoW = textWidth("假设不用手势", hypoSize, hypoSize * 0.06);
const erase = eraseEl({
  target: hypo,
  x: l.marginX - 20,
  y: hypoY - 16,
  w: hypoW + 40,
  h: hypoSize * 1.35,
  t0: hypo.t1 + 0.45,
  dur: 1.0,
  rows: 3,
  hand: kit.erase,
  idp: "gE",
});
els.push(erase);
t = erase.eraseT1 + 0.3;

/* 4 —— 指着搬进来的图强调（指示手） */
const point = pointEl({
  x: l.width - l.marginX - imgW * 0.5,
  y: title.bottomY + 70 + imgH * 0.62,
  t0: t,
  dur: 1.4,
  taps: 2,
  hand: kit.point,
  from: "bottom",
  canvasW: l.width,
  canvasH: l.height,
  ring: { color: ACCENT, r: 90, width: 5 },
});
els.push(point);
const totalSec = point.t1 + 0.8;

/** 整帧装配：手势手优先，没有手势时才画书写手. */
function frameSvg(time: number): string {
  const penEls = penElements(els);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}">`,
    `<defs>${boardDefs(BOARD_PAPER)}${markerPenDefs(PEN)}</defs>`,
    boardSurfaceSvg(0, 0, l.width, l.height),
  ];
  for (const el of els) parts.push(el.svg(time));

  const cue = activeHandCue(els, time);
  if (cue !== null) {
    parts.push(handCueSvg(cue));
  } else {
    const pose = penPoseAt(time, penEls, 31);
    if (pose !== null && kit.write !== null) {
      parts.push(
        handCueSvg({ rt: kit.write, x: pose.x, y: pose.y, lift: pose.lift }),
      );
    }
  }
  parts.push(boardOverlaySvg(0, 0, l.width, l.height, BOARD_PAPER));
  parts.push(`</svg>`);
  return parts.join("\n");
}

async function rasterize(svg: string, outPath: string): Promise<void> {
  let png: Uint8Array;
  try {
    png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  } catch (cause) {
    throw new RenderError(
      `帧栅格化失败: ${basename(outPath)}（svg ${svg.length} 字符）`,
      { cause },
    );
  }
  const tmp = `${outPath}.tmp`;
  try {
    await writeFile(tmp, png);
    await rename(tmp, outPath);
  } catch (cause) {
    throw new IoError(`帧写入失败: ${outPath}`, { cause });
  }
}

await mkdir(outDir, { recursive: true });
console.error(`时长 ${totalSec.toFixed(1)}s，元素 ${els.length}`);

if (process.argv.includes("--video")) {
  const framesDir = join(here, "frames-gesture");
  const vidDir = join(here, "out");
  await mkdir(framesDir, { recursive: true });
  await mkdir(vidDir, { recursive: true });
  const total = Math.round(totalSec * DEFAULT_FPS);
  for (let f = 0; f < total; f++) {
    await rasterize(
      frameSvg(f / DEFAULT_FPS),
      join(framesDir, `g-${String(f).padStart(5, "0")}.png`),
    );
    if (f % 60 === 0) console.error(`  帧 ${f}/${total}`);
  }
  const outPath = join(vidDir, "gesture-demo.mp4");
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-y",
      "-framerate",
      String(DEFAULT_FPS),
      "-i",
      join(framesDir, "g-%05d.png"),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    console.error(stderr.slice(-1200));
    throw new RenderError("ffmpeg 合成失败");
  }
  console.log(`完成：${outPath}`);
} else {
  const shots: Array<[string, number]> = [
    ["write", title.els[0]!.t0 + (title.els[0]!.t1 - title.els[0]!.t0) * 0.6],
    ["carry-mid", carry.t0 + (carry.landedAt - carry.t0) * 0.45],
    ["carry-land", carry.landedAt - 0.05],
    ["carry-release", (carry.landedAt + carry.t1) / 2],
    ["erase-mid", (erase.eraseT0 + erase.eraseT1) / 2],
    ["erase-done", erase.eraseT1 + 0.1],
    ["point", point.t0 + (point.t1 - point.t0) * 0.5],
    ["final", totalSec - 0.1],
  ];
  for (const [name, time] of shots) {
    await rasterize(
      frameSvg(Math.max(0, Math.min(time, totalSec))),
      join(outDir, `gesture-${name}.png`),
    );
  }
  console.error(`→ stills/gesture-{${shots.map((s) => s[0]).join(",")}}.png`);
}
