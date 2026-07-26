/**
 * @module core/whiteboard-video/chart-block
 *
 * 文章里的 ```chart``` 代码块 → 板上一张**带真实刻度和数值**的图表。
 *
 * ## 这一层解决的是"图表有没有意义"
 *
 * `charts.ts` 只画几何：它吃归一化的 `0..1`，画出来的柱子比例是对的，但观众
 * 看不到"92 还是 9.2"。没有刻度和数值的图表是装饰，不是解释。本模块补上三件
 * 事：`d3-scale` 定出的 nice 刻度、手写的刻度值与数值标签、以及**逐拍揭示**。
 *
 * ## 为什么逐拍揭示是必需的而不是加分项
 *
 * 讲解视频里图表的教学价值主要来自"跟着讲解逐步长出来"。一张完整的图直接
 * 出现在画面上，和一张 PPT 截图没区别；而"先画坐标轴 → 讲到自建时第一根柱子
 * 才升起来 → 讲到托管时第二根才出现"，观众的注意力会被牵着走。所以这里产出的
 * 是**一串拍子**（与 `- 要点` 同一套机制），不是一个元素。
 *
 * ## 刻度为什么交给 d3-scale
 *
 * "最大值 92 时纵轴应该标 0/25/50/75/100 还是 0/20/40/60/80/100"这件事有成熟
 * 算法（nice numbers），自己写会在边界值上出各种别扭刻度（如 0/23/46/69/92）。
 * `d3-scale` 的 `.nice()` + `.ticks()` 正是它。
 *
 * ## 文字为什么必须在这里画
 *
 * 帧渲染器 `loadSystemFonts: false`，`<text>` 会渲成空白，所以所有刻度值、数值、
 * 类目名都得走 `markerTextEl` 的矢量手写路径。这也是"换个图表库就能省事"不成立
 * 的根本原因——库给的标签一律是 `<text>`。
 */

import { scaleLinear } from "d3-scale";

import { ValidationError } from "../errors/index";
import type { Pt, TimelineEl } from "../whiteboard/index";
import { fadeGroup, fadeRect } from "../whiteboard/index";
import { fitSize, markerTextEl, textWidth } from "./blocks";
import { pieChart } from "./charts";
import type { ChartBox } from "./charts";
import { markerStrokesEl } from "./marker";
import { PALETTE, seriesColor } from "./palette";
import type { PaletteRoles } from "./palette";
import { LINE_W } from "./strokes";

/** 支持的图表种类（`bar` 纵向柱状、`pie` 饼图；其余按同一套模式后续填）. */
export const CHART_BLOCK_KINDS = ["bar", "pie"] as const;

export type ChartBlockKind = (typeof CHART_BLOCK_KINDS)[number];

/** 一条数据. */
export interface ChartDatum {
  label: string;
  value: number;
}

/** 解析后的图表块. */
export interface ChartSpec {
  kind: ChartBlockKind;
  data: ChartDatum[];
  /** 单位（写在纵轴上方），无则不写. */
  unit?: string;
}

/**
 * 一段最多几根柱子。
 *
 * 与"要点每段不超过 5 条"同源：超了不是缩字号能救的——刻度值和数值标签一旦
 * 小于可读下限，图表就从"解释"退化成"装饰"。所以超限**当场报错**要求作者拆段，
 * 而不是自动缩放或静默截断。
 */
export const MAX_BARS = 6;
/** 至少两根：一根柱子没有可比性，画图不如直接说数字. */
export const MIN_BARS = 2;

/** 类目名长度上限（超了横排必然互相撞）. */
const MAX_LABEL_LEN = 6;

/**
 * 解析 ```chart``` 块的内容。
 *
 * 块首行形如 `chart bar 单位=万元`（`单位=` 可省），其后每行一条 `标签 数值`。
 * 标签与数值之间用空白或 `|` 分隔，便于对齐着写。
 *
 * @throws ValidationError 种类未知 / 条数越界 / 数值非法 / 标签过长
 */
