/**
 * PoC: 扁平彩色插画导入 + 入场动效
 *
 * 与 `svg-import.ts` 的分工（两类素材，两套机制，不能混）：
 * - `svg-import.ts` 处理**描边式线稿**（Lucide 类）：有中心线 → 笔真的画出来
 * - 本模块处理**填充式扁平插画**（ManyPixels 类）：纯色块、零 stroke、
 *   没有中心线 → 笔无从下笔，只能"显现"出来
 *
 * 这不是偷懒，VideoScribe 对导入的非线稿素材也是这么做的（擦出/推入），
 * 它自家素材库里带颜色的资源同样是「先描线、后上色」两段式。
 *
 * 三种显现模式：
 * - "layers" 按插画自带的语义图层组（character/chart/gear…）依次淡入上浮
 *   —— 最"扁平化动画"，也最能讲清结构；
 * - "sweep"  软边遮罩横扫显现，可让笔/手跟着遮罩边缘走 —— 最"白板手绘"；
 * - "pop"    整体轻微过冲弹入 —— 最快，用于次要素材。
 *
 * 必须做的隔离：ManyPixels 每个文件都用 `.st0/.st1/...` 这套通用类名，
 * 且可能带 `url(#SVGID_1_)` 渐变引用。多张插画进同一帧 SVG 时 CSS 类名
 * 与 id 必然相撞（后者会让前者的颜色被整片改写）。所以导入时把类名和
 * id 全部加实例前缀。
 */

import { Resvg } from "@resvg/resvg-js";

import {
  clamp01,
  cumLengths,
  easeInOutSine,
  easeOutCubic,
  fmt,
  pointAtLength,
  polylineAttr,
  slicePolyline,
} from "../whiteboard/index";
import type { Pt, TimelineEl } from "../whiteboard/index";

/** 一个语义图层（插画自带的 <g id="...">）. */
export interface FlatLayer {
  /** 原始 id（命名空间化之前），用于按名字调序/挑选. */
  name: string;
  markup: string;
}

export interface FlatIllustration {
  viewBox: readonly [number, number, number, number];
  /**
   * 画面**实际**包围盒（viewBox 坐标系）。
   *
   * 必须按这个而不是 viewBox 来适配尺寸：ManyPixels 的插画统一导出成
   * 500×500 画板，但画面本身只占其中一块，且每张的留白量都不同。按
   * viewBox 缩放的结果是每张图实际大小不一、还整体偏小。
   */
  contentBox: readonly [number, number, number, number];
  /** 已加前缀的 <style> 内容（放进 defs）. */
  css: string;
  /** <defs> 里的渐变等资源（已加前缀）. */
  defs: string;
  layers: FlatLayer[];
  /** 实例前缀. */
  prefix: string;
}

/** 去掉 XML 声明、注释、Illustrator 的编辑器属性. */
function stripNoise(s: string): string {
  return s
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s(?:xml:space|enable-background)="[^"]*"/g, "");
}

/**
 * 把 CSS 类名与 id 加上实例前缀。
 *
 * 覆盖四处引用：`<style>` 里的 `.cls` 选择器、元素上的 `class="cls"`、
 * `id="x"` 定义、以及 `url(#x)`（含 CSS 内的 `fill:url(#SVGID_1_)`）。
 */
