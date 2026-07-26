/**
 * @module core/whiteboard-video/board-block
 *
 * 文章里的 ```table``` / ```flow``` / ```mindmap``` / ```icons``` / ```scene```
 * / ```note``` / ```status``` 代码块 → 板上的图形。
 *
 * ## 为什么需要这一层
 *
 * `diagrams.ts` / `scenes.ts` / `shapes.ts` / `emphasis.ts` 只产**几何**：折线组
 * 加文字锚点（`TextSlot`），不知道文字内容、不上色、也不排时。它们是库；库不
 * 会自己出现在成片里。作者写文章时能触达的只有 `article.ts` 认识的语法，所以
 * 每一类图形都要有一条"块语法 → 校验 → 逐拍渲染"的通路，否则那些库函数永远
 * 只能在 contact sheet 上看。
 *
 * ## 三条贯穿本模块的规则
 *
 * 1. **逐拍揭示**，与 `chart-block` 同一套机制：一张图不是一个元素，而是一串
 *    拍子（表格一行一拍、流程一节点一拍……）。整张图一次出现等于放了张 PPT。
 * 2. **文字必须走手写路径**：帧渲染器 `loadSystemFonts: false`，`<text>` 渲成
 *    空白。所有格子里的字都经 `markerTextEl`。
 * 3. **超限当场报错**，不自动缩放、不静默截断：字缩到读不清的图就不再是解释。
 *    行列数、字数上限都是硬校验（`ValidationError`），要求作者改文案或拆段。
 */

import { ValidationError } from "../errors/index";
import type { Pt, TimelineEl } from "../whiteboard/index";
import { arrowHead, fadeGroup } from "../whiteboard/index";
import { iconPaths } from "../whiteboard/library";
import { fitSize, markerTextEl, textWidth } from "./blocks";
import { flowGraph, mindMap, table } from "./diagrams";
import type { FlowNode, TextSlot } from "./diagrams";
import { STATUS_KINDS, isStatusKind, statusBadgePaths } from "./emphasis";
import type { StatusKind } from "./emphasis";
import { markerStrokesEl } from "./marker";
import { PALETTE, inkOf } from "./palette";
import type { PaletteRoles } from "./palette";
import { SCENE_NAMES, isSceneName, partColor, scene } from "./scenes";
import type { SceneName } from "./scenes";
import { cloudPath, speechBoxPath, stickyNoteSvg } from "./shapes";
import { LINE_W } from "./strokes";

/** 支持的板书块种类. */
export const BOARD_BLOCK_KINDS = [
  "table",
  "flow",
  "mindmap",
  "icons",
  "scene",
  "note",
  "status",
] as const;

export type BoardBlockKind = (typeof BOARD_BLOCK_KINDS)[number];

export function isBoardBlockKind(v: string): v is BoardBlockKind {
  return (BOARD_BLOCK_KINDS as readonly string[]).includes(v);
}

/** 便签/云朵/对话框三种"一句话容器"（§5）. */
export const NOTE_SHAPES = ["sticky", "cloud", "speech"] as const;
export type NoteShape = (typeof NOTE_SHAPES)[number];

/** 解析后的板书块（判别联合，kind 即判别键）. */
export type BoardSpec =
  | { kind: "table"; rows: string[][] }
  | {
      kind: "flow";
      nodes: Array<{ id: string; text: string; kind: FlowNode["kind"] }>;
      edges: Array<{ from: string; to: string; label?: string }>;
    }
  | { kind: "mindmap"; center: string; branches: string[] }
  | { kind: "icons"; steps: Array<{ icon: string; label: string }> }
  | { kind: "scene"; name: SceneName; caption?: string }
  | { kind: "note"; shape: NoteShape; text: string }
  | { kind: "status"; items: Array<{ status: StatusKind; text: string }> };

// ---- 校验上限 ----

/** 表格：行列上限（含表头行）. */
const TABLE_MAX_ROWS = 5;
const TABLE_MAX_COLS = 4;
/** 单格字数上限（横版最窄的一列大约就这么宽）. */
const CELL_MAX_LEN = 8;
/** 流程/导图/图标流的节点数上限. */
const NODE_MAX = 5;
const NODE_MIN = 2;
/** 节点文字上限（形状里的字，超了只能缩到读不清）. */
const NODE_MAX_LEN = 8;
/** 图标流的标签上限（图标下方一行）. */
const ICON_LABEL_MAX_LEN = 6;
/** 便签/云朵里的一句话上限. */
const NOTE_MAX_LEN = 16;
/** 状态条目数与文字上限. */
const STATUS_MAX = 4;
const STATUS_MAX_LEN = 12;

function lines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function len(s: string): number {
  return [...s].length;
}

