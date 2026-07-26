/**
 * @module core/whiteboard-video/diagrams
 *
 * 设计稿 2.0 §8「表格 & 列表样式」+ §9「流程 & 结构图」。
 *
 * ## 只算骨架，不排文字
 *
 * 本模块返回的都是**几何骨架**（折线组）与**文字锚点**（在哪儿、多大、怎么对齐）。
 * 文字本身不在这里画——白板上的字必须走矢量手写路径（`blocks.ts` 的
 * `markerTextEl`），而排版还要处理自动缩字号、换行、字距补偿。把两件事混在一起
 * 会让这个模块既要懂图又要懂字，改一个坏两个。
 *
 * 所以每个函数返回 `{ strokes, slots }`：`slots` 是"这里应该写什么内容的哪一段"
 * 的坐标清单，调用方拿它去生成手写元素。
 *
 * ## 尺寸由外部给，内部只做分配
 *
 * 所有布局都在调用方给的矩形内做等分/递推，不自己决定"合适的大小"。版式约束
 * （竖版单栏 vs 横版双栏、安全边距）只有 `layout.ts` 知道。
 */

import dagre from "@dagrejs/dagre";

import type { Pt } from "../whiteboard/index";
import { fmt } from "../whiteboard/index";
import { arrowHead } from "../whiteboard/index";
import { diamondPath, rectPath, roundRectPath } from "./shapes";

/** 文字锚点：调用方据此生成手写文本元素. */
export interface TextSlot {
  /** 左上角（`align` 为 center 时是所在格的左上角）. */
  x: number;
  y: number;
  /** 该格可用宽度（超了就该缩字号或换文案）. */
  w: number;
  /** 建议字号上限. */
  size: number;
  align: "left" | "center";
  /** 语义标记：调用方可据此选颜色/字重（如表头加粗、分支用次强调色）. */
  role?: "header" | "cell" | "item" | "node" | "branch" | "index";
}

/** 一张图的骨架 + 文字位. */
export interface DiagramDrawing {
  strokes: Pt[][];
  slots: TextSlot[];
  /** 实心装饰（如勾选框的对勾底色）；描完后淡入. */
  fills?: string[];
}

export interface TableOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  rows: number;
  cols: number;
  /** 首行为表头（画一条加重的分隔线）. Default true. */
  header?: boolean;
}

/**
 * 基础表格（§8「基础表格」）。
 *
 * 表头下方那条线**单独一笔**画（不与其他横线合并），这样调用方可以把它画粗或
 * 换色——表头分隔线是表格里唯一承载语义的线（"上面是名字，下面是数据"），
 * 其余网格线只是对齐辅助。
 *
 * 行列数上限刻意不设：放不下是版式问题，应该在上游改文案，而不是在这里静默
 * 截断。但 0 或负数直接返回空（画不出来）。
 */
export function table(o: TableOpts): DiagramDrawing {
  const rows = Math.floor(o.rows);
  const cols = Math.floor(o.cols);
  if (rows < 1 || cols < 1 || o.w <= 0 || o.h <= 0) {
    return { strokes: [], slots: [] };
  }
  const rh = o.h / rows;
  const cw = o.w / cols;
  const strokes: Pt[][] = [
    // 外框一笔
    [
      [o.x, o.y],
      [o.x + o.w, o.y],
      [o.x + o.w, o.y + o.h],
      [o.x, o.y + o.h],
      [o.x, o.y],
    ],
  ];
  const hasHeader = o.header !== false && rows > 1;
  if (hasHeader) {
    strokes.push([
      [o.x, o.y + rh],
      [o.x + o.w, o.y + rh],
    ]);
  }
  for (let r = hasHeader ? 2 : 1; r < rows; r++) {
    strokes.push([
      [o.x, o.y + rh * r],
      [o.x + o.w, o.y + rh * r],
    ]);
  }
  for (let c = 1; c < cols; c++) {
    strokes.push([
      [o.x + cw * c, o.y],
      [o.x + cw * c, o.y + o.h],
    ]);
  }
  const slots: TextSlot[] = [];
  const size = Math.min(rh * 0.5, cw * 0.34);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        x: o.x + cw * c,
        y: o.y + rh * r + rh * 0.24,
        w: cw,
        size,
        align: "center",
        role: r === 0 && hasHeader ? "header" : "cell",
      });
    }
  }
  return { strokes, slots };
}

