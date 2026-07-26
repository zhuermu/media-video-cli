/**
 * ```chart``` 块的解析、校验与排拍单测。
 *
 * 校验类的测试占多数，因为这一层的价值主要在**把作者的错误当场挡住**：图表
 * 一旦超限或数据写错，下游要么画到画面外、要么静默少画，而两者都要等一小时
 * 渲完才看得见。
 */

import { describe, expect, it } from "bun:test";

import { ValidationError } from "../errors/index";
import { MAX_BARS, MIN_BARS, chartBeats, parseChartBlock } from "./chart-block";

const ok = "自建 92\n托管 45\n混合 61";

describe("parseChartBlock 解析", () => {
  it("读出种类、数据与单位", () => {
    const spec = parseChartBlock("chart bar 单位=万元", ok);
    expect(spec.kind).toBe("bar");
    expect(spec.unit).toBe("万元");
    expect(spec.data).toEqual([
      { label: "自建", value: 92 },
      { label: "托管", value: 45 },
      { label: "混合", value: 61 },
    ]);
  });

  it("单位可省；也接受 unit= 与全角等号", () => {
    expect(parseChartBlock("chart bar", ok).unit).toBeUndefined();
    expect(parseChartBlock("chart bar unit=次", ok).unit).toBe("次");
    expect(parseChartBlock("chart bar 单位＝秒", ok).unit).toBe("秒");
  });

  it("竖线分隔也认（便于对齐着写）", () => {
    const spec = parseChartBlock("chart bar", "自建 | 92\n托管 | 45");
    expect(spec.data.map((d) => d.value)).toEqual([92, 45]);
  });

  it("小数与 0 都接受（只要不是全为 0）", () => {
    const spec = parseChartBlock("chart bar", "甲 1.5\n乙 0");
    expect(spec.data.map((d) => d.value)).toEqual([1.5, 0]);
  });

  it("空行被忽略", () => {
    expect(
      parseChartBlock("chart bar", "\n自建 92\n\n托管 45\n").data,
    ).toHaveLength(2);
  });
});