function tooLong(items: readonly string[], max: number, what: string): void {
  const bad = items.filter((s) => len(s) > max);
  if (bad.length > 0) {
    throw new ValidationError(
      `${what}过长（上限 ${max} 字）：${bad.join("、")}。` +
        `板上的字是关键词，长句请放到口播里`,
    );
  }
}

function checkCount(n: number, min: number, max: number, what: string): void {
  if (n < min || n > max) {
    throw new ValidationError(
      `${what}有 ${n} 项，要求 ${min}–${max} 项。超了请拆成两段——` +
        `挤在一屏里字号会缩到读不清`,
    );
  }
}

/**
 * 解析流程块（支持分支与汇合）。
 *
 * 两种行：
 * - **节点行**：`收集需求`。相邻的节点行自动串成一条链（与旧写法完全兼容）。
 *   `？`结尾的是判断（菱形）。
 * - **边行**：`预算够吗？ -> 定方案`，可带分支条件 `预算够吗？ -[够]-> 定方案`。
 *   两端按**文本**引用节点，写没出现过的文本就是新建一个节点——所以"汇合"只要
 *   让两条边指向同一段文本即可。
 *
 * 为什么链式和边式混用而不是只留一种：只留链式表达不了分支（这正是要修的问题）；
 * 只留边式的话，最常见的"三步直线流程"要写成两行冗长的边，作者会嫌烦而不写。
 *
 * @throws ValidationError 节点数越界 / 文字过长 / 自环
 */
function parseFlow(rows: readonly string[]): BoardSpec {
  // 两种箭头写法：`A -> B` 和带条件的 `A -[够]-> B`。
  // 写成 `-(?:\[..\])?->` 是错的——那要求无标签时也有两个短横（`A --> B`）。
  const EDGE = /^(.+?)\s*(?:-\[(.+?)\]->|->)\s*(.+)$/;
  const nodes: Array<{ id: string; text: string; kind: FlowNode["kind"] }> = [];
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const idOf = new Map<string, string>();

  const declare = (raw: string): string => {
    const decision = /[?？]$/.test(raw);
    const text = (decision ? raw.slice(0, -1) : raw).trim();
    const known = idOf.get(text);
    if (known !== undefined) {
      // 后写的 `？` 也算：某个节点先出现在边里、后来才被写成 `A？`
      if (decision) {
        const n = nodes.find((x) => x.id === known);
        if (n !== undefined) n.kind = "decision";
      }
      return known;
    }
    const id = `n${nodes.length}`;
    idOf.set(text, id);
    nodes.push({ id, text, kind: decision ? "decision" : "step" });
    return id;
  };

  let prevChain: string | null = null;
  for (const line of rows) {
    const m = EDGE.exec(line);
    if (m === null) {
      const id = declare(line);
      if (prevChain !== null && prevChain !== id) {
        edges.push({ from: prevChain, to: id });
      }
      prevChain = id;
      continue;
    }
    const from = declare(m[1]!.trim());
    const to = declare(m[3]!.trim());
    if (from === to) throw new ValidationError(`流程里有自环：${line}`);
    const label = m[2]?.trim();
    edges.push(label === undefined ? { from, to } : { from, to, label });
    // 边行打断链：紧跟其后的节点行不该自动接到边的目标上，否则
    // `A -> B` 后面写个 `C` 会莫名多出一条 B→C
    prevChain = null;
  }

  checkCount(nodes.length, NODE_MIN, NODE_MAX, "流程节点");
  tooLong(
    nodes.map((n) => n.text),
    NODE_MAX_LEN,
    "流程节点文字",
  );
  tooLong(
    edges.map((e) => e.label).filter((l): l is string => l !== undefined),
    4,
    "分支条件",
  );
  // 起止形状按**图结构**判断（没有入边或没有出边），不按"第一行/最后一行"：
  // 有分支之后，最后一行往往是一条汇合边，真正的终点可能写在中间。
  for (const n of nodes) {
    if (n.kind === "decision") continue;
    const hasIn = edges.some((e) => e.to === n.id);
    const hasOut = edges.some((e) => e.from === n.id);
    if (!hasIn || !hasOut) n.kind = "terminal";
  }
  return { kind: "flow", nodes, edges };
}

/**
 * 解析板书块。
 *
 * 块首行是 `kind` 加可选参数（如 `scene lecture`、`note cloud`），其后是块体。
 * 每种块的块体格式见各自的解析分支。
 *
 * @throws ValidationError 种类未知 / 参数非法 / 条数越界 / 文字过长
 */