export type ListKind = "todo" | "ordered" | "bullet";

export interface ListOpts {
  x: number;
  y: number;
  w: number;
  /** 行距. */
  lineHeight: number;
  count: number;
  kind: ListKind;
  size: number;
  /** `todo` 时哪些项已勾选（0-based）. */
  checked?: readonly number[];
}

/**
 * 三种列表（§8「待办清单 / 有序列表 / 无序列表」）。
 *
 * 三者的区别只在**行首标记**：勾选框 / 序号 / 圆点。文字位的 x 因此不同（勾选框
 * 最宽、圆点最窄），这也是为什么不能让调用方自己画标记然后共用一套文字位——
 * 缩进对不齐是列表最显眼的瑕疵。
 *
 * 序号不在这里画成图形：它是文字，走 `slots` 里 `role: "index"` 的那一项交给
 * 手写路径，否则数字会和正文不同笔迹。
 */
export function list(o: ListOpts): DiagramDrawing {
  const n = Math.floor(o.count);
  if (n < 1) return { strokes: [], slots: [] };
  const strokes: Pt[][] = [];
  const slots: TextSlot[] = [];
  const box = o.size * 0.92;
  const checked = new Set(o.checked ?? []);
  // 行首标记宽度（含与文字的间隔）
  const indent =
    o.kind === "todo"
      ? box * 1.6
      : o.kind === "ordered"
        ? o.size * 1.5
        : o.size * 1.0;
  for (let i = 0; i < n; i++) {
    const top = o.y + o.lineHeight * i;
    const midY = top + o.size * 0.5;
    if (o.kind === "todo") {
      strokes.push(roundRectPath(o.x, top, box, box, box * 0.2));
      if (checked.has(i)) {
        strokes.push([
          [o.x + box * 0.2, midY],
          [o.x + box * 0.44, top + box * 0.76],
          [o.x + box * 0.82, top + box * 0.18],
        ]);
      }
    } else if (o.kind === "ordered") {
      slots.push({
        x: o.x,
        y: top,
        w: o.size * 1.2,
        size: o.size,
        align: "left",
        role: "index",
      });
    } else {
      // 无序列表的圆点：小实心圆用折线画不出来，用一段极短的粗线代替——
      // 笔迹带有圆端帽，一个点长度的线渲出来就是一个圆点
      strokes.push([
        [o.x + o.size * 0.2, midY],
        [o.x + o.size * 0.22, midY],
      ]);
    }
    slots.push({
      x: o.x + indent,
      y: top,
      w: o.w - indent,
      size: o.size,
      align: "left",
      role: "item",
    });
  }
  return { strokes, slots };
}

// ---- §9 流程 & 结构图 ----

/** 流程图的一步：矩形步骤或菱形判断. */
export interface FlowNode {
  kind: "step" | "decision" | "terminal";
}

export interface FlowChartOpts {
  x: number;
  y: number;
  w: number;
  /** 每个节点的高度. */
  nodeH: number;
  /** 节点间的竖直间隔（放箭头）. */
  gap: number;
  nodes: readonly FlowNode[];
}

/**
 * 竖向流程图（§9「流程图」）。
 *
 * 走**竖向**而不是设计稿示意的自由布局：竖向流程在两种画幅里都成立（竖版是
 * 天然方向，横版放在单栏里也不挤），而横向流程一超过 3 步就会画出画面外。
 * 判断节点用菱形，起止用圆角矩形，中间步骤用矩形——形状承担"这是什么类型的
 * 一步"，不必额外标注。
 */
export function flowChart(o: FlowChartOpts): DiagramDrawing {
  const n = o.nodes.length;
  if (n === 0) return { strokes: [], slots: [] };
  const strokes: Pt[][] = [];
  const slots: TextSlot[] = [];
  const cx = o.x + o.w / 2;
  for (const [i, node] of o.nodes.entries()) {
    const top = o.y + (o.nodeH + o.gap) * i;
    // 菱形要比矩形宽一点才装得下同样的字（有效区是内接矩形）
    const nw = node.kind === "decision" ? o.w : o.w * 0.82;
    const nx = cx - nw / 2;
    strokes.push(
      node.kind === "decision"
        ? diamondPath(nx, top, nw, o.nodeH)
        : node.kind === "terminal"
          ? roundRectPath(nx, top, nw, o.nodeH, o.nodeH * 0.45)
          : rectPath(nx, top, nw, o.nodeH),
    );
    slots.push({
      x: nx,
      y: top + o.nodeH * 0.28,
      w: nw,
      size: Math.min(o.nodeH * 0.42, nw * 0.26),
      align: "center",
      role: "node",
    });
    if (i < n - 1) {
      const a0 = top + o.nodeH;
      const shaft: Pt[] = [
        [cx, a0],
        [cx, a0 + o.gap],
      ];
      strokes.push(shaft, arrowHead(shaft, Math.min(18, o.gap * 0.5)));
    }
  }
  return { strokes, slots };
}

