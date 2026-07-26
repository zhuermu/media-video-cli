/**
 * scribe-demo — VideoScribe 风格，同一份内容出横屏 + 竖屏。
 *
 * 三件事在这里合流：
 * 1. 画布换成 VideoScribe 那种干净白纸（`BOARD_PAPER`），去掉铝框/反光/暗角
 * 2. 显现动效换成 `scribble`（手拿笔来回涂抹，画面在掠过处出现）
 * 3. 笔改成手势贴图（`assets/hand/` 有素材就用，没有就回退矢量马克笔）
 *
 * 版式不是等比缩放：竖屏单栏纵向流，横屏双栏（左文右图）——见 layout.ts。
 *
 * 运行（media-video-cli/ 下）：
 *   bun run experiments/whiteboard-poc/scribe-demo.ts             # 两个画幅各出关键帧
 *   bun run experiments/whiteboard-poc/scribe-demo.ts --video     # 两个画幅各出 mp4
 */

import { readFileSync } from "node:fs";
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
import type { BlockCtx } from "../../src/core/whiteboard-video/blocks";
import {
  checklist,
  flowBand,
  markerTextEl,
  textWidth,
  titleBlock,
} from "../../src/core/whiteboard-video/blocks";
import {
  flatDefs,
  flatIllustrationEl,
  importFlatSvg,
} from "../../src/core/whiteboard-video/flat-import";
import type { FlatIllustration } from "../../src/core/whiteboard-video/flat-import";
import {
  findHand,
  handGroups,
  handSvg,
  listHands,
  loadHand,
} from "../../src/core/whiteboard-video/hand";
import type { HandRuntime } from "../../src/core/whiteboard-video/hand";
import type { Layout } from "../../src/core/whiteboard-video/layout";
import {
  LANDSCAPE,
  PORTRAIT,
  contentW,
  leftCol,
  rightCol,
} from "../../src/core/whiteboard-video/layout";
import {
  markerNibGlowSvg,
  markerPenDefs,
  markerPenStyle,
  markerPenSvg,
} from "../../src/core/whiteboard-video/pen-marker";

const INK = "#22262b";
const ACCENT = "#c8483a";
const PEN = markerPenStyle(INK, ACCENT);

import { repoAssetsRoot } from "../../src/core/whiteboard-video/config";

/** 仓库的素材根（手势库与插画库都在这儿）. */
const ASSETS = repoAssetsRoot();
const here = new URL(".", import.meta.url).pathname;
const flatDir = join(ASSETS, "manypixels");
const sparkolDir = join(ASSETS, "sparkol");
const outDir = join(here, "stills");

/** 用哪只手（slug 片段即可，见 hands-index.json）. */
const HAND_PICK = process.env["HAND"] ?? "suneeta-black-marker";
const HANDS = listHands(sparkolDir);
const HAND_ASSET = findHand(HANDS, HAND_PICK);
if (HANDS.length === 0) {
  console.error(`手部素材未就绪（${sparkolDir}）→ 回退矢量马克笔`);
} else {
  const groups = [...handGroups(sparkolDir)]
    .map(([g, n]) => `${g}:${n}`)
    .join(" ");
  console.error(
    `手部素材 ${HANDS.length} 只（${groups}）→ 使用 ${HAND_ASSET?.group}/${HAND_ASSET?.slug}`,
  );
}

/* —— 内容（与画幅无关，两个版本共用同一份文案） —— */
const CONTENT = {
  title: "为什么要做自动化",
  subtitle: "重复劳动交给流水线，脑力留给判断",
  hero: "il-01.svg",
  bullets: ["选题不再空转", "出片速度翻倍", "风格保持统一"],
  flow: [
    { icon: "lightbulb", label: "选题" },
    { icon: "sparkles", label: "生成" },
    { icon: "rocket", label: "成片" },
  ],
} as const;

interface Scene {
  els: TimelineEl[];
  ils: FlatIllustration[];
  totalSec: number;
  /**
   * 关键帧锚点（秒）。按**元素实际时间**取点，不能按总时长的百分比——
   * 文字段落远长于插画段落，百分比取样会全落在写字阶段。
   */
  anchors: { titleDone: number; scribbling: number; revealed: number };
}