export function parseBoardBlock(info: string, body: string): BoardSpec {
  const tokens = info.trim().split(/\s+/);
  const kind = tokens[0] ?? "";
  if (!isBoardBlockKind(kind)) {
    throw new ValidationError(
      `板书块 "${kind}" 不支持；可用：${BOARD_BLOCK_KINDS.join(" | ")}`,
    );
  }
  const args = tokens.slice(1);
  const rows = lines(body);

  switch (kind) {
    case "table": {
      // 每行 `单元格 | 单元格 | 单元格`，首行为表头
      const cells = rows.map((l) =>
        l
          .split(/[|｜]/)
          .map((c) => c.trim())
          .filter((c) => c !== ""),
      );
      checkCount(cells.length, 2, TABLE_MAX_ROWS, "表格行");
      const cols = cells[0]!.length;
      checkCount(cols, 2, TABLE_MAX_COLS, "表格列");
      const ragged = cells.findIndex((r) => r.length !== cols);
      if (ragged >= 0) {
        throw new ValidationError(
          `表格第 ${ragged + 1} 行有 ${cells[ragged]!.length} 格，` +
            `与表头的 ${cols} 格不一致`,
        );
      }
      tooLong(cells.flat(), CELL_MAX_LEN, "表格单元格");
      return { kind, rows: cells };
    }
    case "flow": {
      return parseFlow(rows);
    }
    case "mindmap": {
      // 首行是中心主题，其余是分支
      checkCount(rows.length, NODE_MIN + 1, NODE_MAX + 1, "导图节点（含中心）");
      const [center, ...branches] = rows as [string, ...string[]];
      tooLong([center, ...branches], NODE_MAX_LEN, "导图节点文字");
      return { kind, center, branches };
    }
    case "icons": {
      // 每行 `图标名 | 标签`
      checkCount(rows.length, NODE_MIN, NODE_MAX, "图标流步骤");
      const steps = rows.map((l) => {
        const m = /^(\S+)\s*[|｜]\s*(.+)$/.exec(l);
        if (m === null) {
          throw new ValidationError(
            `图标流的行读不懂（应为「图标名 | 标签」）：${l}`,
          );
        }
        const icon = m[1]!;
        if (iconPaths(icon, 0, 0, 100).length === 0) {
          throw new ValidationError(
            `图标 "${icon}" 不在图标库里；见 ICON_CATEGORIES（如 question / ` +
              `magnifier / lightbulb / trophy）`,
          );
        }
        return { icon, label: m[2]!.trim() };
      });
      tooLong(
        steps.map((s) => s.label),
        ICON_LABEL_MAX_LEN,
        "图标流标签",
      );
      return { kind, steps };
    }
    case "scene": {
      const name = args[0] ?? "";
      if (!isSceneName(name)) {
        throw new ValidationError(
          `场景 "${name}" 不支持；可用：${SCENE_NAMES.join(" | ")}`,
        );
      }
      const caption = rows[0];
      if (rows.length > 1) {
        throw new ValidationError(
          `场景块最多一行说明文字，收到 ${rows.length} 行`,
        );
      }
      if (caption !== undefined) tooLong([caption], NOTE_MAX_LEN, "场景说明");
      return caption === undefined ? { kind, name } : { kind, name, caption };
    }
    case "note": {
      const shape = (args[0] ?? "sticky") as NoteShape;
      if (!(NOTE_SHAPES as readonly string[]).includes(shape)) {
        throw new ValidationError(
          `便签形状 "${shape}" 不支持；可用：${NOTE_SHAPES.join(" | ")}`,
        );
      }
      if (rows.length !== 1) {
        throw new ValidationError(
          `便签块要恰好一行文字，收到 ${rows.length} 行`,
        );
      }
      tooLong(rows, NOTE_MAX_LEN, "便签文字");
      return { kind, shape, text: rows[0]! };
    }
    case "status": {
      // 每行 `状态 | 文字`
      checkCount(rows.length, 1, STATUS_MAX, "状态条目");
      const items = rows.map((l) => {
        const m = /^(\S+)\s*[|｜]\s*(.+)$/.exec(l);
        if (m === null) {
          throw new ValidationError(
            `状态行读不懂（应为「状态 | 文字」）：${l}`,
          );
        }
        const status = m[1]!;
        if (!isStatusKind(status)) {
          throw new ValidationError(
            `状态 "${status}" 不支持；可用：${STATUS_KINDS.join(" | ")}`,
          );
        }
        return { status, text: m[2]!.trim() };
      });
      tooLong(
        items.map((i) => i.text),
        STATUS_MAX_LEN,
        "状态文字",
      );
      return { kind, items };
    }
  }
}

// ---- 渲染 ----