export function parseChartBlock(info: string, body: string): ChartSpec {
  const tokens = info.trim().split(/\s+/).slice(1); // 去掉开头的 "chart"
  const kindRaw = tokens[0] ?? "";
  if (!(CHART_BLOCK_KINDS as readonly string[]).includes(kindRaw)) {
    throw new ValidationError(
      `图表种类 "${kindRaw}" 不支持；目前只接受 ${CHART_BLOCK_KINDS.join(" | ")}`,
    );
  }
  const kind = kindRaw as ChartBlockKind;

  let unit: string | undefined;
  for (const t of tokens.slice(1)) {
    const m = /^(?:单位|unit)[=＝](.+)$/.exec(t);
    if (m !== null) unit = m[1]!.trim();
  }

  const data: ChartDatum[] = [];
  const bad: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^(.+?)\s*[|｜\s]\s*(-?[\d.]+)$/.exec(line);
    if (m === null) {
      bad.push(line);
      continue;
    }
    const value = Number(m[2]);
    const label = m[1]!.trim();
    if (!Number.isFinite(value) || value < 0) {
      bad.push(line);
      continue;
    }
    data.push({ label, value });
  }

  if (bad.length > 0) {
    throw new ValidationError(
      `图表数据行读不懂（每行应为「标签 数值」，数值须为非负数）：\n  ` +
        bad.join("\n  "),
    );
  }
  if (data.length < MIN_BARS || data.length > MAX_BARS) {
    throw new ValidationError(
      `图表有 ${data.length} 条数据，要求 ${MIN_BARS}–${MAX_BARS} 条。` +
        `超了请把这一段拆成两段——刻度值和数值标签缩小到读不清，图表就失去意义了`,
    );
  }
  const long = data.filter((d) => [...d.label].length > MAX_LABEL_LEN);
  if (long.length > 0) {
    throw new ValidationError(
      `图表类目名过长（上限 ${MAX_LABEL_LEN} 字）：${long.map((d) => d.label).join("、")}`,
    );
  }
  if (data.every((d) => d.value === 0)) {
    throw new ValidationError("图表所有数值都是 0，画不出可比较的图形");
  }

  return unit === undefined ? { kind, data } : { kind, data, unit };
}

export interface ChartBlockCtx {
  ink: string;
  /** 正文字号（刻度值/类目名以它为基准）. */
  bodySize: number;
  idp: string;
  /** 语义色（亮/深两套，见 palette 的 `rolesFor`）；缺省是亮色板. */
  roles?: PaletteRoles;
}

/** ctx 里的语义色（缺省 = 亮色板）. */
function rolesOf(ctx: ChartBlockCtx): PaletteRoles {
  return ctx.roles ?? PALETTE;
}

/** 一拍：与 compose 的 Beat 同形. */
export interface ChartBeat {
  build(t0: number): { els: TimelineEl[]; end: number };
}

/** 纵轴刻度区宽度（放刻度值）. */
const AXIS_LABEL_W = 1.9;

/**
 * 图表块 → 一串拍子。
 *
 * 拍子划分：**第一拍画坐标系**（轴 + 刻度线 + 刻度值 + 单位），之后**每根柱子
 * 一拍**（柱框 → 填色 → 柱顶数值 → 轴下类目名）。
 *
 * 坐标系单独一拍而不是和第一根柱子合并：真人画图表也是先把框架搭好再填数据，
 * 而且这一拍很快（线多但短），正好铺在旁白开场那一两句上。
 */
export function chartBeats(
  spec: ChartSpec,
  box: ChartBox,
  ctx: ChartBlockCtx,
): { beats: ChartBeat[]; bottomY: number } {
  return spec.kind === "pie"
    ? pieBeats(spec, box, ctx)
    : barBeats(spec, box, ctx);
}