/** 按画幅装配一屏（竖屏单栏纵向；横屏双栏，左文右图）. */
function build(l: Layout, idp: string): Scene {
  const ctx: BlockCtx = { ink: INK, accent: ACCENT, beat: 0.32, layout: l };
  const els: TimelineEl[] = [];
  const ils: FlatIllustration[] = [];
  const T = l.type;

  const title = titleBlock(
    CONTENT.title,
    {
      x: l.marginX,
      y: l.marginTop,
      size: T.title,
      t0: 0.3,
      perChar: T.titlePerChar,
      underline: 2,
      underlineAccent: true,
      idp: `${idp}T`,
    },
    ctx,
  );
  els.push(...title.els);

  const subY = title.bottomY + T.title * 0.4;
  const sub = markerTextEl(CONTENT.subtitle, {
    x: l.marginX + 6,
    y: subY,
    size: T.subtitle,
    gap: T.subtitle * 0.06,
    t0: title.endT + ctx.beat,
    perChar: T.bodyPerChar * 0.9,
    color: INK,
    idp: `${idp}S`,
  });
  els.push(sub);

  const bodyTop = subY + T.subtitle * 1.5;
  const hero = importFlatSvg(
    readFileSync(join(flatDir, CONTENT.hero), "utf8"),
    `${idp}h_`,
  );
  ils.push(hero);

  let t = sub.t1 + ctx.beat;
  let heroEl: TimelineEl;
  let listY: number;
  let listX: number;

  if (l.columns === 2) {
    // 横屏：插画占右栏，文字留左栏 —— 纵向只有 1080，堆不下"图在上、字在下"
    const rc = rightCol(l);
    const lc = leftCol(l);
    const heroSize = Math.min(rc.w, l.height - bodyTop - l.marginBottom);
    heroEl = flatIllustrationEl(hero, {
      cx: rc.x + rc.w / 2,
      cy: bodyTop + heroSize / 2,
      size: heroSize,
      t0: t,
      dur: 2.4,
      reveal: "scribble",
      scribbleRows: 9,
    });
    els.push(heroEl);
    t = heroEl.t1 + ctx.beat;
    listX = lc.x + 8;
    listY = bodyTop + T.body * 0.6;
  } else {
    // 竖屏：单栏纵向流，插画在中段
    const heroSize = Math.min(contentW(l) * 0.86, 760);
    heroEl = flatIllustrationEl(hero, {
      cx: l.width / 2,
      cy: bodyTop + heroSize / 2,
      size: heroSize,
      t0: t,
      dur: 2.4,
      reveal: "scribble",
      scribbleRows: 8,
    });
    els.push(heroEl);
    t = heroEl.t1 + ctx.beat;
    listX = l.marginX + 14;
    listY = bodyTop + heroSize + T.body * 0.9;
  }

  const lineHeight = T.body * 2.15;
  const list = checklist(
    CONTENT.bullets,
    {
      x: listX,
      y: listY,
      size: T.body,
      lineHeight,
      t0: t,
      perChar: T.bodyPerChar,
      idp: `${idp}L`,
      checkAccent: true,
    },
    ctx,
  );
  els.push(...list.els);
  t = list.endT + ctx.beat;

  // 横屏左栏下方还有空间，补一条流程带（竖屏已经排满，不加）
  if (l.columns === 2) {
    const lc = leftCol(l);
    const bandY = list.bottomY + T.body * 0.9;
    if (bandY + 300 < l.height - l.marginBottom) {
      const band = flowBand(
        CONTENT.flow,
        {
          x: lc.x,
          w: lc.w,
          y: bandY,
          t0: t,
          stepSec: 0.95,
          idp: `${idp}F`,
          accentIndex: 1,
        },
        ctx,
      );
      els.push(...band.els);
      t = band.endT;
    }
  }

  return {
    els,
    ils,
    totalSec: t + 1.1,
    anchors: {
      titleDone: title.endT + 0.15,
      scribbling: heroEl.t0 + (heroEl.t1 - heroEl.t0) * 0.55,
      revealed: heroEl.t1 + 0.2,
    },
  };
}

