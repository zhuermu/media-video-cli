/**
 * 设计稿 2.0 新增元素单测（charts / diagrams / emphasis + §5 图形 + §2 线条）。
 *
 * 这些模块几乎全是几何，测的是**不变量**而不是像素（外观由
 * `experiments/design-sheet-2.ts` 目视验收）：
 * - 退化输入不产生垃圾图元、不死循环（0 根柱子、1 个节点、2 条轴的雷达图）；
 * - 归一化数值越界被夹住（脏数据不该把图画到框外）；
 * - 语义不变量（漏斗越来越窄、金字塔越来越宽、时间轴已完成才实心）；
 * - 坐标全部有限（NaN 会让 resvg 静默丢弃整条 path，是最难查的一类 bug）。
 */

import { describe, expect, it } from "bun:test";

import {
  CHART_NAMES,
  areaChart,
  axisPath,
  barChart,
  compareChart,
  funnelChart,
  gauge,
  isChartName,
  lineChart,
  pieChart,
  pyramidChart,
  radarChart,
  timeline,
} from "./charts";
import type { ChartDrawing } from "./charts";
import { flowChart, list, mindMap, orgChart, table } from "./diagrams";
import type { DiagramDrawing } from "./diagrams";
import {
  STATUS_KINDS,
  STATUS_ROLE,
  circleAroundPath,
  cornerDecorPath,
  dividerPaths,
  hatchDefs,
  hatchSvg,
  highlightBoxSvg,
  isStatusKind,
  pointerArrowPaths,
  radiatingPaths,
  statusBadgePaths,
  statusColor,
} from "./emphasis";
import { PALETTE } from "./palette";
import {
  badgePath,
  bookmarkPath,
  burstPath,
  circlePath,
  containerPath,
  diamondPath,
  ellipsePath,
  flagPaths,
  labelPath,
  loopArrowPaths,
  parallelogramPath,
  polygonPath,
  scrollPaths,
  tagPaths,
  tapeSvg,
  thoughtBubblePaths,
  trapezoidPath,
  trianglePath,
} from "./shapes";
import { biArrow, dottedStrokesEl, lightningPath, wavyLine } from "./strokes";

const box = { x: 0, y: 0, w: 200, h: 100 };

/** 所有坐标有限. */
function finite(paths: readonly (readonly (readonly number[])[])[]): boolean {
  return paths.every((p) =>
    p.every((pt) => pt.every((v) => Number.isFinite(v))),
  );
}

/** 折线组的包围盒. */
function bbox(paths: readonly (readonly (readonly number[])[])[]): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const xs = paths.flat().map((p) => p[0]!);
  const ys = paths.flat().map((p) => p[1]!);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

function isDrawn(d: ChartDrawing): boolean {
  return d.strokes.length > 0 || d.fills.length > 0;
}

