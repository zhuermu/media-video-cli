/**
 * ```chart bar``` 端到端切片的目视复核
 *
 * 不跑 TTS、不渲整片，只把图表块按真实画幅摆出来看三件事：
 * 1. 刻度与数值对不对（d3-scale 的 nice 域是否让最高柱留了余量）；
 * 2. 横版/竖版两套画幅下会不会挤；
 * 3. **逐拍揭示**中途的样子——图表的教学价值在这一帧上，不在终态。
 *
 * 跑法：bun run experiments/chart-block-check.ts → experiments/chart-block-check.png
 */

import { writeFileSync } from "node:fs";

import { Resvg } from "@resvg/resvg-js";

import { markerTextEl, textWidth } from "../src/core/whiteboard-video/blocks";
import {
  chartBeats,
  parseChartBlock,
} from "../src/core/whiteboard-video/chart-block";
import {
  LANDSCAPE,
  PORTRAIT,
  contentW,
} from "../src/core/whiteboard-video/layout";
import { PALETTE } from "../src/core/whiteboard-video/palette";

const SPEC = parseChartBlock(
  "chart bar 单位=万元",
  "自建 92\n托管 45\n混合 61",
);

const out: string[] = [];
const push = (s: string): void => {
  out.push(s);
};

function text(
  s: string,
  x: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void {
  push(
    markerTextEl(s, {
      x,
      y,
      size,
      gap: size * 0.06,
      t0: 0,
      perChar: 0.01,
      color,
      idp: `t${out.length}`,
    }).svg(9999),
  );
}
const tw = (s: string, size: number): number => textWidth(s, size, size * 0.06);
const textCenter = (
  s: string,
  cx: number,
  y: number,
  size: number,
  color = PALETTE.ink,
): void => text(s, cx - tw(s, size) / 2, y, size, color);

/**
 * 把图表画到指定时刻。
 *
 * 拍子是首尾相接排的（上一拍结束即下一拍开始），与 compose 的排片方式一致；
 * `at` 为 undefined 时取终态。
 */
function renderChart(
  box: { x: number; y: number; w: number; h: number },
  bodySize: number,
  idp: string,
  at?: number,
): { svg: string; total: number } {
  const { beats } = chartBeats(SPEC, box, { ink: PALETTE.ink, bodySize, idp });
  const parts: string[] = [];
  let t = 0;
  const built = beats.map((b) => {
    const r = b.build(t);
    t = r.end;
    return r;
  });
  const when = at ?? t + 1;
  for (const r of built) for (const el of r.els) parts.push(el.svg(when));
  return { svg: parts.join(""), total: t };
}

// 画幅：横版整宽 + 竖版整宽 + 横版揭示中途
const LS = LANDSCAPE;
const PT = PORTRAIT;
const scale = 0.46; // 缩放摆进对照图
const W = 1720;
const H = 1180;

push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
);
push(`<rect width="${W}" height="${H}" fill="#F6F8FB"/>`);
textCenter("```chart bar``` 端到端切片 · 真实刻度与数值", W / 2, 22, 34);

/** 一块面板：白底卡 + 标签 + 里面一张按真实画幅渲的图表（等比缩小） */
function panel(
  title: string,
  note: string,
  px: number,
  py: number,
  pw: number,
  ph: number,
  inner: string,
): void {
  push(
    `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="14" fill="#FFFFFF" stroke="#E3E8EE" stroke-width="2"/>`,
  );
  const lw = tw(title, 21) + 26;
  push(
    `<rect x="${px + 14}" y="${py - 12}" width="${lw}" height="37" rx="8" fill="${PALETTE.primary}" opacity="0.15"/>`,
  );
  text(title, px + 27, py - 4, 21);
  push(inner);
  text(note, px + 18, py + ph - 30, 15, PALETTE.muted);
}

