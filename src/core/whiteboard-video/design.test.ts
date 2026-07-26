/**
 * 设计稿元素库单测（palette / strokes / shapes / board 背景）。
 *
 * 这些模块几乎全是几何与查表，测的重点不是"画得好不好看"（那由
 * `experiments/design-sheet.ts` 目视验收），而是**不变量**：
 * - 颜色表与设计稿标注一致（防止手滑改错一位十六进制）；
 * - 闭合形状真的闭合、点数有限、坐标有界（防止 NaN 静默吞掉整个 path）；
 * - 虚线切段随长度单调、段数有限（防止 while 循环在退化输入上不终止）。
 */

import { describe, expect, it } from "bun:test";

import {
  BOARD_BACKGROUNDS,
  BOARD_DESIGN,
  backgroundDefs,
  backgroundSurface,
  backgroundSvg,
  boardCornersSvg,
  boardStyleFor,
  isBoardBackground,
} from "./board";
import { markerTextEl, markerWeight, textWidth } from "./blocks";
import {
  HIGHLIGHTS,
  INK_ROLES,
  PALETTE,
  SERIES_ROLES,
  defaultPalette,
  highlightOf,
  inkOf,
  isInkRole,
  paletteWith,
  seriesColor,
} from "./palette";
import {
  CONTAINER_NAMES,
  bracePath,
  cloudPath,
  containerPath,
  isContainerName,
  rectPath,
  roundRectPath,
  speechBoxPath,
  starCalloutPaths,
  starPath,
  stickyNoteSvg,
} from "./shapes";
import {
  LINE_W,
  curvedArrow,
  dashSegments,
  dashedArrowEl,
  dashedStrokesEl,
  highlightEl,
  scribbleEl,
  scribblePaths,
  straightArrow,
  straightLine,
  wavyUnderline,
} from "./strokes";

/** 所有坐标都是有限数（NaN 会让 resvg 静默丢弃整条 path——最难查的一类 bug）. */
function allFinite(
  paths: readonly (readonly (readonly number[])[])[],
): boolean {
  return paths.every((p) =>
    p.every((pt) => pt.every((v) => Number.isFinite(v))),
  );
}

describe("palette（设计稿 2.0 §3）", () => {
  it("八色板的值与设计稿标注逐位一致", () => {
    expect(PALETTE.ink).toBe("#222222");
    expect(PALETTE.primary).toBe("#2563EB");
    expect(PALETTE.success).toBe("#16A34A");
    expect(PALETTE.warn).toBe("#F59E0B");
    expect(PALETTE.danger).toBe("#EF4444");
    expect(PALETTE.muted).toBe("#64748B");
    expect(PALETTE.accent2).toBe("#7C3AED");
    expect(PALETTE.info).toBe("#06B6D4");
  });

  it("角色清单与色表一一对应（不多不少）", () => {
    expect([...INK_ROLES].map(String).sort()).toEqual(
      Object.keys(PALETTE).sort(),
    );
    expect(INK_ROLES).toHaveLength(8);
  });

  it("并列取色序列不含 success/danger/muted（避免自带语义）", () => {
    expect(SERIES_ROLES).not.toContain("success");
    expect(SERIES_ROLES).not.toContain("danger");
    expect(SERIES_ROLES).not.toContain("muted");
  });

  it("seriesColor 越界回绕，且序列内颜色互不相同", () => {
    const n = SERIES_ROLES.length;
    const colors = Array.from({ length: n }, (_, i) => seriesColor(i));
    expect(new Set(colors).size).toBe(n);
    expect(seriesColor(n)).toBe(seriesColor(0));
    expect(seriesColor(n * 3 + 2)).toBe(seriesColor(2));
  });

  it("inkOf 未知/缺省角色回退主笔迹色，而不是抛错", () => {
    expect(inkOf(undefined)).toBe(PALETTE.ink);
    expect(inkOf("success")).toBe(PALETTE.success);
    // 越过类型系统模拟脏输入（脚本层可能传进任意字符串）
    expect(inkOf("nope" as never)).toBe(PALETTE.ink);
  });

  it("isInkRole 只认色表里的键", () => {
    expect(isInkRole("danger")).toBe(true);
    expect(isInkRole("blue")).toBe(false);
    // 原型链上的属性不能算合法角色
    expect(isInkRole("toString")).toBe(false);
  });

  it("默认强调色是蓝，不是红（红色专职风险）", () => {
    expect(defaultPalette().accent).toBe(PALETTE.primary);
    expect(defaultPalette().accent).not.toBe(PALETTE.danger);
  });

  it("paletteWith 覆盖 ink/accent 并同步进角色表", () => {
    const p = paletteWith("#111111", "#00FF00");
    expect(p.ink).toBe("#111111");
    expect(p.accent).toBe("#00FF00");
    expect(p.roles.ink).toBe("#111111");
    expect(p.roles.primary).toBe("#00FF00");
    // 未覆盖的角色保持设计稿原值
    expect(p.roles.danger).toBe(PALETTE.danger);
  });

  it("highlightOf 越界回绕，且三条强调色互不相同", () => {
    const three = [0, 1, 2].map(highlightOf);
    expect(new Set(three).size).toBe(3);
    expect(highlightOf(3)).toBe(highlightOf(0));
    expect(highlightOf(HIGHLIGHTS.length * 5 + 1)).toBe(highlightOf(1));
  });
});