export interface BoardBlockCtx {
  ink: string;
  /** 正文字号（块内文字以它为基准）. */
  bodySize: number;
  idp: string;
  /**
   * 语义色（亮/深两套，见 palette 的 `rolesFor`）。
   *
   * 必须随 ctx 传进来而不是直接引用常量表：深色板面上 `muted`/`primary`
   * 要整套换值，写死引用会让注解和箭头在深板上糊成一团。缺省是亮色板，
   * 老调用点不受影响。
   */
  roles?: PaletteRoles;
}

/** ctx 里的语义色（缺省 = 亮色板）. */
function rolesOf(ctx: BoardBlockCtx): PaletteRoles {
  return ctx.roles ?? PALETTE;
}

/** 一拍：与 compose 的 Beat 同形. */
export interface BoardBeat {
  build(t0: number): { els: TimelineEl[]; end: number };
}

export interface BoardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 折线组 → 笔迹元素（本模块唯一的描画入口，统一线宽与抖动量）. */
function drawEl(
  paths: readonly Pt[][],
  o: {
    t0: number;
    dur: number;
    color: string;
    seed: string;
    width?: number;
    opacity?: number;
  },
): TimelineEl {
  return markerStrokesEl(paths as Pt[][], {
    t0: o.t0,
    dur: o.dur,
    color: o.color,
    width: o.width ?? LINE_W.thin,
    seed: o.seed,
    amp: 1.2,
    overshoot: false,
    ...(o.opacity === undefined ? {} : { opacity: o.opacity }),
  });
}

/**
 * 往一个 `TextSlot` 里写字。
 *
 * 字号取 `fitSize`（按格宽收）而不是直接用 slot.size：slot.size 是几何层给的
 * **上限**，它不知道要写几个字。居中对齐要按实际字宽算 x，否则中英混排会偏。
 */
function slotText(
  text: string,
  slot: TextSlot,
  o: { t0: number; color: string; idp: string; perChar?: number },
): TimelineEl {
  const size = fitSize(text, slot.size, slot.w * 0.86);
  const gap = size * 0.06;
  const w = textWidth(text, size, gap);
  const x = slot.align === "center" ? slot.x + (slot.w - w) / 2 : slot.x;
  return markerTextEl(text, {
    x,
    y: slot.y,
    size,
    gap,
    t0: o.t0,
    perChar: o.perChar ?? 0.07,
    color: o.color,
    idp: o.idp,
  });
}

/**
 * 板书块 → 一串拍子 + 实际占用的底边。
 *
 * 返回 `bottomY` 而不是让调用方按 `box.h` 算：多数块用不满给定高度（表格按行
 * 高、图标流按图标尺寸），把真实底边报回去，compose 才能把后续内容紧跟着排，
 * 而不是留一大片空白。
 */
export function boardBeats(
  spec: BoardSpec,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  switch (spec.kind) {
    case "table":
      return tableBeats(spec.rows, box, ctx);
    case "flow":
      return flowBeats(spec.nodes, spec.edges, box, ctx);
    case "mindmap":
      return mindMapBeats(spec.center, spec.branches, box, ctx);
    case "icons":
      return iconsBeats(spec.steps, box, ctx);
    case "scene":
      return sceneBeats(spec.name, spec.caption, box, ctx);
    case "note":
      return noteBeats(spec.shape, spec.text, box, ctx);
    case "status":
      return statusBeats(spec.items, box, ctx);
  }
}

/**
 * 表格（§8）：先画网格，再**一行一拍**填字。
 *
 * 网格一次画完而不是逐行画：表格的骨架是一个整体，逐行长出来的表格看起来像
 * 在搭脚手架；而"框架先有、内容逐行填"正是真人讲表格的顺序。表头行与数据行
 * 分开着色（表头用 primary），让"上面是名字"不靠加粗也读得出来。
 */
function tableBeats(
  rows: readonly string[][],
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const cols = rows[0]!.length;
  const rowH = Math.min(ctx.bodySize * 1.7, box.h / rows.length);
  const h = rowH * rows.length;
  const geo = table({
    x: box.x,
    y: box.y,
    w: box.w,
    h,
    rows: rows.length,
    cols,
  });
  const beats: BoardBeat[] = [
    {
      build(t0) {
        const grid = drawEl(geo.strokes, {
          t0,
          dur: 0.34 + geo.strokes.length * 0.06,
          color: ctx.ink,
          seed: `${ctx.idp}tg`,
        });
        return { els: [grid], end: grid.t1 };
      },
    },
  ];
  rows.forEach((row, r) => {
    beats.push({
      build(t0) {
        const els: TimelineEl[] = [];
        let end = t0;
        row.forEach((cell, c) => {
          const slot = geo.slots[r * cols + c]!;
          const el = slotText(cell, slot, {
            // 同一行的格子错开起笔（0.12s），不排队等：一行三格若串起来，
            // 每行要吃掉一秒多，五行就把整段旁白占满了
            t0: t0 + c * 0.12,
            color: r === 0 ? rolesOf(ctx).primary : ctx.ink,
            idp: `${ctx.idp}t${r}_${c}`,
          });
          els.push(el);
          end = Math.max(end, el.t1);
        });
        return { els, end };
      },
    });
  });
  return { beats, bottomY: box.y + h };
}

