/**
 * 验证 flat-import.ts：扁平彩色插画（ManyPixels）+ 三种入场动效，
 * 缝在白板 + 马克笔手写的叙事里。
 *
 * 三张对比图：
 *   flat-layers  按语义图层依次淡入上浮（最"扁平化动画"）
 *   flat-sweep   软边遮罩横扫 + 马克笔跟着边缘走（最"白板手绘"）
 *   flat-scene   实战构图：手写标题 + 插画 + 手写要点
 *
 * 运行（media-video-cli/ 下）：
 *   bun run experiments/whiteboard-poc/flat-demo.ts
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
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
  checklist,
  markerTextEl,
  textWidth,
  titleBlock,
} from "../../src/core/whiteboard-video/blocks";
import type { BlockCtx } from "../../src/core/whiteboard-video/blocks";
import {
  flatDefs,
  flatIllustrationEl,
  importFlatSvg,
} from "../../src/core/whiteboard-video/flat-import";
import type {
  FlatIllustration,
  FlatReveal,
} from "../../src/core/whiteboard-video/flat-import";
import {
  markerNibGlowSvg,
  markerPenDefs,
  markerPenStyle,
  markerPenSvg,
} from "../../src/core/whiteboard-video/pen-marker";

const INK = "#22262b";
const ACCENT = "#c8483a";
const ctx: BlockCtx = { ink: INK, accent: ACCENT, beat: 0.34 };
const PEN = markerPenStyle(INK, ACCENT);

import { repoAssetsRoot } from "../../src/core/whiteboard-video/config";

/** 仓库的素材根（手势库与插画库都在这儿）. */
const ASSETS = repoAssetsRoot();
const here = new URL(".", import.meta.url).pathname;
const assetDir = join(ASSETS, "manypixels");
const outDir = join(here, "stills");
await mkdir(outDir, { recursive: true });

function load(file: string, prefix: string): FlatIllustration {
  return importFlatSvg(readFileSync(join(assetDir, file), "utf8"), prefix);
}

/** 一屏的装配（板面 → 插画 defs → 内容 → 笔 → 白板光学层）. */
function render(
  els: readonly TimelineEl[],
  ils: readonly FlatIllustration[],
  t: number,
): string {
  const penEls = els.filter(
    (e): e is TimelineEl & { pen: NonNullable<TimelineEl["pen"]> } =>
      e.pen !== undefined,
  );
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${G.width}" height="${G.height}" viewBox="0 0 ${G.width} ${G.height}">`,
    `<defs>${boardDefs(BOARD_FRAMELESS)}${markerPenDefs(PEN)}</defs>`,
    // 每个插画实例的 CSS/渐变各输出一次（已加前缀，互不干扰）
    ils.map((il) => flatDefs(il)).join(""),
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

/* ——— 图 1/2：同一张插画的两种显现模式，各取 60% 进度与完成态 ——— */
const files = ["il-01.svg", "il-02.svg", "il-06.svg", "il-03.svg"] as const;

for (const [mode, dir] of [
  ["layers", "lr"],
  ["sweep", "lr"],
] as const) {
  const ils: FlatIllustration[] = [];
  const els: TimelineEl[] = [];
  const TITLE = mode === "layers" ? "图层依次入场" : "遮罩扫掠显现";
  const title = titleBlock(
    TITLE,
    {
      x: G.marginX,
      y: 190,
      size: 92,
      t0: 0,
      perChar: 0.34,
      underline: 1,
      underlineAccent: true,
      idp: `FT${mode}`,
    },
    ctx,
  );
  els.push(...title.els);

  // 2×2 铺四张插画，逐张入场
  const CELL = 470;
  const gx = (G.width - CELL * 2) / 2;
  const gy = 430;
  let t = title.endT + 0.3;
  for (const [i, file] of files.entries()) {
    const il = load(file, `f${mode[0]}${i}_`);
    ils.push(il);
    const el = flatIllustrationEl(il, {
      cx: gx + (i % 2) * CELL + CELL / 2,
      cy: gy + Math.floor(i / 2) * CELL + CELL / 2,
      size: CELL - 40,
      t0: t,
      dur: mode === "sweep" ? 1.5 : 1.8,
      reveal: mode as FlatReveal,
      sweepDir: dir,
    });
    els.push(el);
    t = el.t1 + 0.35;
  }
  const total = t + 0.5;
  // 60% 处能同时看到"已完成/正在进/未开始"三种状态
  await rasterizeVectorFrame(
    render(els, ils, total * 0.62),
    join(outDir, `flat-${mode}-mid.png`),
  );
  await rasterizeVectorFrame(
    render(els, ils, total),
    join(outDir, `flat-${mode}-final.png`),
  );
  console.error(
    `flat-${mode}: 4 张插画，图层数 ${ils.map((i) => i.layers.length).join("/")}，总长 ${total.toFixed(1)}s`,
  );
}

/* ——— 图 3：实战构图 ——— */
{
  const ils: FlatIllustration[] = [];
  const els: TimelineEl[] = [];
  const title = titleBlock(
    "为什么要做自动化",
    {
      x: G.marginX,
      y: 200,
      size: 104,
      t0: 0.3,
      perChar: 0.42,
      underline: 2,
      underlineAccent: true,
      idp: "SC",
    },
    ctx,
  );
  els.push(...title.els);

  const SUB = "重复劳动交给流水线，脑力留给判断";
  const subSize = 44;
  const subY = title.bottomY + 46;
  const sub = markerTextEl(SUB, {
    x: G.marginX + 6,
    y: subY,
    size: subSize,
    gap: subSize * 0.06,
    t0: title.endT + ctx.beat,
    perChar: 0.16,
    color: INK,
    idp: "SS",
  });
  els.push(sub);

  const hero = load("il-01.svg", "hero_");
  ils.push(hero);
  const heroEl = flatIllustrationEl(hero, {
    cx: G.width / 2,
    cy: subY + subSize + 400,
    size: 760,
    t0: sub.t1 + ctx.beat,
    dur: 2.2,
    reveal: "layers",
    // 先人物、再图表器件（讲述顺序：谁在做 → 做出了什么）
    layerOrder: ["character", "files", "chart", "graph-1", "graph-2"],
  });
  els.push(heroEl);

  const list = checklist(
    ["选题不再空转", "出片速度翻倍", "风格保持统一"],
    {
      x: G.marginX + 14,
      y: subY + subSize + 830,
      size: 56,
      lineHeight: 124,
      t0: heroEl.t1 + ctx.beat,
      perChar: 0.19,
      idp: "SL",
      checkAccent: true,
    },
    ctx,
  );
  els.push(...list.els);

  const total = list.endT + 0.9;
  await rasterizeVectorFrame(
    render(els, ils, total),
    join(outDir, "flat-scene.png"),
  );
  console.error(
    `flat-scene: hero 图层 ${hero.layers.map((l) => l.name).join(",")}；底边 ${list.bottomY.toFixed(0)}；总长 ${total.toFixed(1)}s`,
  );
}

console.log(`→ ${outDir}/flat-{layers,sweep}-{mid,final}.png, flat-scene.png`);