/**
 * 饼图（§7）：**先画整圆**，之后每个扇区一拍（切一刀 → 填色 → 引出标签）。
 *
 * 标签放在扇区外侧、用一条引线连过去，而不是压在扇区里：扇区小于 15% 时里面
 * 放不下"类目 42%"这么长的字，而"小扇区放外面、大扇区放里面"的混排会让观众
 * 每次都要重新找标签在哪。统一放外面，代价是占宽，收益是可读性一致。
 *
 * 百分比由本模块算，不要求作者写：作者给的是原始值（37 / 45 / 18），占比是
 * 派生量。让作者自己算百分比等于把一份数据写两遍，两处对不上时观众看到的是
 * 一个自相矛盾的图。
 */
function pieBeats(
  spec: ChartSpec,
  box: ChartBox,
  ctx: ChartBlockCtx,
): { beats: ChartBeat[]; bottomY: number } {
  const total = spec.data.reduce((a, d) => a + d.value, 0);
  const labelSize = Math.max(15, ctx.bodySize * 0.52);
  // 半径受高度和"两侧要留标签"双重约束。标签占宽按最长的一条估（类目 + 百分比），
  // 不写死比例——三个字的类目和六个字的类目差一倍宽，写死会让长类目顶出画幅。
  const labelW = Math.max(
    ...spec.data.map((d) =>
      textWidth(`${d.label} 100%`, labelSize, labelSize * 0.06),
    ),
  );
  const r = Math.max(
    ctx.bodySize,
    Math.min(box.h * 0.46, (box.w - labelW * 2) * 0.42),
  );
  // 饼图居中：它两侧都要挂标签，靠左摆会把右边的标签甩到画幅外，而左边留一大片空
  const cx = box.x + box.w / 2;
  const cy = box.y + r * 1.06;
  const drawing = pieChart(cx, cy, r, {
    values: spec.data.map((d) => d.value),
  });
  const beats: ChartBeat[] = [
    {
      build(t0) {
        const circle = markerStrokesEl([drawing.strokes[0]!], {
          t0,
          dur: 0.8,
          color: ctx.ink,
          width: LINE_W.thin,
          seed: `${ctx.idp}pc`,
          amp: 1.2,
          overshoot: false,
        });
        const els: TimelineEl[] = [circle];
        let end = circle.t1;
        if (spec.unit !== undefined) {
          const u = markerTextEl(spec.unit, {
            x: box.x,
            y: box.y,
            size: labelSize,
            gap: labelSize * 0.06,
            t0: circle.t1,
            perChar: 0.03,
            color: rolesOf(ctx).muted,
            idp: `${ctx.idp}pu`,
          });
          els.push(u);
          end = Math.max(end, u.t1);
        }
        return { els, end };
      },
    },
  ];
  // 分隔刀在 strokes 里紧跟整圆（每扇区一刀），fills 与 data 同序
  let acc = -90;
  spec.data.forEach((d, i) => {
    const sweep = total === 0 ? 0 : (d.value / total) * 360;
    const midDeg = acc + sweep / 2;
    acc += sweep;
    const cut = drawing.strokes[1 + i];
    const fill = drawing.fills[i];
    const pct = total === 0 ? 0 : Math.round((d.value / total) * 100);
    const color = seriesColor(i);
    beats.push({
      build(t0) {
        const els: TimelineEl[] = [];
        let end = t0;
        if (cut !== undefined) {
          const knife = markerStrokesEl([cut], {
            t0,
            dur: 0.26,
            color: ctx.ink,
            width: LINE_W.thin,
            seed: `${ctx.idp}pk${i}`,
            amp: 1,
            overshoot: false,
          });
          els.push(knife);
          end = knife.t1;
        }
        if (fill !== undefined) {
          const f = fadeGroup(fill, { t0: end, dur: 0.3, riseFrom: 0 });
          els.push(f);
          end = f.t1;
        }
        // 引线：从扇区中线的外沿往外拉一小段，再水平折向标签
        const a = (midDeg * Math.PI) / 180;
        const right = Math.cos(a) >= 0;
        const p0: Pt = [
          cx + r * 0.98 * Math.cos(a),
          cy + r * 0.98 * Math.sin(a),
        ];
        const p1: Pt = [
          cx + r * 1.22 * Math.cos(a),
          cy + r * 1.22 * Math.sin(a),
        ];
        const p2: Pt = [p1[0] + (right ? r * 0.3 : -r * 0.3), p1[1]];
        const lead = markerStrokesEl([[p0, p1, p2]], {
          t0: end,
          dur: 0.2,
          color: rolesOf(ctx).muted,
          width: 1.8,
          seed: `${ctx.idp}pl${i}`,
          amp: 0.8,
          overshoot: false,
          inkPool: false,
          opacity: 0.7,
        });
        els.push(lead);
        const txt = `${d.label} ${pct}%`;
        const s = fitSize(txt, labelSize, box.w * 0.34);
        const tw = textWidth(txt, s, s * 0.06);
        const label = markerTextEl(txt, {
          x: right ? p2[0] + s * 0.2 : p2[0] - tw - s * 0.2,
          y: p2[1] - s * 0.6,
          size: s,
          gap: s * 0.06,
          t0: lead.t1,
          perChar: 0.06,
          color,
          idp: `${ctx.idp}pt${i}`,
        });
        els.push(label);
        return { els, end: label.t1 };
      },
    });
  });
  return { beats, bottomY: cy + r * 1.15 };
}