/**
 * 流程图（§9，含分支与汇合）：**一个节点一拍**，入边跟在该节点前面画。
 *
 * 入边归属节点自己那一拍而不是上游那一拍：讲解顺序是"这一步做完 → 然后（箭头）
 * → 下一步"，箭头是引出后者的动作。挂在上游会让画面先出现一根指向空白的箭头。
 * 有了分支之后这条规则更要紧——一个判断有两条出边，若挂在判断那一拍，两条箭头
 * 会同时指向两片空白。
 *
 * 拍子顺序取 dagre 的拓扑序（rank/order），也就是"从上往下、左先右后"，与人讲
 * 流程的顺序一致：先讲主干走通，再回来讲另一条分支。
 */
function flowBeats(
  nodes: ReadonlyArray<{ id: string; text: string; kind: FlowNode["kind"] }>,
  edges: ReadonlyArray<{ from: string; to: string; label?: string }>,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const geo = flowGraph({
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    nodes,
    edges,
    size: ctx.bodySize,
  });
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const beats: BoardBeat[] = geo.order.map((i) => {
    const node = nodes[i]!;
    const inEdges = edges
      .map((e, k) => ({ e, k }))
      .filter(({ e }) => e.to === node.id);
    return {
      build(t0) {
        const els: TimelineEl[] = [];
        let at = t0;
        for (const { e, k } of inEdges) {
          // 只画"上游已经画过"的入边：汇合节点的第二条入边来自还没讲到的分支时，
          // 提前画会连到一片空白。这里靠拓扑序判断——上游下标在本节点之前才画。
          const up = idIndex.get(e.from);
          if (up === undefined) continue;
          if (geo.order.indexOf(up) > geo.order.indexOf(i)) continue;
          const paths = geo.edgePaths[k] ?? [];
          if (paths.length === 0) continue;
          const a = drawEl(paths, {
            t0: at,
            dur: 0.26,
            color: rolesOf(ctx).muted,
            seed: `${ctx.idp}fa${k}`,
          });
          els.push(a);
          at = a.t1;
          const lslot = geo.edgeLabels[k];
          if (lslot !== null && lslot !== undefined && e.label !== undefined) {
            const lt = slotText(e.label, lslot, {
              t0: at,
              color: rolesOf(ctx).warn,
              idp: `${ctx.idp}fe${k}`,
              perChar: 0.05,
            });
            els.push(lt);
            at = lt.t1;
          }
        }
        const shape = drawEl([geo.nodeShapes[i]!], {
          t0: at,
          dur: 0.42,
          color: node.kind === "decision" ? rolesOf(ctx).warn : ctx.ink,
          seed: `${ctx.idp}fn${i}`,
        });
        const label = slotText(node.text, geo.nodeSlots[i]!, {
          t0: shape.t1,
          color: ctx.ink,
          idp: `${ctx.idp}fl${i}`,
        });
        els.push(shape, label);
        return { els, end: label.t1 };
      },
    };
  });
  // 汇合节点之后才画得出的"后向入边"（上游还没讲到那条），补在最后一拍
  const late = edges
    .map((e, k) => ({ e, k }))
    .filter(({ e }) => {
      const up = idIndex.get(e.from);
      const dn = idIndex.get(e.to);
      if (up === undefined || dn === undefined) return false;
      return geo.order.indexOf(up) > geo.order.indexOf(dn);
    });
  if (late.length > 0) {
    beats.push({
      build(t0) {
        const els: TimelineEl[] = [];
        let at = t0;
        for (const { e, k } of late) {
          const paths = geo.edgePaths[k] ?? [];
          if (paths.length === 0) continue;
          const a = drawEl(paths, {
            t0: at,
            dur: 0.26,
            color: rolesOf(ctx).muted,
            seed: `${ctx.idp}fz${k}`,
          });
          els.push(a);
          at = a.t1;
          // 标签和入边那一拍一样要写：回头边正是最需要标签的一条边——"不合格就
          // 退回去"里的条件全在这个词上，只画一根箭头等于把判断依据留在口播里。
          const lslot = geo.edgeLabels[k];
          if (lslot !== null && lslot !== undefined && e.label !== undefined) {
            const lt = slotText(e.label, lslot, {
              t0: at,
              color: rolesOf(ctx).warn,
              idp: `${ctx.idp}fy${k}`,
              perChar: 0.05,
            });
            els.push(lt);
            at = lt.t1;
          }
        }
        return { els, end: at };
      },
    });
  }
  return { beats, bottomY: box.y + geo.height };
}