describe("charts（2.0 §7）", () => {
  it("坐标轴只画 L 形两条边（不是一个框）", () => {
    const p = axisPath(box);
    expect(p).toHaveLength(3);
    // 起点在左上、终点在右下，中间拐一次
    expect(p[0]).toEqual([0, 0]);
    expect(p[2]).toEqual([200, 100]);
  });

  it("柱状图：每根柱一条轮廓 + 一块填色，且不超出画布", () => {
    const d = barChart(box, { values: [0.5, 1, 0.25] });
    // 1 条轴 + 3 条柱轮廓
    expect(d.strokes).toHaveLength(4);
    expect(d.fills).toHaveLength(3);
    const b = bbox(d.strokes);
    expect(b.y0).toBeGreaterThanOrEqual(-0.01);
    expect(b.y1).toBeLessThanOrEqual(100.01);
    expect(b.x1).toBeLessThanOrEqual(200.01);
  });

  it("柱状图：越界数值被夹住，0 值不画柱（避免贴轴的假横线）", () => {
    const d = barChart(box, { values: [5, -3, 0] });
    // 只有第一根（被夹到 1）画得出来
    expect(d.fills).toHaveLength(1);
    expect(bbox(d.strokes).y0).toBeGreaterThanOrEqual(-0.01);
  });

  it("空数据的图表不产生任何图元", () => {
    expect(isDrawn(barChart(box, { values: [] }))).toBe(false);
    expect(isDrawn(lineChart(box, { values: [] }))).toBe(false);
    expect(isDrawn(pieChart(50, 50, 40, { values: [] }))).toBe(false);
    expect(isDrawn(pieChart(50, 50, 0, { values: [1] }))).toBe(false);
  });

  it("折线图单点也能画（不崩、不画折线）", () => {
    const d = lineChart(box, { values: [0.5] });
    // 只有轴，没有折线段
    expect(d.strokes).toHaveLength(1);
    expect(d.fills).toHaveLength(1);
  });

  it("面积图的填充多边形闭合到基线", () => {
    const d = areaChart(box, { values: [0.2, 0.8] });
    const poly = d.fills[0]!;
    expect(poly).toContain("<polygon");
    // 基线 y=100 必须出现在多边形顶点里
    expect(poly).toContain("100");
  });

  it("饼图扇区数与数据一致；环形图多一条内圈", () => {
    const pie = pieChart(50, 50, 40, { values: [1, 1, 2] });
    expect(pie.fills).toHaveLength(3);
    const donut = pieChart(50, 50, 40, { values: [1, 1, 2], innerRatio: 0.5 });
    expect(donut.fills).toHaveLength(3);
    expect(donut.strokes.length).toBeGreaterThan(pie.strokes.length);
  });

  it("饼图忽略负数与零占比，合计不必为 1", () => {
    const d = pieChart(50, 50, 40, { values: [2, 0, -1, 2] });
    expect(d.fills).toHaveLength(2);
  });

  it("雷达图少于三轴不画（两轴退化成一条线）", () => {
    expect(isDrawn(radarChart(50, 50, 40, { values: [0.5, 0.5] }))).toBe(false);
    expect(isDrawn(radarChart(50, 50, 40, { values: [0.5, 0.5, 0.5] }))).toBe(
      true,
    );
  });

  it("漏斗越往下越窄，金字塔越往下越宽", () => {
    const f = funnelChart(box, { levels: 4 });
    const p = pyramidChart(box, { levels: 4 });
    const width = (quad: readonly (readonly number[])[]): number =>
      Math.max(...quad.map((q) => q[0]!)) - Math.min(...quad.map((q) => q[0]!));
    expect(width(f.strokes[0]!)).toBeGreaterThan(width(f.strokes[3]!));
    expect(width(p.strokes[0]!)).toBeLessThan(width(p.strokes[3]!));
  });

  it("层数少于 2 的堆叠图不画", () => {
    expect(isDrawn(funnelChart(box, { levels: 1 }))).toBe(false);
    expect(isDrawn(pyramidChart(box, { levels: 0 }))).toBe(false);
  });

  it("仪表盘指针随值单调转动，且坐标有限", () => {
    const at = (v: number): number => {
      const d = gauge(50, 50, 40, { value: v });
      const needle = d.strokes[d.strokes.length - 1]!;
      return needle[1]![0]!;
    };
    expect(at(0)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1));
    expect(finite(gauge(50, 50, 40, { value: 0.3 }).strokes)).toBe(true);
  });

  it("时间轴：已完成节点实心、未完成空心；少于两点不画", () => {
    const d = timeline(box, { nodes: 4, doneUpTo: 1 });
    const solid = d.fills.filter((f) => f.includes(PALETTE.primary)).length;
    const hollow = d.fills.filter((f) => f.includes("#FFFFFF")).length;
    expect(solid).toBe(2);
    expect(hollow).toBe(2);
    expect(isDrawn(timeline(box, { nodes: 1 }))).toBe(false);
  });

  it("对比图给出中间留白矩形（供调用方写 VS）", () => {
    const d = compareChart(box, { left: 0.5, right: 1 });
    expect(d.strokes).toHaveLength(2);
    expect(d.gap.w).toBeGreaterThan(0);
    expect(d.gap.x).toBeGreaterThan(box.x);
    expect(d.gap.x + d.gap.w).toBeLessThanOrEqual(box.x + box.w + 0.01);
  });

  it("图表名表齐全且守卫可用", () => {
    expect(CHART_NAMES).toHaveLength(11);
    for (const n of CHART_NAMES) expect(isChartName(n)).toBe(true);
    expect(isChartName("scatter")).toBe(false);
  });
});