function barBeats(
  spec: ChartSpec,
  box: ChartBox,
  ctx: ChartBlockCtx,
): { beats: ChartBeat[]; bottomY: number } {
  const values = spec.data.map((d) => d.value);
  const rawMax = Math.max(...values);
  // nice() 让刻度落在整数档上；rawMax 为 0 时上面已经拦掉
  const scale = scaleLinear().domain([0, rawMax]).nice();
  const domainMax = scale.domain()[1] ?? rawMax;
  const ticks = scale.ticks(4).filter((t) => t <= domainMax);

  const tickSize = Math.max(14, ctx.bodySize * 0.42);
  const labelSize = Math.max(16, ctx.bodySize * 0.52);
  const valueSize = Math.max(16, ctx.bodySize * 0.56);

  // 绘图区：左边让出刻度值，下边让出类目名，上边让出数值标签
  const padLeft = tickSize * AXIS_LABEL_W;
  const padBottom = labelSize * 1.7;
  const padTop = valueSize * 1.5;
  const plot = {
    x: box.x + padLeft,
    y: box.y + padTop,
    w: box.w - padLeft,
    h: box.h - padTop - padBottom,
  };

  const beats: ChartBeat[] = [];
  const yOf = (v: number): number =>
    plot.y + plot.h * (1 - (domainMax === 0 ? 0 : v / domainMax));

  // —— 第一拍：坐标系 ——
  beats.push({
    build(t0) {
      const els: TimelineEl[] = [];
      // L 形轴（只画左与下两条边：白板图表的轴是参考线，四边全画会变成盒子）
      const axis: Pt[] = [
        [plot.x, plot.y],
        [plot.x, plot.y + plot.h],
        [plot.x + plot.w, plot.y + plot.h],
      ];
      const axisEl = markerStrokesEl([axis], {
        t0,
        dur: 0.7,
        color: ctx.ink,
        width: LINE_W.thin,
        seed: `${ctx.idp}ax`,
        amp: 1.2,
        overshoot: false,
      });
      els.push(axisEl);
      let end = axisEl.t1;
      // 刻度线（弱化色、更细）+ 刻度值（手写、右对齐到轴）
      //
      // 刻度之间**错开起笔而不是排队等**：真人报刻度是"哒哒哒"点上去的，不会
      // 一个一个郑重写完。早先按顺序串起来，五个刻度值加起来吃掉 2.5 秒
      // （`hanziTextEl` 在字与字之间还有 0.12s 换笔停顿，"100" 就是 0.36s），
      // 整个坐标系占掉 11 秒旁白里的 4 秒，柱子只能挤在后面——实测关键帧在
      // 讲到一半时画面上还只有一副空坐标系。
      const stagger = 0.09;
      for (const [i, tick] of ticks.entries()) {
        if (tick === 0) continue;
        const gy = yOf(tick);
        const at = axisEl.t1 + i * stagger;
        const grid = markerStrokesEl(
          [
            [
              [plot.x, gy],
              [plot.x + plot.w, gy],
            ],
          ],
          {
            t0: at,
            dur: 0.16,
            color: rolesOf(ctx).muted,
            width: 1.8,
            seed: `${ctx.idp}g${i}`,
            amp: 0.5,
            overshoot: false,
            inkPool: false,
            opacity: 0.55,
          },
        );
        const txt = String(tick);
        const tv = markerTextEl(txt, {
          x: plot.x - 10 - textWidth(txt, tickSize, tickSize * 0.06),
          y: gy - tickSize * 0.62,
          size: tickSize,
          gap: tickSize * 0.06,
          t0: at + 0.05,
          perChar: 0.02,
          color: rolesOf(ctx).muted,
          idp: `${ctx.idp}tv${i}`,
        });
        els.push(grid, tv);
        end = Math.max(end, grid.t1, tv.t1);
      }
      // 单位
      if (spec.unit !== undefined) {
        const u = markerTextEl(spec.unit, {
          x: box.x,
          y: box.y + padTop - tickSize * 1.9,
          size: tickSize,
          gap: tickSize * 0.06,
          t0: axisEl.t1,
          perChar: 0.03,
          color: rolesOf(ctx).muted,
          idp: `${ctx.idp}u`,
        });
        els.push(u);
        end = Math.max(end, u.t1);
      }
      return { els, end };
    },
  });

  // —— 每根柱子一拍 ——
  const slot = plot.w / spec.data.length;
  const barW = slot * 0.56;
  spec.data.forEach((d, i) => {
    const bx = plot.x + slot * i + (slot - barW) / 2;
    const top = yOf(d.value);
    const bh = plot.y + plot.h - top;
    const color = seriesColor(i);
    beats.push({
      build(t0) {
        const els: TimelineEl[] = [];
        // 柱框（三边：底边就是坐标轴，重复画会显脏）
        const outline = markerStrokesEl(
          [
            [
              [bx, plot.y + plot.h],
              [bx, top],
              [bx + barW, top],
              [bx + barW, plot.y + plot.h],
            ] as Pt[],
          ],
          {
            t0,
            dur: 0.5,
            color: ctx.ink,
            width: LINE_W.thin,
            seed: `${ctx.idp}b${i}`,
            amp: 1,
            overshoot: false,
          },
        );
        els.push(outline);
        // 填色：描完轮廓再涂（笔只画轮廓，涂色是"填进去"的）
        if (bh > 1) {
          els.push(
            fadeRect(bx, top, barW, bh, {
              t0: outline.t1,
              dur: 0.34,
              fill: color,
              maxOpacity: 0.72,
            }),
          );
        }
        // 柱顶数值
        const vs = String(d.value);
        const vSize = fitSize(vs, valueSize, barW * 1.4);
        const vw = textWidth(vs, vSize, vSize * 0.06);
        const val = markerTextEl(vs, {
          x: bx + (barW - vw) / 2,
          y: top - vSize * 1.25,
          size: vSize,
          gap: vSize * 0.06,
          t0: outline.t1 + 0.1,
          perChar: 0.06,
          color,
          idp: `${ctx.idp}v${i}`,
        });
        els.push(val);
        // 轴下类目名
        const lSize = fitSize(d.label, labelSize, slot * 0.94);
        const lw = textWidth(d.label, lSize, lSize * 0.06);
        const lab = markerTextEl(d.label, {
          x: bx + (barW - lw) / 2,
          y: plot.y + plot.h + labelSize * 0.42,
          size: lSize,
          gap: lSize * 0.06,
          t0: val.t1,
          perChar: 0.07,
          color: ctx.ink,
          idp: `${ctx.idp}l${i}`,
        });
        els.push(lab);
        return { els, end: lab.t1 };
      },
    });
  });

  return { beats, bottomY: box.y + box.h };
}
