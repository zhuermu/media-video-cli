/**
 * whiteboard-poc — 质感升级 PoC（不动生产代码）
 *
 * 目标：对着参考图验证四件事能否在现有 SVG→resvg→ffmpeg 链路里做出来
 *   1. 白板质感（冷白板面 + 日光灯反光 + 边缘压暗 + 铝合金外框）
 *   2. 马克笔笔迹（可变宽度、落笔积墨、提笔渐收、交叠叠深）
 *   3. 结构化版式（标题+双下划线 / 横向流程带 / 打勾清单 / 结论框）
 *   4. 白板马克笔贴图（替代 Apple Pencil）
 *
 * 运行（media-video-agent/ 下）：
 *   bun run experiments/whiteboard-poc/poc.ts            # 关键帧 PNG
 *   bun run experiments/whiteboard-poc/poc.ts --video    # 全片 mp4
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_FPS,
  PEN_EXIT_SEC,
  fmt,
  handwritingFont,
  penPoseAt,
  rasterizeVectorFrame,
} from "../../src/core/whiteboard/index";
import type { TimelineEl } from "../../src/core/whiteboard/index";
import {
  BOARD,
  BOARD_FRAMELESS,
  type BoardStyle,
  boardDefs,
  boardOverlaySvg,
  boardSurfaceSvg,
} from "../../src/core/whiteboard-video/board";
import {
  CONTENT_W,
  G,
  W,
  type BlockCtx,
  boxPath,
  checklist,
  flowBand,
  markerTextEl,
  textWidth,
  titleBlock,
} from "../../src/core/whiteboard-video/blocks";
import { markerStrokesEl } from "../../src/core/whiteboard-video/marker";
import {
  markerNibGlowSvg,
  markerPenDefs,
  markerPenStyle,
  markerPenSvg,
} from "../../src/core/whiteboard-video/pen-marker";

/* —— 配色：黑马克笔为主，强调色只给下划线和勾（参考图的克制） —— */
const INK = "#22262b";
const ACCENT = "#c8483a";
const ctx: BlockCtx = { ink: INK, accent: ACCENT, beat: 0.34 };
const PEN = markerPenStyle(INK, ACCENT);

if (handwritingFont() === null) {
  console.error("警告：未找到手写字体，字形将回退——PoC 观感不可信");
}

/* —— 版式：一屏（1080×1920），组件化装配 —— */
const els: TimelineEl[] = [];

const title = titleBlock(
  "白板手绘视频机",
  {
    x: G.marginX,
    y: G.marginTop,
    size: 118,
    t0: 0.35,
    perChar: 0.5,
    underline: 2,
    underlineAccent: true,
    idp: "T",
  },
  ctx,
);
els.push(...title.els);

const SUB = "一支笔，一块白板，把知识做成流水线";
const subSize = 44;
const subY = title.bottomY + 50;
const sub = markerTextEl(SUB, {
  x: G.marginX + 6,
  y: subY,
  size: subSize,
  gap: subSize * 0.06,
  t0: title.endT + ctx.beat,
  perChar: 0.17,
  color: INK,
  idp: "S",
});
els.push(sub);

const flow = flowBand(
  [
    { icon: "lightbulb", label: "选题" },
    { icon: "sparkles", label: "自动生成" },
    { icon: "rocket", label: "一键成片" },
  ],
  {
    y: subY + subSize * 1.1 + 110,
    t0: sub.t1 + ctx.beat,
    stepSec: 1.1,
    idp: "F",
    accentIndex: 1,
  },
  ctx,
);
els.push(...flow.els);

const list = checklist(
  ["真笔顺手写", "马克笔笔迹", "白板质感", "自动版式"],
  {
    x: G.marginX + 14,
    y: flow.bottomY + 96,
    size: 58,
    lineHeight: 132,
    t0: flow.endT + ctx.beat,
    perChar: 0.2,
    idp: "L",
    checkAccent: true,
  },
  ctx,
);
els.push(...list.els);