/** 带分支的流程图：一个节点. */
export interface FlowGraphNode {
  id: string;
  text: string;
  kind: FlowNode["kind"];
}

/** 带分支的流程图：一条边（`label` 是分支条件，如"够"/"不够"）. */
export interface FlowGraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowGraphOpts {
  /** 目标框（图会等比缩放后居中放进去）. */
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: readonly FlowGraphNode[];
  edges: readonly FlowGraphEdge[];
  /** 基准字号（决定节点大小）. */
  size: number;
}

/** 带分支的流程图的绘制材料（按拍子分组，故不复用 DiagramDrawing）. */
export interface FlowGraphDrawing {
  /** 与 `nodes` 同序：每个节点的形状. */
  nodeShapes: Pt[][];
  /** 与 `nodes` 同序：节点里的文字位. */
  nodeSlots: TextSlot[];
  /** 与 `edges` 同序：每条边的折线组（连线 + 箭头）. */
  edgePaths: Pt[][][];
  /** 与 `edges` 同序：分支标签的位置（无标签则 null）. */
  edgeLabels: Array<TextSlot | null>;
  /** 建议的绘制顺序（节点下标；拓扑序，来自 dagre 的 rank/order）. */
  order: number[];
  /** 图实际占用的高度（缩放后）. */
  height: number;
}

/**
 * 带分支与汇合的流程图（§9「流程图」），布局交给 **dagre**。
 *
 * ## 为什么这里必须用图布局库
 *
 * `flowChart` 只能画一条直链——它把节点按下标往下排。而真实的流程一定有分支：
 * "预算够吗？"下面是两条路，走完还要汇回同一个"上线"。分支布局要解的是
 * 分层（rank）、同层内排序（避免连线交叉）、以及连线绕行，这是有成熟算法的
 * （Sugiyama 分层法），自己写会在"两条分支汇合"这种最常见的形状上出交叉线。
 *
 * ## 坐标怎么落到画布
 *
 * dagre 在自己的坐标系里布局（左上角 0,0），这里再**等比缩放 + 居中**放进目标框。
 * 等比而不是分别缩 x/y：非等比会把圆角矩形压成扁的、菱形压成风筝，形状承担的
 * 语义（判断 vs 步骤）就丢了。
 */