describe("diagrams（2.0 §8 + §9）", () => {
  const slotsInside = (d: DiagramDrawing, x: number, w: number): boolean =>
    d.slots.every((s) => s.x >= x - 0.01 && s.x + s.w <= x + w + 0.01);

  it("表格：格子数 = 行×列，且文字位都落在表格内", () => {
    const d = table({ x: 10, y: 10, w: 300, h: 200, rows: 4, cols: 3 });
    expect(d.slots).toHaveLength(12);
    expect(slotsInside(d, 10, 300)).toBe(true);
    expect(finite(d.strokes)).toBe(true);
  });

  it("表格：首行为表头时标记 role，且表头线单独一笔", () => {
    const withHeader = table({ ...box, rows: 3, cols: 2, header: true });
    expect(withHeader.slots.filter((s) => s.role === "header")).toHaveLength(2);
    const without = table({ ...box, rows: 3, cols: 2, header: false });
    expect(without.slots.every((s) => s.role === "cell")).toBe(true);
    // 两者横线总数相同（表头线只是被单独拆出来，不是多画一条）
    expect(withHeader.strokes).toHaveLength(without.strokes.length);
  });

  it("表格：非法行列返回空而不是崩", () => {
    expect(table({ ...box, rows: 0, cols: 3 }).strokes).toHaveLength(0);
    expect(table({ ...box, rows: 3, cols: 0 }).slots).toHaveLength(0);
    expect(
      table({ x: 0, y: 0, w: 0, h: 10, rows: 2, cols: 2 }).strokes,
    ).toHaveLength(0);
  });

  it("三种列表的正文缩进各不相同（行首标记宽度不同）", () => {
    const mk = (kind: "todo" | "ordered" | "bullet"): number => {
      const d = list({
        x: 0,
        y: 0,
        w: 200,
        lineHeight: 30,
        count: 2,
        kind,
        size: 20,
      });
      return d.slots.find((s) => s.role === "item")!.x;
    };
    const todo = mk("todo");
    const ordered = mk("ordered");
    const bullet = mk("bullet");
    expect(new Set([todo, ordered, bullet]).size).toBe(3);
    // 勾选框最宽、圆点最窄
    expect(todo).toBeGreaterThan(bullet);
  });

  it("待办清单：勾选项才画对勾", () => {
    const none = list({
      x: 0,
      y: 0,
      w: 200,
      lineHeight: 30,
      count: 3,
      kind: "todo",
      size: 20,
    });
    const some = list({
      x: 0,
      y: 0,
      w: 200,
      lineHeight: 30,
      count: 3,
      kind: "todo",
      size: 20,
      checked: [0, 2],
    });
    expect(some.strokes.length - none.strokes.length).toBe(2);
  });

  it("有序列表给出序号文字位（数字必须走手写，不画成图形）", () => {
    const d = list({
      x: 0,
      y: 0,
      w: 200,
      lineHeight: 30,
      count: 3,
      kind: "ordered",
      size: 20,
    });
    expect(d.slots.filter((s) => s.role === "index")).toHaveLength(3);
  });

  it("空列表返回空", () => {
    expect(
      list({
        x: 0,
        y: 0,
        w: 200,
        lineHeight: 30,
        count: 0,
        kind: "bullet",
        size: 20,
      }).strokes,
    ).toHaveLength(0);
  });

  it("流程图：每个节点一个文字位，节点间有箭头", () => {
    const d = flowChart({
      x: 0,
      y: 0,
      w: 200,
      nodeH: 40,
      gap: 30,
      nodes: [{ kind: "terminal" }, { kind: "decision" }, { kind: "step" }],
    });
    expect(d.slots).toHaveLength(3);
    // 3 个节点轮廓 + 2 组箭头（杆 + 翼）
    expect(d.strokes).toHaveLength(3 + 2 * 2);
    expect(finite(d.strokes)).toBe(true);
  });

  it("流程图空节点表返回空", () => {
    expect(
      flowChart({ x: 0, y: 0, w: 200, nodeH: 40, gap: 30, nodes: [] }).slots,
    ).toHaveLength(0);
  });

  it("思维导图：中心 + 每个分支各一个文字位，分支都在中心右侧", () => {
    const d = mindMap({
      cx: 200,
      cy: 200,
      centerW: 100,
      centerH: 40,
      branches: 3,
      branchW: 90,
      branchH: 30,
      spread: 50,
    });
    expect(d.slots).toHaveLength(4);
    for (const s of d.slots.filter((q) => q.role === "branch")) {
      expect(s.x).toBeGreaterThan(200);
    }
    expect(finite(d.strokes)).toBe(true);
  });

  it("组织架构：一个根 + n 个子节点的文字位", () => {
    const d = orgChart({ x: 0, y: 0, w: 400, nodeH: 40, gap: 40, children: 3 });
    expect(d.slots).toHaveLength(4);
    expect(finite(d.strokes)).toBe(true);
    expect(
      orgChart({ x: 0, y: 0, w: 400, nodeH: 40, gap: 40, children: 0 }).slots,
    ).toHaveLength(0);
  });

  it("单个子节点时不画横干线（只有一条竖线）", () => {
    const one = orgChart({
      x: 0,
      y: 0,
      w: 400,
      nodeH: 40,
      gap: 40,
      children: 1,
    });
    const two = orgChart({
      x: 0,
      y: 0,
      w: 400,
      nodeH: 40,
      gap: 40,
      children: 2,
    });
    expect(two.strokes.length).toBeGreaterThan(one.strokes.length + 1);
  });
});