// —— 横版（1920×1080）整宽，正文字号取该画幅的 body ——
{
  const box = { x: LS.marginX, y: 260, w: contentW(LS), h: 520 };
  const r = renderChart(box, LS.type.body, "ls");
  const px = 30;
  const py = 90;
  const pw = LS.width * scale + 40;
  const ph = 470;
  panel(
    "横版 1920×1080 · 整宽（本段无要点）",
    `终态 · 单段图表时长 ${r.total.toFixed(1)}s`,
    px,
    py,
    pw,
    ph,
    `<g transform="translate(${px + 20},${py + 40}) scale(${scale})">` +
      `<rect x="0" y="200" width="${LS.width}" height="640" fill="#fff" stroke="#EDF1F5" stroke-width="4"/>` +
      r.svg +
      `</g>`,
  );
}

// —— 竖版（1080×1920）整宽 ——
{
  const box = { x: PT.marginX, y: 300, w: contentW(PT), h: 700 };
  const r = renderChart(box, PT.type.body, "pt");
  const s2 = 0.4;
  const px = 940;
  const pw = PT.width * s2 + 40;
  const py = 90;
  const ph = 470;
  panel(
    "竖版 1080×1920 · 整宽",
    "同一份数据，刻度与类目在窄画幅下仍可读",
    px,
    py,
    pw,
    ph,
    `<g transform="translate(${px + 20},${py + 40}) scale(${s2})">` +
      `<rect x="0" y="240" width="${PT.width}" height="820" fill="#fff" stroke="#EDF1F5" stroke-width="5"/>` +
      r.svg +
      `</g>`,
  );
}

// —— 揭示中途（教学价值在这里）——
{
  const box = { x: LS.marginX, y: 260, w: contentW(LS), h: 520 };
  const full = renderChart(box, LS.type.body, "mid");
  const px = 30;
  const py = 640;
  const pw = LS.width * scale + 40;
  const ph = 470;
  // 取"第二根柱子刚画完"附近：坐标系已就位，柱子只出来两根
  const at = full.total * 0.62;
  const r = renderChart(box, LS.type.body, "mid", at);
  panel(
    "揭示中途（t ≈ 62%）",
    "坐标系先就位，柱子跟着讲解一根根升起——这才是图表的教学价值",
    px,
    py,
    pw,
    ph,
    `<g transform="translate(${px + 20},${py + 40}) scale(${scale})">` +
      `<rect x="0" y="200" width="${LS.width}" height="640" fill="#fff" stroke="#EDF1F5" stroke-width="4"/>` +
      r.svg +
      `</g>`,
  );
}

// —— 校验示例（作者写错时看到什么）——
{
  const px = 940;
  const py = 640;
  const pw = 750;
  const ph = 470;
  push(
    `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="14" fill="#FFFFFF" stroke="#E3E8EE" stroke-width="2"/>`,
  );
  const lw = tw("超限与写错：当场报错，不静默降级", 21) + 26;
  push(
    `<rect x="${px + 14}" y="${py - 12}" width="${lw}" height="37" rx="8" fill="${PALETTE.danger}" opacity="0.14"/>`,
  );
  text("超限与写错：当场报错，不静默降级", px + 27, py - 4, 21);
  const cases: Array<[string, string]> = [
    ["7 条数据", "要求 2–6 条，请把这一段拆成两段"],
    ["托管很贵", "数据行读不懂（应为「标签 数值」）"],
    ["自建 -5", "数值须为非负数"],
    ["这个类目名字太长了 92", "类目名过长（上限 6 字）"],
    ["甲 0 / 乙 0", "所有数值都是 0，画不出可比较的图形"],
    ["图表 + 插画同段", "抢同一个媒体位，请拆成两段"],
  ];
  cases.forEach(([bad, msg], i) => {
    const y = py + 46 + i * 62;
    text(`✗ ${bad}`, px + 26, y, 24, PALETTE.danger);
    text(msg, px + 46, y + 30, 19, PALETTE.muted);
  });
}

push(`</svg>`);

const svg = out.join("\n");
const png = new Resvg(svg, { font: { loadSystemFonts: false } })
  .render()
  .asPng();
const dest = new URL("./chart-block-check.png", import.meta.url).pathname;
writeFileSync(dest, png);
console.error(`→ ${dest}`);