function namespaceIds(
  body: string,
  css: string,
  defs: string,
  prefix: string,
): { body: string; css: string; defs: string } {
  const classNames = new Set<string>();
  for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    classNames.add(m[1]!);
  }
  const ids = new Set<string>();
  for (const src of [body, defs]) {
    for (const m of src.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]!);
  }

  const renameClasses = (s: string): string => {
    let out = s;
    for (const c of classNames) {
      // 选择器里的 .cls
      out = out.replace(
        new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`, "g"),
        `.${prefix}${c}`,
      );
    }
    return out;
  };
  const renameClassAttrs = (s: string): string =>
    s.replace(/\sclass="([^"]*)"/g, (_all, list: string) => {
      const mapped = list
        .split(/\s+/)
        .filter((c) => c !== "")
        .map((c) => (classNames.has(c) ? `${prefix}${c}` : c))
        .join(" ");
      return ` class="${mapped}"`;
    });
  const renameIds = (s: string): string => {
    let out = s;
    for (const id of ids) {
      const esc = id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
      out = out
        .replace(new RegExp(`(\\sid=")${esc}(")`, "g"), `$1${prefix}${id}$2`)
        .replace(new RegExp(`url\\(#${esc}\\)`, "g"), `url(#${prefix}${id})`)
        .replace(
          new RegExp(`(\\s(?:xlink:href|href)=")#${esc}(")`, "g"),
          `$1#${prefix}${id}$2`,
        );
    }
    return out;
  };

  return {
    body: renameIds(renameClassAttrs(body)),
    css: renameIds(renameClasses(css)),
    defs: renameIds(renameClassAttrs(defs)),
  };
}

/**
 * 提取所有**顶层** <g> 子树（正确配对嵌套的 </g>）。
 *
 * `prefix` 用于把图层名还原成插画作者起的原名（id 已被命名空间化，
 * 但调用方的 `layerOrder` 用的是 "character"/"chart" 这类自然名）。
 */
function topLevelGroups(body: string, prefix = ""): FlatLayer[] {
  const out: FlatLayer[] = [];
  const openRe = /<g\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  let scanFrom = 0;
  while ((m = openRe.exec(body)) !== null) {
    if (m.index < scanFrom) continue;
    // 从这个 <g> 起做深度配对，找到它的 </g>
    let depth = 0;
    const tagRe = /<g\b[^>]*>|<\/g\s*>/g;
    tagRe.lastIndex = m.index;
    let end = -1;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(body)) !== null) {
      if (t[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end < 0) break;
    const idm = /\sid="([^"]+)"/.exec(m[1]!);
    const raw = idm === null ? `g${out.length}` : idm[1]!;
    out.push({
      name:
        prefix !== "" && raw.startsWith(prefix)
          ? raw.slice(prefix.length)
          : raw,
      markup: body.slice(m.index, end),
    });
    scanFrom = end;
    openRe.lastIndex = end;
  }
  return out;
}

/** 没有分组时的兜底：把顶层 <path> 均分成若干层. */
function bucketPaths(body: string, buckets: number): FlatLayer[] {
  const paths = body.match(/<path\b[^>]*\/?>/g) ?? [];
  if (paths.length === 0) return [{ name: "all", markup: body }];
  const per = Math.max(1, Math.ceil(paths.length / buckets));
  const out: FlatLayer[] = [];
  for (let i = 0; i < paths.length; i += per) {
    out.push({
      name: `part${out.length}`,
      markup: paths.slice(i, i + per).join(""),
    });
  }
  return out;
}

/**
 * 解析扁平插画 SVG。
 *
 * @param prefix 实例前缀（同一帧里每个插画实例必须唯一）
 * @throws Error 缺 viewBox 或没有图形
 */
export function importFlatSvg(
  svgText: string,
  prefix: string,
): FlatIllustration {
  const clean = stripNoise(svgText);
  const svgTag = /<svg\b[^>]*>/i.exec(clean)?.[0] ?? "";
  const vbm = /viewBox="([^"]*)"/.exec(svgTag);
  if (vbm === null) throw new Error("扁平插画缺 viewBox，无法定位");
  const n = vbm[1]!
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox: [number, number, number, number] = [
    n[0] ?? 0,
    n[1] ?? 0,
    n[2] ?? 500,
    n[3] ?? 500,
  ];

  // 剥出 <style> 与 <defs>，剩下的是图形本体
  let inner = clean.slice(clean.indexOf(svgTag) + svgTag.length);
  inner = inner.replace(/<\/svg\s*>[\s\S]*$/i, "");

  let css = "";
  inner = inner.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    (_a, c: string) => {
      css += c;
      return "";
    },
  );
  let defs = "";
  inner = inner.replace(
    /<defs\b[^>]*>([\s\S]*?)<\/defs\s*>/gi,
    (_a, c: string) => {
      defs += c;
      return "";
    },
  );
  // Illustrator 常把渐变直接放在图形流里而不是 defs 内
  inner = inner.replace(
    /<(linearGradient|radialGradient)\b[\s\S]*?<\/\1\s*>/gi,
    (a) => {
      defs += a;
      return "";
    },
  );

  const ns = namespaceIds(inner, css, defs, prefix);
  const groups = topLevelGroups(ns.body, prefix);
  const layers = groups.length >= 2 ? groups : bucketPaths(ns.body, 5);
  if (layers.length === 0) throw new Error("扁平插画里没有可用图形");

  // 内容包围盒：交给 resvg 精确测量（导入期一次性，不在 svg(t) 里——
  // 逐帧纯函数契约不变）。测不出来时退回 viewBox。
  let contentBox: [number, number, number, number] = [
    viewBox[0],
    viewBox[1],
    viewBox[2],
    viewBox[3],
  ];
  try {
    const b = new Resvg(svgText, {
      font: { loadSystemFonts: false },
    }).getBBox();
    if (b !== undefined && b.width > 0 && b.height > 0) {
      contentBox = [b.x, b.y, b.width, b.height];
    }
  } catch {
    // 保留 viewBox 回退
  }

  return { viewBox, contentBox, css: ns.css, defs: ns.defs, layers, prefix };
}