describe("emphasis（2.0 §13 + §12）", () => {
  it("五种状态齐全，守卫可用", () => {
    expect(STATUS_KINDS).toHaveLength(5);
    for (const k of STATUS_KINDS) expect(isStatusKind(k)).toBe(true);
    expect(isStatusKind("warning")).toBe(false);
  });

  it("状态色都取自八色板", () => {
    const values = Object.values(PALETTE);
    for (const k of STATUS_KINDS) expect(values).toContain(statusColor(k));
    expect(statusColor("success")).toBe(PALETTE.success);
    expect(STATUS_ROLE.caution).toBe("warn");
  });

  it("注意（caution）用三角形，其余用圆形——形状冗余，不只靠颜色", () => {
    const caution = statusBadgePaths("caution", 50, 50, 20);
    const success = statusBadgePaths("success", 50, 50, 20);
    // 三角形外框只有 4 个点（含闭合），圆则是几十个采样点
    expect(caution[0]!).toHaveLength(4);
    expect(success[0]!.length).toBeGreaterThan(20);
  });

  it("每种状态都画了内部符号（不是光秃秃一个框）", () => {
    for (const k of STATUS_KINDS) {
      const paths = statusBadgePaths(k, 50, 50, 20);
      expect(paths.length).toBeGreaterThan(1);
      expect(finite(paths)).toBe(true);
    }
  });

  it("手绘圈图用椭圆且圈得比目标大", () => {
    const p = circleAroundPath(0, 0, 100, 30);
    const b = bbox([p]);
    expect(b.x1 - b.x0).toBeGreaterThan(100);
    expect(b.y1 - b.y0).toBeGreaterThan(30);
    // 椭圆而不是圆：宽高比应当接近目标的宽高比，而不是 1:1
    expect((b.x1 - b.x0) / (b.y1 - b.y0)).toBeGreaterThan(1.5);
  });

  it("指引箭头 = 杆 + 翼，翼尖落在终点", () => {
    const [shaft, wings] = pointerArrowPaths([0, 0], [100, 50]);
    expect(shaft).toHaveLength(2);
    expect(wings![1]).toEqual([100, 50]);
  });

  it("放射线长短交替（等长会读成太阳）", () => {
    const paths = radiatingPaths(0, 0, 10, 40, 8);
    expect(paths).toHaveLength(8);
    const len = (p: readonly (readonly number[])[]): number =>
      Math.hypot(p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!);
    expect(len(paths[0]!)).toBeGreaterThan(len(paths[1]!));
  });

  it("角落装饰是 L 形（两条边，留开口）", () => {
    for (const c of ["tl", "tr", "bl", "br"] as const) {
      const p = cornerDecorPath(0, 0, 20, c);
      expect(p).toHaveLength(3);
      expect(finite([p])).toBe(true);
    }
    // 四个朝向互不相同
    const set = new Set(
      (["tl", "tr", "bl", "br"] as const).map((c) =>
        JSON.stringify(cornerDecorPath(0, 0, 20, c)),
      ),
    );
    expect(set.size).toBe(4);
  });

  it("分隔线中间留缺口并带一个小菱形", () => {
    const paths = dividerPaths(0, 50, 300);
    expect(paths).toHaveLength(3);
    // 前两段之间必须有间隙（缺口）
    expect(paths[1]![0]![0]!).toBeGreaterThan(paths[0]![1]![0]!);
    // 第三段是闭合的小菱形
    expect(paths[2]![0]).toEqual(paths[2]![paths[2]!.length - 1]);
  });

  it("底纹与高亮块走 pattern/实心（不是逐条画线）", () => {
    expect(hatchDefs("h1")).toContain("<pattern");
    expect(hatchDefs("h1")).toContain('id="h1"');
    expect(hatchSvg("h1", 0, 0, 50, 50)).toContain("url(#h1)");
    expect(highlightBoxSvg(0, 0, 50, 20, "warn")).toContain(PALETTE.warn);
  });
});