/** 整帧装配：白画布 → 插画 defs → 内容 → 手/笔 → 极轻边缘收口. */
function frameSvg(
  l: Layout,
  sc: Scene,
  t: number,
  hand: HandRuntime | null,
): string {
  const penEls = sc.els.filter(
    (e): e is TimelineEl & { pen: NonNullable<TimelineEl["pen"]> } =>
      e.pen !== undefined,
  );
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}">`,
    `<defs>${boardDefs(BOARD_PAPER)}${markerPenDefs(PEN)}</defs>`,
    sc.ils.map((il) => flatDefs(il)).join(""),
    boardSurfaceSvg(0, 0, l.width, l.height),
  ];
  for (const el of sc.els) parts.push(el.svg(t));
  const pose = penPoseAt(t, penEls, 31);
  if (pose !== null) {
    if (hand !== null) {
      parts.push(handSvg(pose, hand));
    } else {
      parts.push(markerNibGlowSvg(pose), markerPenSvg(pose, PEN));
    }
  }
  parts.push(boardOverlaySvg(0, 0, l.width, l.height, BOARD_PAPER));
  parts.push(`</svg>`);
  return parts.join("\n");
}

/**
 * 栅格化。相对 `resourcesDir` 解析 `<image href>` —— 手势 PNG 走文件引用
 * 而不是逐帧 base64 内联（后者会让每帧 SVG 膨胀几百 KB）。
 */
async function rasterize(svg: string, outPath: string): Promise<void> {
  let png: Uint8Array;
  try {
    // 不传 resourcesDir：实测每帧 75ms → 608ms（见 hand.ts 模块注释）。
    // 手部 PNG 走内联 data URI，装载期已缩到显示尺寸。
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
const wantVideo = process.argv.includes("--video");

for (const l of [PORTRAIT, LANDSCAPE]) {
  const tag = l.orientation;
  const sc = build(l, tag[0]!);
  const hand =
    HAND_ASSET === null
      ? null
      : loadHand(HAND_ASSET, {
          canvasWidth: l.width,
          canvasHeight: l.height,
          handSize: 460,
        });
  console.error(
    `${tag} ${l.width}×${l.height}：元素 ${sc.els.length}，时长 ${sc.totalSec.toFixed(1)}s`,
  );

  if (wantVideo) {
    const framesDir = join(here, `frames-${tag}`);
    const vidDir = join(here, "out");
    await mkdir(framesDir, { recursive: true });
    await mkdir(vidDir, { recursive: true });
    const total = Math.round(sc.totalSec * DEFAULT_FPS);
    const started = Date.now();
    for (let f = 0; f < total; f++) {
      await rasterize(
        frameSvg(l, sc, f / DEFAULT_FPS, hand),
        join(framesDir, `sc-${String(f).padStart(5, "0")}.png`),
      );
      if (f % 90 === 0) console.error(`  ${tag} 帧 ${f}/${total}`);
    }
    console.error(
      `  ${tag} ${total} 帧，${((Date.now() - started) / total).toFixed(0)}ms/帧`,
    );
    const outPath = join(vidDir, `scribe-${tag}.mp4`);
    const proc = Bun.spawn({
      cmd: [
        "ffmpeg",
        "-y",
        "-framerate",
        String(DEFAULT_FPS),
        "-i",
        join(framesDir, "sc-%05d.png"),
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
      throw new RenderError(`ffmpeg 合成失败: ${tag}`);
    }
    console.log(`完成：${outPath}`);
  } else {
    // 关键帧：标题写完 / 涂抹中 / 涂抹完 / 全部完成
    const shots: Array<[string, number]> = [
      ["title", sc.anchors.titleDone],
      ["scribbling", sc.anchors.scribbling],
      ["revealed", sc.anchors.revealed],
      ["final", sc.totalSec - 0.15],
    ];
    for (const [name, t] of shots) {
      await rasterize(
        frameSvg(l, sc, Math.max(0, Math.min(t, sc.totalSec)), hand),
        join(outDir, `scribe-${tag}-${name}.png`),
      );
    }
    console.error(
      `  → scribe-${tag}-{${shots.map((s) => s[0]).join(",")}}.png`,
    );
  }
}