/**
 * 思维导图（§9）：中心一拍，之后**一分支一拍**（连接弧 → 框 → 字）。
 */
function mindMapBeats(
  center: string,
  branches: readonly string[],
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const n = branches.length;
  const branchH = Math.min(ctx.bodySize * 1.9, box.h / (n * 1.5));
  const centerH = branchH * 1.25;
  const centerW = Math.min(box.w * 0.3, ctx.bodySize * 6);
  const branchW = Math.min(box.w * 0.4, ctx.bodySize * 7);
  const spread = Math.max(
    ctx.bodySize,
    box.w - centerW / 2 - branchW - box.w * 0.5,
  );
  const cx = box.x + centerW / 2;
  const totalH = n * branchH + (n - 1) * branchH * 0.5;
  const cy = box.y + totalH / 2;
  const geo = mindMap({
    cx,
    cy,
    centerW,
    centerH,
    branches: n,
    branchW,
    branchH,
    spread,
  });
  // mindMap 的 strokes 顺序：中心框、（每分支）框 + 弧
  const beats: BoardBeat[] = [
    {
      build(t0) {
        const el = drawEl([geo.strokes[0]!], {
          t0,
          dur: 0.44,
          color: rolesOf(ctx).primary,
          seed: `${ctx.idp}mc`,
          width: LINE_W.medium,
        });
        const txt = slotText(center, geo.slots[0]!, {
          t0: el.t1,
          color: ctx.ink,
          idp: `${ctx.idp}mct`,
        });
        return { els: [el, txt], end: txt.t1 };
      },
    },
  ];
  for (let i = 0; i < n; i++) {
    const shape = geo.strokes[1 + i * 2]!;
    const curve = geo.strokes[2 + i * 2]!;
    const slot = geo.slots[1 + i]!;
    const text = branches[i]!;
    beats.push({
      build(t0) {
        const arc = drawEl([curve], {
          t0,
          dur: 0.3,
          color: rolesOf(ctx).muted,
          seed: `${ctx.idp}ma${i}`,
        });
        const bx = drawEl([shape], {
          t0: arc.t1,
          dur: 0.36,
          color: ctx.ink,
          seed: `${ctx.idp}mb${i}`,
        });
        const txt = slotText(text, slot, {
          t0: bx.t1,
          color: ctx.ink,
          idp: `${ctx.idp}mt${i}`,
        });
        return { els: [arc, bx, txt], end: txt.t1 };
      },
    });
  }
  return { beats, bottomY: cy + totalH / 2 };
}

/**
 * 图标流（§6 + §14 + §2）：一排图标，之间用箭头串起来，图标下写标签。
 *
 * 这一个块同时兜住三个板块：图标库（画的是图标）、使用示例（"问题 → 分析 →
 * 方案 → 结果"就是这个形状）、以及线条样式里的箭头线。合并是有意的——把它们
 * 拆成三种语法，作者要记三样东西，画面上却是同一个东西。
 */
function iconsBeats(
  steps: ReadonlyArray<{ icon: string; label: string }>,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const n = steps.length;
  // 竖版（窄框）改成**纵向**排：横向排四步时每步只分到 270px，图标缩到 150px，
  // 而下方还空着一大片。纵向排的图标能大一倍，标签也能写在右边而不必挤在下面。
  const slotW = box.w / n;
  if (slotW < ctx.bodySize * 5) return iconsColumnBeats(steps, box, ctx);
  const slot = slotW;
  const labelSize = Math.max(14, Math.min(ctx.bodySize * 0.62, slot * 0.3));
  const size = Math.min(slot * 0.56, box.h - labelSize * 1.8);
  const cy = box.y + size / 2;
  const beats: BoardBeat[] = steps.map((step, i) => ({
    build(t0) {
      const els: TimelineEl[] = [];
      const cx = box.x + slot * (i + 0.5);
      let at = t0;
      // 前一个图标到本图标之间的箭头（§2 箭头线）
      if (i > 0) {
        const px = box.x + slot * (i - 0.5);
        const shaft: Pt[] = [
          [px + size * 0.62, cy],
          [cx - size * 0.62, cy],
        ];
        const a = drawEl([shaft, arrowHead(shaft, size * 0.16)], {
          t0: at,
          dur: 0.22,
          color: rolesOf(ctx).primary,
          seed: `${ctx.idp}ia${i}`,
        });
        els.push(a);
        at = a.t1;
      }
      const icon = drawEl(iconPaths(step.icon, cx, cy, size), {
        t0: at,
        dur: 0.5,
        color: ctx.ink,
        seed: `${ctx.idp}ic${i}`,
      });
      const lw = textWidth(step.label, labelSize, labelSize * 0.06);
      const lab = markerTextEl(step.label, {
        x: cx - lw / 2,
        y: cy + size * 0.58,
        size: labelSize,
        gap: labelSize * 0.06,
        t0: icon.t1,
        perChar: 0.07,
        color: ctx.ink,
        idp: `${ctx.idp}il${i}`,
      });
      els.push(icon, lab);
      return { els, end: lab.t1 };
    },
  }));
  return { beats, bottomY: cy + size * 0.58 + labelSize * 1.4 };
}