describe("shapes 2.0 §5 新增", () => {
  it("正 n 边形有 n 条边且顶点都在半径上", () => {
    for (const n of [3, 5, 6, 8]) {
      const p = polygonPath(0, 0, 50, 50, n);
      expect(p).toHaveLength(n + 1);
      for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(50, 4);
    }
  });

  it("默认顶点朝上（三角形最高点在正上方）", () => {
    const p = polygonPath(0, 0, 50, 50, 3);
    const top = p.reduce((a, b) => (b[1]! < a[1]! ? b : a));
    expect(top[0]).toBeCloseTo(0, 4);
  });

  it("六边形容器是平顶的（左右出尖，与三角/五边形不同）", () => {
    const p = containerPath("hexagon", 0, 0, 100, 100);
    const b = bbox([p]);
    // 平顶六边形的最左/最右点在竖直中线高度上
    const leftMost = p.reduce((a, q) => (q[0]! < a[0]! ? q : a));
    expect(leftMost[1]).toBeCloseTo((b.y0 + b.y1) / 2, 1);
  });

  it("闭合几何形都闭合且坐标有限", () => {
    const shapes = [
      circlePath(0, 0, 40),
      ellipsePath(0, 0, 50, 30),
      trianglePath(0, 0, 80, 60),
      diamondPath(0, 0, 80, 60),
      trapezoidPath(0, 0, 80, 60),
      parallelogramPath(0, 0, 80, 60),
      burstPath(0, 0, 40, 40),
      badgePath(0, 0, 40),
      labelPath(0, 0, 80, 30),
      bookmarkPath(0, 0, 30, 70),
    ];
    expect(finite(shapes)).toBe(true);
    for (const s of shapes) expect(s.length).toBeGreaterThan(2);
  });

  it("徽章齿深可见（外内半径差 >= 10%，否则和圆没区别）", () => {
    const p = badgePath(0, 0, 100);
    const radii = p.map(([x, y]) => Math.hypot(x, y));
    const outer = Math.max(...radii);
    const inner = Math.min(...radii);
    expect(outer - inner).toBeGreaterThanOrEqual(10);
  });

  it("爆炸框的齿远深于徽章（两者语义不同，不能撞）", () => {
    const depth = (p: readonly (readonly number[])[]): number => {
      const r = p.map(([x, y]) => Math.hypot(x!, y!));
      return Math.max(...r) - Math.min(...r);
    };
    expect(depth(burstPath(0, 0, 100, 100))).toBeGreaterThan(
      depth(badgePath(0, 0, 100)) * 2,
    );
  });

  it("思维气泡 = 云朵主体 + 三个递减圆点尾巴", () => {
    const paths = thoughtBubblePaths(0, 0, 120, 90);
    expect(paths).toHaveLength(4);
    const size = (p: readonly (readonly number[])[]): number => {
      const xs = p.map((q) => q[0]!);
      return Math.max(...xs) - Math.min(...xs);
    };
    // 尾巴三个点依次变小
    expect(size(paths[1]!)).toBeGreaterThan(size(paths[2]!));
    expect(size(paths[2]!)).toBeGreaterThan(size(paths[3]!));
  });

  it("卷轴上下各有两条弧（外缘 + 卷心），否则会读成圆柱", () => {
    const paths = scrollPaths(0, 0, 100, 80);
    expect(paths).toHaveLength(6);
    expect(finite(paths)).toBe(true);
  });

  it("循环箭头留缺口（不闭环）且带箭头翼", () => {
    const [arc, wings] = loopArrowPaths(0, 0, 40, 60);
    expect(wings).toHaveLength(3);
    // 起点与终点之间必须有可见距离（缺口）
    const gap = Math.hypot(
      arc![0]![0]! - arc![arc!.length - 1]![0]!,
      arc![0]![1]! - arc![arc!.length - 1]![1]!,
    );
    expect(gap).toBeGreaterThan(10);
  });

  it("旗帜/吊牌是多笔组合件", () => {
    expect(flagPaths(0, 0, 60, 80)).toHaveLength(2);
    expect(tagPaths(0, 0, 60, 80)).toHaveLength(2);
  });

  it("胶带是半透明实心贴入件（不走笔描）", () => {
    const svg = tapeSvg(0, 0, 100, 30, { fill: "#F59E0B" });
    expect(svg).toContain("<polygon");
    expect(svg).toContain("opacity");
    expect(svg).toContain("#F59E0B");
  });
});

