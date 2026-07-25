/**
 * whiteboard-demo v2 — @core/whiteboard 生产模块的验收驱动脚本。
 *
 * 场景用与真实 script 一致的场景 DSL 声明（语义化、零坐标），时长用
 * 模拟的"实测段时长"。正式管线里两者分别来自 script.json 与
 * durations.json。
 *
 * 运行（media-video-agent/ 下）：
 *   bun run experiments/whiteboard-demo/demo.ts            # 全片 → mp4
 *   bun run experiments/whiteboard-demo/demo.ts --stills   # 关键帧 PNG
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { rasterize } from "../../src/core/cards/index";
import {
  DEFAULT_FPS,
  THEMES,
  frameSvg,
  planWhiteboard,
  renderWhiteboardFrames,
} from "../../src/core/whiteboard/index";
import type { WhiteboardScene } from "../../src/core/whiteboard/index";
import { Resvg } from "@resvg/resvg-js";

/* —— 占位照片：内联 SVG 风景渲染成 PNG data URI（demo 专用） —— */
function placeholderPhoto(): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="470">`,
    `<rect width="560" height="470" fill="#ddeefb"/>`,
    `<circle cx="430" cy="100" r="62" fill="#f9c23c"/>`,
    `<polygon points="0,470 210,190 400,470" fill="#9db4c8"/>`,
    `<polygon points="280,470 440,240 560,400 560,470" fill="#7e97ad"/>`,
    `</svg>`,
  ].join("");
  const png = new Resvg(svg).render().asPng();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/* —— 场景 DSL（对应 script.segments[].scene） —— */
const scenes: WhiteboardScene[] = [
  {
    elements: [
      { type: "title", text: "手绘白板" },
      { type: "text", text: "真笔顺 · 一笔一画" },
    ],
  },
  {
    elements: [
      { type: "sticker", name: "blob" },
      { type: "chart", chart: "bars-up", label: "增长" },
    ],
  },
  {
    elements: [
      { type: "icon", name: "lightbulb", accent: true, label: "灵感" },
      { type: "bullet", text: "要点清晰" },
      { type: "bullet", text: "节奏自然" },
    ],
  },
  {
    elements: [
      { type: "image", src: "demo-photo", circle: true, label: "图片拉入" },
    ],
  },
];

/* —— 模拟实测段时长（正式管线来自 durations.json） —— */
const durations = [5.5, 6.5, 7.0, 6.0];

const plan = planWhiteboard(scenes, durations, {
  theme: THEMES["clean"]!,
  imageDataUris: new Map([["demo-photo", placeholderPhoto()]]),
});

const here = new URL(".", import.meta.url).pathname;

if (process.argv.includes("--stills")) {
  const stillsDir = join(here, "stills-v2");
  await mkdir(stillsDir, { recursive: true });
  const times = [2.2, 5.0, 8.5, 11.5, 14.5, 17.5, 20.5, plan.totalSec - 0.8];
  for (const t of times) {
    const svg = frameSvg(plan, Math.min(t, plan.totalSec - 0.05));
    await rasterize(svg, join(stillsDir, `still-${t.toFixed(1)}.png`));
    console.error(`still @${t.toFixed(1)}s`);
  }
  console.log(`总长 ${plan.totalSec.toFixed(1)}s；关键帧 → ${stillsDir}`);
} else {
  const framesDir = join(here, "frames");
  const outDir = join(here, "out");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const started = Date.now();
  const frames = await renderWhiteboardFrames(plan, framesDir, {
    fps: DEFAULT_FPS,
    onProgress: (done, total) => {
      if (done % 120 === 0 || done === total) {
        console.error(`渲染帧 ${done}/${total}`);
      }
    },
  });
  console.error(
    `帧渲染完成：${frames.length} 帧，${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  const outPath = join(outDir, "whiteboard-demo-v2.mp4");
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-y",
      "-framerate",
      String(DEFAULT_FPS),
      "-i",
      join(framesDir, "wb-%05d.png"),
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
  console.log(
    `完成：${outPath}（${plan.totalSec.toFixed(1)}s @ ${DEFAULT_FPS}fps）`,
  );
}