/** 插画的 defs（CSS + 渐变）。整帧只需为每个实例各输出一次. */
export function flatDefs(il: FlatIllustration): string {
  const style = il.css.trim() === "" ? "" : `<style>${il.css}</style>`;
  return `${style}${il.defs}`;
}

export type FlatReveal = "layers" | "sweep" | "scribble" | "pop";

/** scribble 的行数（越多越细腻，代价是每帧遮罩路径更长）. */
const SCRIBBLE_ROWS = 8;
/** scribble 笔迹宽度相对行高的倍数（>1 保证相邻行重叠不留缝）. */
const SCRIBBLE_OVERLAP = 1.45;

/**
 * 蛇形涂抹路径（VideoScribe 对彩色素材的"画"其实是这个动作）：
 * 手拿笔在画面范围内来回横扫，画面在笔掠过处显现。
 *
 * 每行两端留出一点外扩（`bleed`），否则行末尾会露出未揭示的竖边。
 */
function scribblePath(
  x0: number,
  y0: number,
  w: number,
  h: number,
  rows: number,
): Pt[] {
  const rowH = h / rows;
  const bleed = rowH * 0.5;
  const pts: Pt[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + (r + 0.5) * rowH;
    const ltr = r % 2 === 0;
    const a = ltr ? x0 - bleed : x0 + w + bleed;
    const b = ltr ? x0 + w + bleed : x0 - bleed;
    pts.push([a, y], [b, y]);
  }
  return pts;
}

export interface FlatOpts {
  /** 目标中心与边长（等比适配，长边贴合）. */
  cx: number;
  cy: number;
  size: number;
  t0: number;
  /** 整体入场总时长. */
  dur: number;
  reveal?: FlatReveal;
  /** sweep 的扫掠方向. Default "lr". */
  sweepDir?: "lr" | "tb";
  /** scribble 的来回行数. Default 8（少=粗放快，多=细腻慢）. */
  scribbleRows?: number;
  /**
   * sweep 时让笔跟着遮罩边缘走。**默认关闭**。
   *
   * 一支马克笔画不出一张全彩插画——让笔尖"扫"出彩色画面在概念上是错的，
   * 观众会觉得违和。VideoScribe 这个动作用的是**手**（推/擦），不是笔尖。
   * 等手部素材到位后把它换成手，再打开这个开关才成立。
   */
  penFollow?: boolean;
  /** 图层顺序覆盖（按 name 指定先后；未列出的按原序接在后面）. */
  layerOrder?: readonly string[];
}

/** 图层入场的重叠系数：0 = 严格顺序，1 = 全部同时. */
const LAYER_OVERLAP = 0.45;

/**
 * 扁平插画时间轴元素。
 *
 * `sweep` 模式额外提供 `pen(t)`：遮罩边缘的坐标，可让马克笔/手跟着扫过去
 * ——这是把扁平素材缝进"手绘白板"叙事的关键一针。
 */