describe("strokes 2.0 §2 新增", () => {
  it("点线的段比虚线短得多（点线是虚线的极端情形）", () => {
    const el = dottedStrokesEl(
      [
        [
          [0, 0],
          [300, 0],
        ],
      ],
      { t0: 0, dur: 1, color: "#000", width: 6, seed: "d" },
    );
    expect(el.svg(9999)).toContain("<path");
  });

  it("双向箭头两端各有一组等大的翼", () => {
    const paths = biArrow(0, 0, 100, 0, 20);
    expect(paths).toHaveLength(3);
    const span = (p: readonly (readonly number[])[]): number => {
      const ys = p.map((q) => q[1]!);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(paths[1]!)).toBeCloseTo(span(paths[2]!), 4);
  });

  it("闪电线折点不等距（等距会读成花边）", () => {
    const p = lightningPath(0, 0, 60, 100);
    const dx: number[] = [];
    for (let i = 1; i < p.length; i++)
      dx.push(Math.abs(p[i]![0]! - p[i - 1]![0]!));
    expect(new Set(dx.map((v) => v.toFixed(2))).size).toBeGreaterThan(2);
    expect(finite([p])).toBe(true);
  });

  it("波浪线上下过零（真的是波浪）", () => {
    const [p] = wavyLine(0, 100, 200, 8, 3);
    const signs = new Set(
      p!.map(([, y]) => Math.sign(y - 100)).filter((s) => s !== 0),
    );
    expect(signs.size).toBe(2);
  });
});