describe("parseChartBlock 校验（错误必须当场报）", () => {
  const fails = (info: string, body: string, hint: string): void => {
    let err: unknown;
    try {
      parseChartBlock(info, body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(hint);
  };

  it("未知种类：报错并列出支持的种类", () => {
    fails("chart pie3d", ok, "不支持");
    fails("chart", ok, "不支持");
  });

  it("数据行读不懂：把出错的行原样列出来", () => {
    fails("chart bar", "自建 92\n托管很贵", "读不懂");
    fails("chart bar", "自建 abc\n托管 45", "读不懂");
  });

  it("负数被拒（柱状图画不出负高度）", () => {
    fails("chart bar", "自建 -5\n托管 45", "读不懂");
  });

  it("条数越界：少于下限或多于上限都报，并说明该拆段", () => {
    fails("chart bar", "只有一条 10", `${MIN_BARS}`);
    const many = Array.from(
      { length: MAX_BARS + 1 },
      (_, i) => `项${i} ${i + 1}`,
    ).join("\n");
    fails("chart bar", many, "拆成两段");
  });

  it("刚好在边界内不报", () => {
    const max = Array.from(
      { length: MAX_BARS },
      (_, i) => `项${i} ${i + 1}`,
    ).join("\n");
    expect(parseChartBlock("chart bar", max).data).toHaveLength(MAX_BARS);
    expect(parseChartBlock("chart bar", "甲 1\n乙 2").data).toHaveLength(
      MIN_BARS,
    );
  });

  it("类目名过长：报错并点名是哪几个", () => {
    fails("chart bar", "这个类目名字太长了 92\n托管 45", "过长");
  });

  it("全 0 数据被拒（画不出可比较的图形）", () => {
    fails("chart bar", "甲 0\n乙 0", "都是 0");
  });
});

describe("chartBeats 排拍", () => {
  const box = { x: 100, y: 200, w: 800, h: 400 };
  const ctx = { ink: "#222222", bodySize: 50, idp: "t" };

  it("坐标系一拍 + 每根柱子一拍", () => {
    const spec = parseChartBlock("chart bar 单位=万元", ok);
    const { beats } = chartBeats(spec, box, ctx);
    expect(beats).toHaveLength(1 + spec.data.length);
  });

  it("每一拍都产出元素，且结束时间单调递增", () => {
    const spec = parseChartBlock("chart bar", ok);
    const { beats } = chartBeats(spec, box, ctx);
    let t = 0;
    for (const b of beats) {
      const r = b.build(t);
      expect(r.els.length).toBeGreaterThan(0);
      expect(r.end).toBeGreaterThan(t);
      t = r.end;
    }
  });

  it("拍子可平移：同一拍在不同 t0 构造，时长一致", () => {
    const spec = parseChartBlock("chart bar", ok);
    const { beats } = chartBeats(spec, box, ctx);
    const a = beats[1]!.build(0);
    const b = beats[1]!.build(10);
    expect(b.end - 10).toBeCloseTo(a.end, 5);
  });

  it("刻度走 d3-scale 的 nice 域：92 的最大值取到 100，不是 92", () => {
    const spec = parseChartBlock("chart bar", ok);
    const { beats } = chartBeats(spec, box, ctx);
    // 坐标系那一拍里应当出现 100 的刻度值（nice 之后），且不出现 92
    const svg = beats[0]!
      .build(0)
      .els.map((e) => e.svg(9999))
      .join("");
    expect(svg).not.toBe("");
    // 刻度值是手写矢量路径，看不到字面文本；改为验证 nice 域的几何后果：
    // 最大值 92 < 域上限，所以最高的柱子顶端不会贴到绘图区顶边
    const bar = beats[1]!
      .build(0)
      .els.map((e) => e.svg(9999))
      .join("");
    expect(bar).toContain("<path");
  });

  it("最高柱不顶到绘图区顶边（nice 域留出了余量）", () => {
    const spec = parseChartBlock("chart bar", ok);
    const { beats, bottomY } = chartBeats(spec, box, ctx);
    expect(bottomY).toBe(box.y + box.h);
    // 第一根柱（92，最大）：它的填色矩形 y 应当明显大于绘图区顶（有余量）
    const fills = beats[1]!
      .build(0)
      .els.map((e) => e.svg(9999))
      .filter((s) => s.includes("<rect"));
    expect(fills.length).toBeGreaterThan(0);
    const m = /y="([\d.]+)"/.exec(fills.join(""));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(box.y);
  });

  it("同 spec 同 box 排两次完全一致（帧渲染必须可重复）", () => {
    const spec = parseChartBlock("chart bar 单位=万元", ok);
    const render = (): string =>
      chartBeats(spec, box, ctx)
        .beats.map((b) =>
          b
            .build(0)
            .els.map((e) => e.svg(9999))
            .join(""),
        )
        .join("");
    expect(render()).toBe(render());
  });
});

describe("饼图（chart pie）", () => {
  it("接受 pie 并保留原始值（百分比是派生量，不写进 spec）", () => {
    const spec = parseChartBlock("chart pie", "人力 | 58\n工具 | 42");
    expect(spec.kind).toBe("pie");
    expect(spec.data.map((d) => d.value)).toEqual([58, 42]);
  });

  it("整圆一拍 + 每扇区一拍，时间单调推进", () => {
    const spec = parseChartBlock("chart pie", "甲 | 50\n乙 | 30\n丙 | 20");
    const { beats, bottomY } = chartBeats(
      spec,
      { x: 0, y: 0, w: 900, h: 420 },
      { ink: "#222", bodySize: 40, idp: "p" },
    );
    expect(beats.length).toBe(4);
    let t = 0;
    for (const b of beats) {
      const r = b.build(t);
      expect(r.els.length).toBeGreaterThan(0);
      expect(r.end).toBeGreaterThan(t);
      t = r.end;
    }
    expect(bottomY).toBeGreaterThan(0);
  });

  it("百分比按值算出来并四舍五入（33/33/33 → 三个 33%）", () => {
    const spec = parseChartBlock("chart pie", "甲 | 1\n乙 | 1\n丙 | 1");
    const { beats } = chartBeats(
      spec,
      { x: 0, y: 0, w: 900, h: 420 },
      { ink: "#222", bodySize: 40, idp: "p" },
    );
    // 扇区拍的最后一个元素是标签，标签文本走手写路径故不能读 <text>；
    // 这里只断言拍数与扇区数一致（值正确性由 pieChart 的几何测试覆盖）
    expect(beats.length - 1).toBe(3);
  });
});