/* —— 结论框：手绘方框 + 框内手写（展示"框+文字"组合件） —— */
const CALLOUT = "十分钟，出一条片";
const calloutSize = 56;
const calloutY = list.bottomY + 96;
const calloutH = 142;
const calloutBox = markerStrokesEl(
  [boxPath(G.marginX, calloutY, CONTENT_W, calloutH)],
  {
    t0: list.endT + ctx.beat,
    dur: 0.7,
    color: INK,
    width: W.frame,
    seed: "CO",
    amp: 3.4,
    overshoot: false,
  },
);
els.push(calloutBox);
const calloutW = textWidth(CALLOUT, calloutSize, calloutSize * 0.06);
const calloutText = markerTextEl(CALLOUT, {
  x: G.marginX + (CONTENT_W - calloutW) / 2,
  y: calloutY + (calloutH - calloutSize) / 2,
  size: calloutSize,
  gap: calloutSize * 0.06,
  t0: calloutBox.t1 + ctx.beat * 0.5,
  perChar: 0.24,
  color: INK,
  idp: "CT",
});
els.push(calloutText);

const totalSec = calloutText.t1 + 1.4;
const penExitAt = calloutText.t1 + PEN_EXIT_SEC;
const penEls = els.filter(
  (e): e is TimelineEl & { pen: NonNullable<TimelineEl["pen"]> } =>
    e.pen !== undefined,
);

console.error(
  `版式底边 ${fmt(calloutY + calloutH)} / 1920；时长 ${totalSec.toFixed(1)}s`,
);

/* —— 整帧装配：板面(画布层) → 内容 → 笔 → 白板光学层(屏幕固定) —— */
function pocFrameSvg(t: number, board: BoardStyle = BOARD): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${G.width}" height="${G.height}" viewBox="0 0 ${G.width} ${G.height}">`,
    `<defs>${boardDefs(board)}${markerPenDefs(PEN)}</defs>`,
    boardSurfaceSvg(0, 0, G.width, G.height),
  ];
  for (const el of els) parts.push(el.svg(t));
  if (t < penExitAt) {
    const pose = penPoseAt(t, penEls, 31);
    if (pose !== null) {
      parts.push(markerNibGlowSvg(pose), markerPenSvg(pose, PEN));
    }
  }
  parts.push(boardOverlaySvg(0, 0, G.width, G.height, board));
  parts.push(`</svg>`);
  return parts.join("\n");
}

const here = new URL(".", import.meta.url).pathname;

if (process.argv.includes("--video")) {
  const framesDir = join(here, "frames");
  const outDir = join(here, "out");
  await mkdir(framesDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const total = Math.round(totalSec * DEFAULT_FPS);
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    await rasterizeVectorFrame(
      pocFrameSvg(f / DEFAULT_FPS),
      join(framesDir, `poc-${String(f).padStart(5, "0")}.png`),
    );
    if (f % 60 === 0) console.error(`帧 ${f}/${total}`);
  }
  const perFrame = (Date.now() - started) / total;
  console.error(`帧渲染 ${total} 帧，${perFrame.toFixed(0)}ms/帧`);
  const outPath = join(outDir, "whiteboard-poc.mp4");
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-y",
      "-framerate",
      String(DEFAULT_FPS),
      "-i",
      join(framesDir, "poc-%05d.png"),
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
    console.error(stderr.slice(-1500));
    throw new Error("ffmpeg 合成失败");
  }
  console.log(`完成：${outPath}`);
} else {
  const stillsDir = join(here, "stills");
  await mkdir(stillsDir, { recursive: true });
  const times = [
    title.endT - 0.3,
    sub.t1 + 0.1,
    flow.endT * 0.72,
    flow.endT + 0.2,
    list.endT + 0.1,
    totalSec - 0.2,
  ];
  const started = Date.now();
  for (const t of times) {
    const tc = Math.max(0, Math.min(t, totalSec));
    await rasterizeVectorFrame(
      pocFrameSvg(tc),
      join(stillsDir, `poc-${tc.toFixed(1)}.png`),
    );
    console.error(`still @${tc.toFixed(1)}s`);
  }
  // 无框变体：同一帧两种白板处理，对比取舍
  await rasterizeVectorFrame(
    pocFrameSvg(totalSec - 0.2, BOARD_FRAMELESS),
    join(stillsDir, "variant-frameless.png"),
  );
  console.error("variant: frameless");
  console.log(
    `关键帧 → ${stillsDir}（${((Date.now() - started) / times.length).toFixed(0)}ms/帧）`,
  );
}