export function flowGraph(o: FlowGraphOpts): FlowGraphDrawing {
  const EMPTY: FlowGraphDrawing = {
    nodeShapes: [],
    nodeSlots: [],
    edgePaths: [],
    edgeLabels: [],
    order: [],
    height: 0,
  };
  if (o.nodes.length === 0) return EMPTY;

  const g = new dagre.graphlib.Graph();
  // 生长方向跟着**框的形状**走，不是固定朝下：横版满宽的框是 3:1 以上的横条，
  // 朝下排会把四个节点挤进一列窄条（节点缩到只剩字高，而左右各空一大片），
  // 朝右排同样四步能放大一倍多。竖版框比高，仍然朝下。
  const rankdir = o.w >= o.h * 1.5 ? "LR" : "TB";
  // align 把同层节点靠一条边对齐：不对齐时，回头边生成的虚拟节点会把链上的
  // 节点一个个往下顶，四步的直链画出来是波浪形的。
  g.setGraph({
    rankdir,
    align: rankdir === "LR" ? "UL" : "UL",
    nodesep: o.size * 1.2,
    ranksep: o.size * 1.6,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const nodeH = o.size * 2.1;
  for (const n of o.nodes) {
    const chars = [...n.text].length;
    const textW = chars * o.size * 1.06 + o.size * 1.6;
    // 菱形的可用区是内接矩形，同样的字要更宽的外框才装得下
    const w = n.kind === "decision" ? textW * 1.5 : textW;
    g.setNode(n.id, { width: w, height: nodeH });
  }
  for (const e of o.edges) {
    g.setEdge(
      e.from,
      e.to,
      e.label === undefined
        ? {}
        : {
            label: e.label,
            width: [...e.label].length * o.size * 0.7,
            height: o.size,
          },
    );
  }
  dagre.layout(g);

  const gw = (g.graph().width ?? 1) || 1;
  const gh = (g.graph().height ?? 1) || 1;
  const scale = Math.min(o.w / gw, o.h / gh, 1.6);
  const offX = o.x + (o.w - gw * scale) / 2;
  const offY = o.y;
  const tx = (v: number): number => offX + v * scale;
  const ty = (v: number): number => offY + v * scale;

  const nodeShapes: Pt[][] = [];
  const nodeSlots: TextSlot[] = [];
  for (const n of o.nodes) {
    const nd = g.node(n.id);
    const w = nd.width * scale;
    const h = nd.height * scale;
    const x = tx(nd.x) - w / 2;
    const y = ty(nd.y) - h / 2;
    nodeShapes.push(
      n.kind === "decision"
        ? diamondPath(x, y, w, h)
        : n.kind === "terminal"
          ? roundRectPath(x, y, w, h, h * 0.45)
          : rectPath(x, y, w, h),
    );
    nodeSlots.push({
      x: n.kind === "decision" ? x + w * 0.18 : x,
      y: y + h * 0.28,
      w: n.kind === "decision" ? w * 0.64 : w,
      size: Math.min(h * 0.44, o.size),
      align: "center",
      role: "node",
    });
  }

  const edgePaths: Pt[][][] = [];
  const edgeLabels: Array<TextSlot | null> = [];
  for (const e of o.edges) {
    const ed = g.edge(e.from, e.to);
    const raw = (ed.points ?? []) as Array<{ x: number; y: number }>;
    const pts: Pt[] = raw.map((p) => [tx(p.x), ty(p.y)] as Pt);
    if (pts.length < 2) {
      edgePaths.push([]);
      edgeLabels.push(null);
      continue;
    }
    const head = arrowHead(pts, Math.min(18, o.size * 0.5));
    edgePaths.push([pts, head]);
    const lx = ed.x;
    const ly = ed.y;
    edgeLabels.push(
      e.label === undefined || lx === undefined || ly === undefined
        ? null
        : {
            x: tx(lx) - o.size * 1.2,
            y: ty(ly) - o.size * 0.4,
            w: o.size * 2.4,
            size: o.size * 0.62,
            align: "center",
            role: "branch",
          },
    );
  }

  // 绘制顺序：按 dagre 的 rank（同 rank 内按 order），也就是"从上往下、左先右后"
  const order = o.nodes
    .map((n, i) => ({
      i,
      r: g.node(n.id).rank ?? 0,
      o: g.node(n.id).order ?? 0,
    }))
    .sort((a, b) => a.r - b.r || a.o - b.o)
    .map((x) => x.i);

  return {
    nodeShapes,
    nodeSlots,
    edgePaths,
    edgeLabels,
    order,
    height: gh * scale,
  };
}

export interface MindMapOpts {
  /** 中心节点中心点. */
  cx: number;
  cy: number;
  /** 中心节点尺寸. */
  centerW: number;
  centerH: number;
  /** 分支数. */
  branches: number;
  /** 分支节点尺寸. */
  branchW: number;
  branchH: number;
  /** 中心到分支的水平距离. */
  spread: number;
}

/**
 * 思维导图（§9「思维导图」）：中心节点 + 右侧扇形展开的分支。
 *
 * 分支只向**右**展开，不做左右对称：左右对称的导图在视频里没有优势（观众不能
 * 自由扫视，只能跟着笔走），而单向展开让笔的移动方向一致，看起来更有条理。
 *
 * 连接线用二次贝塞尔采样的弧而不是直线——直线连出来是"组织架构图"，弧线才是
 * 思维导图的语言。
 */
export function mindMap(o: MindMapOpts): DiagramDrawing {
  const n = Math.floor(o.branches);
  if (n < 1) return { strokes: [], slots: [] };
  const strokes: Pt[][] = [
    roundRectPath(
      o.cx - o.centerW / 2,
      o.cy - o.centerH / 2,
      o.centerW,
      o.centerH,
      o.centerH * 0.3,
    ),
  ];
  const slots: TextSlot[] = [
    {
      x: o.cx - o.centerW / 2,
      y: o.cy - o.centerH * 0.22,
      w: o.centerW,
      size: Math.min(o.centerH * 0.44, o.centerW * 0.22),
      align: "center",
      role: "node",
    },
  ];
  // 分支竖向均匀分布，整体以中心为中线
  const totalH = n * o.branchH + (n - 1) * o.branchH * 0.5;
  const startY = o.cy - totalH / 2;
  const bx = o.cx + o.centerW / 2 + o.spread;
  const from: Pt = [o.cx + o.centerW / 2, o.cy];
  for (let i = 0; i < n; i++) {
    const by = startY + i * (o.branchH * 1.5);
    strokes.push(roundRectPath(bx, by, o.branchW, o.branchH, o.branchH * 0.3));
    // 连接弧：控制点放在水平中点，做出"先平出去再拐上/下"的手感
    const to: Pt = [bx, by + o.branchH / 2];
    const mx = (from[0] + to[0]) / 2;
    const curve: Pt[] = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16;
      const u = 1 - t;
      curve.push([
        u * u * from[0] + 2 * u * t * mx + t * t * to[0],
        u * u * from[1] + 2 * u * t * from[1] + t * t * to[1],
      ]);
    }
    strokes.push(curve);
    slots.push({
      x: bx,
      y: by + o.branchH * 0.26,
      w: o.branchW,
      size: Math.min(o.branchH * 0.44, o.branchW * 0.2),
      align: "center",
      role: "branch",
    });
  }
  return { strokes, slots };
}

export interface OrgChartOpts {
  x: number;
  y: number;
  w: number;
  /** 每层节点高度. */
  nodeH: number;
  /** 两层之间的竖直间隔. */
  gap: number;
  /** 第二层的节点数. */
  children: number;
}

/**
 * 组织架构图（§9「组织架构」）：一个上级 + 一排下级，用直角连线。
 *
 * 连线走**直角**（下 → 横 → 下）而不是斜线：架构图的语义是层级归属，直角线
 * 让"同一层"一眼可见；斜线会让人去比较角度，读成"关系强弱"。
 *
 * 只做两层。三层以上在视频画幅里每个节点会窄到写不下字——真需要三层就该拆成
 * 两段分别讲，而不是画一张看不清的图。
 */
export function orgChart(o: OrgChartOpts): DiagramDrawing {
  const n = Math.floor(o.children);
  if (n < 1) return { strokes: [], slots: [] };
  const cx = o.x + o.w / 2;
  const rootW = Math.min(o.w * 0.4, o.w / 2);
  const strokes: Pt[][] = [rectPath(cx - rootW / 2, o.y, rootW, o.nodeH)];
  const slots: TextSlot[] = [
    {
      x: cx - rootW / 2,
      y: o.y + o.nodeH * 0.28,
      w: rootW,
      size: Math.min(o.nodeH * 0.42, rootW * 0.22),
      align: "center",
      role: "node",
    },
  ];
  const childTop = o.y + o.nodeH + o.gap;
  const slot = o.w / n;
  const cw = slot * 0.86;
  // 干线：根底部往下走一半间隔
  const busY = o.y + o.nodeH + o.gap / 2;
  strokes.push([
    [cx, o.y + o.nodeH],
    [cx, busY],
  ]);
  const firstX = o.x + slot * 0.5;
  const lastX = o.x + slot * (n - 0.5);
  if (n > 1) {
    strokes.push([
      [firstX, busY],
      [lastX, busY],
    ]);
  }
  for (let i = 0; i < n; i++) {
    const ccx = o.x + slot * (i + 0.5);
    strokes.push([
      [ccx, busY],
      [ccx, childTop],
    ]);
    strokes.push(rectPath(ccx - cw / 2, childTop, cw, o.nodeH));
    slots.push({
      x: ccx - cw / 2,
      y: childTop + o.nodeH * 0.28,
      w: cw,
      size: Math.min(o.nodeH * 0.4, cw * 0.24),
      align: "center",
      role: "node",
    });
  }
  return { strokes, slots };
}

/** 供调用方把 slot 转成调试用的可视化框（目视复核版式时很有用）. */
export function slotDebugSvg(
  slots: readonly TextSlot[],
  color: string,
): string {
  return slots
    .map(
      (s) =>
        `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.size)}" fill="none" stroke="${color}" stroke-width="1" opacity="0.5"/>`,
    )
    .join("");
}