/**
 * 图标流的纵向排版（竖版画幅用）：图标在左、标签在右、箭头竖着往下。
 *
 * 竖版不是把横版缩小，而是换方向：手机上视线是上下扫的，一列四步顺着读，比
 * 一排四个缩到指甲盖大的图标好读得多。
 */
function iconsColumnBeats(
  steps: ReadonlyArray<{ icon: string; label: string }>,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const n = steps.length;
  const rowH = Math.min(box.h / n, ctx.bodySize * 3.4);
  const size = Math.min(rowH * 0.66, box.w * 0.24);
  const labelSize = Math.min(ctx.bodySize, size * 0.44);
  const cxIcon = box.x + box.w * 0.22 + size / 2;
  const beats: BoardBeat[] = steps.map((step, i) => ({
    build(t0) {
      const els: TimelineEl[] = [];
      const cy = box.y + rowH * i + rowH * 0.5;
      let at = t0;
      if (i > 0) {
        const py = box.y + rowH * (i - 1) + rowH * 0.5;
        const shaft: Pt[] = [
          [cxIcon, py + size * 0.62],
          [cxIcon, cy - size * 0.62],
        ];
        const a = drawEl([shaft, arrowHead(shaft, size * 0.16)], {
          t0: at,
          dur: 0.22,
          color: rolesOf(ctx).primary,
          seed: `${ctx.idp}ia${i}`,
        });
        els.push(a);
        at = a.t1;
      }
      const icon = drawEl(iconPaths(step.icon, cxIcon, cy, size), {
        t0: at,
        dur: 0.5,
        color: ctx.ink,
        seed: `${ctx.idp}ic${i}`,
      });
      const lab = markerTextEl(step.label, {
        x: cxIcon + size * 0.78,
        y: cy - labelSize * 0.55,
        size: labelSize,
        gap: labelSize * 0.06,
        t0: icon.t1,
        perChar: 0.07,
        color: ctx.ink,
        idp: `${ctx.idp}il${i}`,
      });
      els.push(icon, lab);
      return { els, end: lab.t1 };
    },
  }));
  return { beats, bottomY: box.y + rowH * n };
}

/**
 * 场景组件（§10）：按 `ScenePart` 分组，**一组一拍**（人一拍、板一拍）。
 *
 * 分组即拍子而不是整幅一拍：场景里的每一组都有语义（"有个人"、"板上有内容"），
 * 分开画能让口播对上"这里是老师、这里是他讲的东西"。
 */
function sceneBeats(
  name: SceneName,
  caption: string | undefined,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const capH = caption === undefined ? 0 : ctx.bodySize * 1.6;
  const h = Math.max(box.h - capH, ctx.bodySize * 4);
  // 场景组件的构图假定框接近 3:2（人在左、板在右）。横版整幅内容宽是 4.7:1，
  // 直接铺满会把板拉成一条横幅、人缩成一个火柴头（实测就是这样）。所以按高度
  // 限宽再居中——场景是一幅画，不是一栏内容。
  const w = Math.min(box.w, h * 1.7);
  const x = box.x + (box.w - w) / 2;
  const drawing = scene(name, { x, y: box.y, w, h });
  const beats: BoardBeat[] = drawing.parts.map((part, i) => ({
    build(t0) {
      const el = drawEl(part.paths, {
        t0,
        dur: 0.3 + part.paths.length * 0.12,
        color: partColor(part),
        seed: `${ctx.idp}sc${i}`,
        ...(part.role === "muted" ? { width: 2.2 } : {}),
      });
      return { els: [el], end: el.t1 };
    },
  }));
  const bottom = box.y + h;
  if (caption !== undefined) {
    const size = ctx.bodySize * 0.78;
    const w = textWidth(caption, size, size * 0.06);
    beats.push({
      build(t0) {
        const el = markerTextEl(caption, {
          x: x + (w - textWidth(caption, size, size * 0.06)) / 2,
          y: bottom + size * 0.5,
          size,
          gap: size * 0.06,
          t0,
          perChar: 0.07,
          color: rolesOf(ctx).muted,
          idp: `${ctx.idp}scc`,
        });
        return { els: [el], end: el.t1 };
      },
    });
  }
  return { beats, bottomY: bottom + capH };
}