describe("board 背景（设计稿 §2）", () => {
  it("八种背景齐全且都能通过守卫（六种纸面 + 两种深板）", () => {
    expect(BOARD_BACKGROUNDS).toHaveLength(8);
    for (const bg of BOARD_BACKGROUNDS)
      expect(isBoardBackground(bg)).toBe(true);
    expect(isBoardBackground("marble")).toBe(false);
  });

  it("纯白与米白无 pattern；网格/横线/点阵/纸纹有", () => {
    expect(backgroundDefs("plain")).toBe("");
    expect(backgroundDefs("cream")).toBe("");
    for (const bg of ["grid", "lined", "dots", "texture"] as const) {
      expect(backgroundDefs(bg)).toContain("<pattern");
    }
  });

  it("pattern 一律 userSpaceOnUse（否则运镜时格距会变）", () => {
    for (const bg of ["grid", "lined", "dots", "texture"] as const) {
      expect(backgroundDefs(bg)).toContain('patternUnits="userSpaceOnUse"');
    }
  });

  it("pattern id 可覆盖——对照表要在一张 SVG 里放六种背景", () => {
    expect(backgroundDefs("grid", "bg-grid")).toContain('id="bg-grid"');
    expect(backgroundSvg("grid", 0, 0, 100, 100, "bg-grid")).toContain(
      "url(#bg-grid)",
    );
  });

  it("无纹理背景不产生绘制层（省掉一个整屏 rect）", () => {
    expect(backgroundSvg("plain", 0, 0, 100, 100)).toBe("");
    expect(backgroundSvg("grid", 0, 0, 100, 100)).toContain("<rect");
  });

  it("米白纸换底色，其余沿用白板面", () => {
    expect(backgroundSurface("cream").surface).toBe("#FAF6EC");
    expect(backgroundSurface("grid").surface).toBe("#FFFFFF");
    expect(boardStyleFor("cream", BOARD_DESIGN).surface).toBe("#FAF6EC");
    // 背景只改底色，不动光学层
    expect(boardStyleFor("cream", BOARD_DESIGN).vignette).toBe(
      BOARD_DESIGN.vignette,
    );
  });

  it("设计稿板面关掉反光（它是设计图，不是拍摄的白板）", () => {
    expect(BOARD_DESIGN.glare).toBe(0);
    expect(BOARD_DESIGN.cornerSize).toBeGreaterThan(0);
  });

  it("包角件画四个角；cornerSize 为 0 时不画", () => {
    const svg = boardCornersSvg(0, 0, 500, 300, BOARD_DESIGN, 1);
    expect(svg.match(/<path/g)).toHaveLength(4);
    expect(
      boardCornersSvg(0, 0, 500, 300, { ...BOARD_DESIGN, cornerSize: 0 }, 1),
    ).toBe("");
  });
});