export function flatIllustrationEl(
  il: FlatIllustration,
  o: FlatOpts,
): TimelineEl {
  // 按**内容**包围盒适配：每张插画的实际视觉大小一致，与画板留白无关
  const [bx, by, bw, bh] = il.contentBox;
  const s = o.size / Math.max(bw || 1, bh || 1);
  const drawW = bw * s;
  const drawH = bh * s;
  const x0 = o.cx - drawW / 2;
  const y0 = o.cy - drawH / 2;
  // 画布坐标 → 插画局部坐标的落位变换（把内容框左上角对到 x0,y0）
  const place = `translate(${fmt(x0)},${fmt(y0)}) scale(${fmt(s)}) translate(${fmt(-bx)},${fmt(-by)})`;
  const reveal = o.reveal ?? "layers";

  const ordered = (() => {
    if (o.layerOrder === undefined) return il.layers;
    const byName = new Map(il.layers.map((l) => [l.name, l]));
    const head: FlatLayer[] = [];
    for (const nm of o.layerOrder) {
      const hit = byName.get(nm);
      if (hit !== undefined) {
        head.push(hit);
        byName.delete(nm);
      }
    }
    return [...head, ...byName.values()];
  })();

  const t1 = o.t0 + o.dur;
  const allMarkup = ordered.map((l) => l.markup).join("");

  // scribble 的蛇形路径在构造期算好（逐帧只做切片，保持 svg(t) 轻）
  const scribRows = o.scribbleRows ?? SCRIBBLE_ROWS;
  const scribW = (drawH / scribRows) * SCRIBBLE_OVERLAP;
  const scribPts = scribblePath(x0, y0, drawW, drawH, scribRows);
  const scribCum = cumLengths(scribPts);
  const scribTotal = scribCum[scribCum.length - 1]!;

  const el: TimelineEl = {
    t0: o.t0,
    t1,
    bbox: [x0 - 20, y0 - 20, x0 + drawW + 20, y0 + drawH + 20],
    svg(t) {
      if (t < o.t0) return "";
      const p = clamp01((t - o.t0) / o.dur);

      if (reveal === "pop") {
        const e = easeOutCubic(p);
        // 末端 6% 过冲后回弹（"放"上去的手感，同 elements.ts 的 slideEase）
        const k = 0.94 + 0.06 * Math.min(1, e * 1.08) + (e >= 1 ? 0 : 0);
        return (
          `<g opacity="${fmt(e)}" transform="translate(${fmt(o.cx)},${fmt(o.cy)}) ` +
          `scale(${fmt(0.86 + 0.14 * e * k)}) translate(${fmt(-o.cx)},${fmt(-o.cy)})">` +
          `<g transform="${place}">${allMarkup}</g></g>`
        );
      }

      if (reveal === "scribble") {
        if (p >= 1) return `<g transform="${place}">${allMarkup}</g>`;
        const drawn = easeInOutSine(p) * scribTotal;
        const part = slicePolyline(scribPts, scribCum, drawn);
        if (part.length < 2) return "";
        const mid = `${il.prefix}sc`;
        return (
          `<defs><mask id="${mid}" maskUnits="userSpaceOnUse" ` +
          `x="${fmt(x0 - scribW)}" y="${fmt(y0 - scribW)}" ` +
          `width="${fmt(drawW + scribW * 2)}" height="${fmt(drawH + scribW * 2)}">` +
          `<polyline points="${polylineAttr(part)}" fill="none" stroke="#fff" ` +
          `stroke-width="${fmt(scribW)}" stroke-linecap="round" stroke-linejoin="round"/>` +
          `</mask></defs>` +
          `<g mask="url(#${mid})"><g transform="${place}">${allMarkup}</g></g>`
        );
      }

      if (reveal === "sweep") {
        if (p >= 1) return `<g transform="${place}">${allMarkup}</g>`;
        const horiz = (o.sweepDir ?? "lr") === "lr";
        const span = horiz ? drawW : drawH;
        const edge = span * 0.22;
        // 软边要完整扫出画面：行程 = 本体 + 一个边宽
        const travel = easeOutCubic(p) * (span + edge);
        const mid = `${il.prefix}sw`;
        const gradId = `${mid}g`;
        const grad =
          `<linearGradient id="${gradId}" x1="0%" y1="0%" ` +
          `x2="${horiz ? "100%" : "0%"}" y2="${horiz ? "0%" : "100%"}">` +
          `<stop offset="0%" stop-color="#fff"/>` +
          `<stop offset="100%" stop-color="#000"/></linearGradient>`;
        const solid = horiz
          ? `<rect x="${fmt(x0 - 4)}" y="${fmt(y0 - 4)}" width="${fmt(Math.max(0, travel - edge) + 4)}" height="${fmt(drawH + 8)}" fill="#fff"/>`
          : `<rect x="${fmt(x0 - 4)}" y="${fmt(y0 - 4)}" width="${fmt(drawW + 8)}" height="${fmt(Math.max(0, travel - edge) + 4)}" fill="#fff"/>`;
        const soft = horiz
          ? `<rect x="${fmt(x0 + travel - edge)}" y="${fmt(y0 - 4)}" width="${fmt(edge)}" height="${fmt(drawH + 8)}" fill="url(#${gradId})"/>`
          : `<rect x="${fmt(x0 - 4)}" y="${fmt(y0 + travel - edge)}" width="${fmt(drawW + 8)}" height="${fmt(edge)}" fill="url(#${gradId})"/>`;
        return (
          `<defs>${grad}<mask id="${mid}" maskUnits="userSpaceOnUse" ` +
          `x="${fmt(x0 - 8)}" y="${fmt(y0 - 8)}" width="${fmt(drawW + 16)}" height="${fmt(drawH + 16)}">` +
          `${solid}${soft}</mask></defs>` +
          `<g mask="url(#${mid})"><g transform="${place}">${allMarkup}</g></g>`
        );
      }

      // layers：按语义图层依次淡入 + 轻微上浮
      const n = ordered.length;
      const step = 1 / (n - (n - 1) * LAYER_OVERLAP);
      const parts: string[] = [];
      for (const [i, layer] of ordered.entries()) {
        const start = i * step * (1 - LAYER_OVERLAP);
        const lp = clamp01((p - start) / step);
        if (lp <= 0) continue;
        const e = easeOutCubic(lp);
        const dy = (1 - e) * o.size * 0.045;
        parts.push(
          `<g opacity="${fmt(e)}" transform="translate(0,${fmt(dy)})">${layer.markup}</g>`,
        );
      }
      return `<g transform="${place}">${parts.join("")}</g>`;
    },
  };

  // pen 的挂载规则 —— 不能"挂上但返回 null"：`penPoseAt` 的隐含契约是
  // 凡提供 pen 的元素在自身 [t0,t1] 端点必须给出坐标（它对
  // prev.pen(prev.t1) / next.pen(next.t0) 是强制解包，返回 null 会崩）。
  //
  // - scribble：默认挂。手跟着涂抹轨迹走**就是**这个动效的全部意义，
  //   没有手的话观众看不出画面为什么在显现。
  // - sweep：opt-in。线性擦除配一支马克笔在概念上站不住（马克笔画不出
  //   全彩插画），等换成手部素材才成立。
  // - layers/pop：是"拉入"，本来就不该有笔跟随。
  const follow =
    reveal === "scribble" ? o.penFollow !== false : o.penFollow === true;
  if (follow && (reveal === "scribble" || reveal === "sweep")) {
    el.pen = (t) => {
      if (t < o.t0 || t > t1) return null;
      if (reveal === "scribble") {
        const drawn = easeInOutSine(clamp01((t - o.t0) / o.dur)) * scribTotal;
        return pointAtLength(scribPts, scribCum, drawn);
      }
      const horiz = (o.sweepDir ?? "lr") === "lr";
      const span = horiz ? drawW : drawH;
      const edge = span * 0.22;
      const travel = easeOutCubic(clamp01((t - o.t0) / o.dur)) * (span + edge);
      return horiz
        ? [x0 + travel - edge * 0.5, y0 + drawH * 0.5]
        : [x0 + drawW * 0.5, y0 + travel - edge * 0.5];
    };
  }
  return el;
}