/**
 * 便签 / 云朵 / 对话框（§5）：一拍画容器，一拍写字。
 *
 * 便签用 `stickyNoteSvg`（带底色和阴影的贴纸）而不是描线：便签的语义来自"贴上去
 * 的一张纸"，靠底色和微旋转表达；用笔描一个方框只是个方框。所以它走 `fadeGroup`
 * 淡入 —— 贴纸是贴上去的，不是画出来的。云朵与对话框反过来，是画出来的。
 */
function noteBeats(
  shape: NoteShape,
  text: string,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const size = ctx.bodySize * 0.92;
  const textW = textWidth(text, size, size * 0.06);
  // 容器按文字宽度收（不占满媒体栏）：一句话的便签占满一栏会读作"标题"
  const w = Math.min(box.w, Math.max(textW * 1.5, ctx.bodySize * 7));
  const h = Math.min(box.h, shape === "sticky" ? w * 0.82 : w * 0.62);
  const x = box.x + (box.w - w) / 2;
  const y = box.y;
  const beats: BoardBeat[] = [
    {
      build(t0) {
        if (shape === "sticky") {
          const el = fadeGroup(stickyNoteSvg(x, y, w, h, { pin: true }), {
            t0,
            dur: 0.42,
          });
          return { els: [el], end: el.t1 };
        }
        const path =
          shape === "cloud"
            ? cloudPath(x, y, w, h)
            : speechBoxPath(x, y, w, h * 0.86);
        const el = drawEl([path], {
          t0,
          dur: 0.8,
          color: shape === "cloud" ? rolesOf(ctx).info : ctx.ink,
          seed: `${ctx.idp}nb`,
          width: LINE_W.medium,
        });
        return { els: [el], end: el.t1 };
      },
    },
    {
      build(t0) {
        const s = fitSize(text, size, w * 0.72);
        const tw = textWidth(text, s, s * 0.06);
        const el = markerTextEl(text, {
          x: x + (w - tw) / 2,
          y: y + h * (shape === "cloud" ? 0.42 : 0.3),
          size: s,
          gap: s * 0.06,
          t0,
          perChar: 0.07,
          color: ctx.ink,
          idp: `${ctx.idp}nt`,
        });
        return { els: [el], end: el.t1 };
      },
    },
  ];
  return { beats, bottomY: y + h + ctx.bodySize * 0.4 };
}

/**
 * 状态徽章（§13）：**一条一拍**（徽章 → 文字）。
 *
 * 徽章用语义色，但形状也有区别（`caution` 是三角形）——颜色之外还有形状冗余，
 * 这样在灰度截图或色弱视角下"注意"和"提示"仍然分得开。
 */
function statusBeats(
  items: ReadonlyArray<{ status: StatusKind; text: string }>,
  box: BoardBox,
  ctx: BoardBlockCtx,
): { beats: BoardBeat[]; bottomY: number } {
  const lineH = Math.min(ctx.bodySize * 1.85, box.h / items.length);
  const r = Math.min(lineH * 0.34, ctx.bodySize * 0.62);
  const size = ctx.bodySize * 0.86;
  const beats: BoardBeat[] = items.map((item, i) => ({
    build(t0) {
      const cy = box.y + lineH * i + lineH * 0.45;
      const color = inkOf(
        item.status === "caution"
          ? "warn"
          : item.status === "important"
            ? "danger"
            : item.status === "info"
              ? "info"
              : item.status === "success"
                ? "success"
                : "danger",
      );
      const badge = drawEl(statusBadgePaths(item.status, box.x + r, cy, r), {
        t0,
        dur: 0.4,
        color,
        seed: `${ctx.idp}sb${i}`,
        width: LINE_W.medium,
      });
      const s = fitSize(item.text, size, box.w - r * 3);
      const txt = markerTextEl(item.text, {
        x: box.x + r * 2.6,
        y: cy - s * 0.52,
        size: s,
        gap: s * 0.06,
        t0: badge.t1,
        perChar: 0.07,
        color: ctx.ink,
        idp: `${ctx.idp}st${i}`,
      });
      return { els: [badge, txt], end: txt.t1 };
    },
  }));
  return { beats, bottomY: box.y + lineH * items.length };
}
