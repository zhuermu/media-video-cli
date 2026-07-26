/**
 * 单帧探针：在指定时刻渲一帧，用来目视复核手的比例。
 *
 * 为什么不用 `--only-stills`：stills 只取每段的"说话中"时刻，而手比例的判据是
 * **全片笔尖最高的那一帧**（通常是写标题的第一个字），那一帧 stills 抓不到。
 *
 * 用法：bun run experiments/hand-frame.ts <kind:long|short> <t 秒> <输出 png>
 */
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { prepareVideo } from "../src/core/whiteboard-video/pipeline";

const [kind = "short", tArg = "0", out = "/tmp/hand-frame.png"] =
  process.argv.slice(2);

const v = await prepareVideo({
  articlePath: "experiments/whiteboard-poc/article-chart-demo.md",
  kind: kind as "long" | "short",
  log: () => {},
});
const png = new Resvg(v.frameSvg(Number(tArg)), {
  font: { loadSystemFonts: false },
}).render();
writeFileSync(out, png.asPng());
console.log(`${out}  ${kind} @ ${tArg}s`);
