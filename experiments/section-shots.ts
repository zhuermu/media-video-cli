/**
 * 逐段收尾帧：每一段结束前 0.4 秒渲一帧，用来复核**这一段画完的样子**。
 *
 * 为什么不用 `--only-stills`：stills 取的是每段"说话中"的一刻，那时板书往往只
 * 画了一半（板书是摊在整段旁白上的）。要判断一个块的版式对不对，得看它画完。
 *
 * 用法：bun run experiments/section-shots.ts <文章> <kind:long|short> <输出目录>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { prepareVideo } from "../src/core/whiteboard-video/pipeline";

const [article, kind = "long", outDir = "/tmp/section-shots"] =
  process.argv.slice(2);
if (article === undefined) throw new Error("用法：<文章> <kind> <输出目录>");

const v = await prepareVideo({
  articlePath: article,
  kind: kind as "long" | "short",
  log: () => {},
});
mkdirSync(outDir, { recursive: true });
for (const p of v.storyboard.placed) {
  // 段末最后 ~2 秒镜头已经开始平移到下一格（PAN_SEC 1.5 + AFTER_PAN 0.3），
  // 那时画面里是空白的新地盘。所以取"平移开始之前"那一刻。
  const t = Math.max(p.start + 0.5, p.end - 2.4);
  const png = new Resvg(v.frameSvg(t), {
    font: { loadSystemFonts: false },
  }).render();
  const f = join(outDir, `s${p.index}.png`);
  writeFileSync(f, png.asPng());
  console.log(`${f}  t=${t.toFixed(2)}`);
}