describe("strokes（设计稿 §3）", () => {
  it("三档线宽单调递减且档间差 >= 40%（差太小读不出分类）", () => {
    expect(LINE_W.bold).toBeGreaterThan(LINE_W.medium);
    expect(LINE_W.medium).toBeGreaterThan(LINE_W.thin);
    expect(LINE_W.bold / LINE_W.medium).toBeGreaterThan(1.4);
    expect(LINE_W.medium / LINE_W.thin).toBeGreaterThan(1.4);
  });

  it("虚线切段：段数随线长单调增长，且每段自身有长度", () => {
    const short = dashSegments(straightLine(0, 0, 100, 0), "s");
    const long = dashSegments(straightLine(0, 0, 600, 0), "s");
    expect(long.length).toBeGreaterThan(short.length);
    for (const seg of long) {
      expect(seg.length).toBeGreaterThanOrEqual(2);
      expect(seg[seg.length - 1]![0]).toBeGreaterThan(seg[0]![0]);
    }
  });

  it("虚线切段对退化输入终止且不产生段（防死循环）", () => {
    expect(dashSegments([[0, 0]], "s")).toEqual([]);
    expect(dashSegments([], "s")).toEqual([]);
    // 零长度线：起终点重合，不应无限切
    expect(dashSegments(straightLine(5, 5, 5, 5), "s")).toEqual([]);
  });

  it("同 seed 的虚线切段逐帧稳定（帧渲染必须可重复）", () => {
    const a = dashSegments(straightLine(0, 0, 400, 0), "seed-x");
    const b = dashSegments(straightLine(0, 0, 400, 0), "seed-x");
    expect(a).toEqual(b);
  });

  it("箭头 = 杆 + 两翼，翼尖落在终点上", () => {
    const [shaft, wings] = straightArrow(0, 0, 100, 0, 20);
    expect(shaft).toHaveLength(2);
    expect(wings).toHaveLength(3);
    // 两翼的中点就是箭头尖（arrowHead 的约定）
    expect(wings![1]).toEqual([100, 0]);
  });

  it("曲线箭头的杆偏离弦（bow 生效）且坐标有限", () => {
    const straightMid = 50;
    const [shaft] = curvedArrow(0, 0, 100, 0, 0.3, 20);
    const mid = shaft![Math.floor(shaft!.length / 2)]!;
    expect(mid[0]).toBeCloseTo(straightMid, 0);
    // y 明显离开 0（弯了）
    expect(Math.abs(mid[1])).toBeGreaterThan(5);
    expect(allFinite([shaft!])).toBe(true);
  });

  it("bow=0 的曲线箭头退化成直线", () => {
    const [shaft] = curvedArrow(0, 0, 100, 0, 0, 20);
    for (const [, y] of shaft!) expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it("虚线箭头：杆先画完再落两翼（翼在杆之后）", () => {
    const el = dashedArrowEl(0, 0, 200, 0, {
      t0: 0,
      dur: 1,
      color: "#000",
      width: 9,
      seed: "da",
    });
    expect(el.t0).toBe(0);
    expect(el.t1).toBeCloseTo(1, 5);
    // 起点时刻还没有翼，终点时刻两者都在
    expect(el.svg(0.99)).toContain("<path");
  });

  it("荧光笔在动画中途只画出部分宽度，结束时画满", () => {
    const el = highlightEl(0, 0, 200, {
      t0: 0,
      dur: 1,
      color: "#F5C542",
      height: 30,
      seed: "h",
    });
    expect(el.svg(-1)).toBe("");
    const mid = el.svg(0.5);
    const end = el.svg(2);
    expect(mid).toContain("<path");
    expect(end).toContain("fill-opacity");
    // 半透明是荧光笔的定义特征
    expect(end).toContain("#F5C542");
  });

  it("荧光笔宽度为 0 时不出图元（不留空 path）", () => {
    const el = highlightEl(0, 0, 0, {
      t0: 0,
      dur: 1,
      color: "#000",
      height: 30,
      seed: "h",
    });
    expect(el.svg(2)).toBe("");
  });

  it("锯齿涂抹的 x 单调推进、y 在带内来回", () => {
    const [pts] = scribblePaths(0, 0, 100, 40, 4);
    for (let i = 1; i < pts!.length; i++) {
      expect(pts![i]![0]).toBeGreaterThanOrEqual(pts![i - 1]![0]);
    }
    const ys = new Set(pts!.map(([, y]) => y));
    expect(ys.size).toBe(2);
    expect(
      scribbleEl(0, 0, 100, 40, {
        t0: 0,
        dur: 1,
        color: "#000",
        seed: "s",
      }).svg(2),
    ).toContain("<path");
  });

  it("波浪下划线过零多次（真的是波浪不是直线）", () => {
    const [pts] = wavyUnderline(0, 100, 200, 5, 5);
    const signs = new Set(
      pts!.map(([, y]) => Math.sign(y - 100)).filter((s) => s !== 0),
    );
    expect(signs.size).toBe(2);
  });

  it("虚线元素在终态有图元", () => {
    const el = dashedStrokesEl([straightLine(0, 0, 300, 0)], {
      t0: 0,
      dur: 1,
      color: "#000",
      width: 9,
      seed: "d",
    });
    expect(el.svg(2)).toContain("<path");
  });
});

describe("shapes（设计稿 §4）", () => {
  it("矩形框闭合且四角都在给定框内", () => {
    const p = rectPath(10, 20, 100, 50);
    expect(allFinite([p])).toBe(true);
    const xs = p.map(([x]) => x);
    const ys = p.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(10, 1);
    expect(Math.max(...xs)).toBeCloseTo(110, 1);
    expect(Math.min(...ys)).toBeLessThanOrEqual(20.1);
    expect(Math.max(...ys)).toBeCloseTo(70, 1);
  });

  it("圆角框的圆角有上限（宽框不会变成胶囊）", () => {
    const wide = roundRectPath(0, 0, 1000, 120);
    // 顶边上应当存在一段 y≈0 的直线（说明不是整条弧）
    const flatTop = wide.filter(([, y]) => Math.abs(y) < 0.01);
    expect(flatTop.length).toBeGreaterThan(1);
    expect(allFinite([wide])).toBe(true);
  });

  it("圆角半径被框尺寸夹住（不会溢出小框）", () => {
    const tiny = roundRectPath(0, 0, 10, 10, 999);
    const xs = tiny.map(([x]) => x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(10.01);
  });

  it("云朵框闭合（首尾同点）且点数有限", () => {
    const p = cloudPath(0, 0, 200, 120);
    expect(p.length).toBeGreaterThan(20);
    expect(p.length).toBeLessThan(400);
    expect(p[0]).toEqual(p[p.length - 1]);
    expect(allFinite([p])).toBe(true);
  });

  it("对话框的尖尾伸到框外下方（否则读不出是对话框）", () => {
    const h = 100;
    const p = speechBoxPath(0, 0, 200, h);
    const maxY = Math.max(...p.map(([, y]) => y));
    expect(maxY).toBeGreaterThan(h);
    expect(allFinite([p])).toBe(true);
  });

  it("大括号的中尖比两臂更靠左（否则退化成 C）", () => {
    const depth = 30;
    const p = bracePath(100, 0, 200, depth);
    const minX = Math.min(...p.map(([x]) => x));
    const armXs = p.map(([x]) => x).filter((x) => x > minX + 1);
    expect(minX).toBeCloseTo(100, 1);
    // 中尖唯一，且与最近的臂有可见距离
    expect(Math.min(...armXs) - minX).toBeGreaterThan(depth * 0.3);
  });

  it("五角星闭合、五个外顶点在半径上", () => {
    const p = starPath(0, 0, 50);
    expect(p[0]).toEqual(p[p.length - 1]);
    for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(50, 4);
  });

  it("星形标注不带引线时只有星；带引线时多一条", () => {
    expect(starCalloutPaths(0, 0, 20)).toHaveLength(1);
    const withLead = starCalloutPaths(0, 0, 20, [100, 100]);
    expect(withLead).toHaveLength(2);
    expect(withLead[1]![1]).toEqual([100, 100]);
  });

  it("containerPath 按名分派，未知名回退矩形而不是空", () => {
    for (const n of CONTAINER_NAMES) {
      expect(containerPath(n, 0, 0, 100, 60).length).toBeGreaterThan(3);
    }
    expect(isContainerName("cloud")).toBe(true);
    // 2.0 把几何形也纳入容器（hexagon 等已是合法名），所以这里用一个真的不存在的
    expect(isContainerName("octagon")).toBe(false);
    expect(isContainerName("")).toBe(false);
  });

  it("便签纸是实心件：带填色、图钉可关", () => {
    const withPin = stickyNoteSvg(0, 0, 100, 100);
    expect(withPin).toContain("#FDF3C8");
    expect(withPin).toContain("<circle");
    expect(stickyNoteSvg(0, 0, 100, 100, { pin: false })).not.toContain(
      "<circle",
    );
  });
});

describe("字形不做轮廓膨胀（设计稿 §7 由字号承载字重）", () => {
  it("默认膨胀量为 0——字重由字体提供，不由后处理伪造", () => {
    expect(markerWeight(104)).toBe(0);
    expect(markerWeight(30)).toBe(0);
  });

  it("密笔画字在默认设置下字腔不被填死（「事」曾糊成黑团）", () => {
    // 回归锚点：膨胀量 >= 1px 时「事」在 size=104 下字腔闭合。
    // 这里锁住"默认不膨胀"，而不是去断言像素——像素由 design-sheet 目视验收。
    const el = markerTextEl("事", {
      x: 0,
      y: 0,
      size: 104,
      gap: 0,
      t0: 0,
      perChar: 0.01,
      color: "#2D2D2D",
      idp: "dense",
    });
    const svg = el.svg(9999);
    expect(svg).not.toBe("");
    // 外层 <g> 的 stroke-width 必须是 0：它就是那个把字腔吃掉的膨胀量
    expect(svg).toContain('stroke-width="0"');
  });

  it("显式传 weight 仍然生效（换回细笔画字体时要用）", () => {
    const svg = markerTextEl("事", {
      x: 0,
      y: 0,
      size: 104,
      gap: 0,
      t0: 0,
      perChar: 0.01,
      color: "#2D2D2D",
      idp: "w",
      weight: 3,
    }).svg(9999);
    expect(svg).toContain('stroke-width="3"');
  });

  it("字宽测量不含膨胀量（膨胀为 0 时宽度 = 字形步进 + 间距）", () => {
    // 站酷快乐体 CJK 步进为 0.92 em，所以两字 + 一个 10px 间距落在 194 附近。
    // 断言区间而不是定值：换字体时步进会变，但"两字宽度必须小于两个全宽"
    // 这个不变量要守住（否则说明又把膨胀量算进了排版口径）。
    const w = textWidth("事事", 100, 10);
    expect(w).toBeGreaterThan(150);
    expect(w).toBeLessThanOrEqual(210);
  });
});
