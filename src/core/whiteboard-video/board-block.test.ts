/**
 * board-block / inline-marks 的单测。
 *
 * 重点在**校验的失败路径**：这些块的价值是"写错时当场报错"，而报错路径最容易
 * 在重构中悄悄退化成静默降级（返回空图形），成片上表现为少画一个东西。
 */
import { describe, expect, test } from "bun:test";

import { ValidationError } from "../errors/index";
import {
  BOARD_BLOCK_KINDS,
  boardBeats,
  isBoardBlockKind,
  parseBoardBlock,
} from "./board-block";
import { hasInlineMarks, parseInlineMarks } from "./inline-marks";

const CTX = { ink: "#222", bodySize: 40, idp: "t" };
const BOX = { x: 0, y: 0, w: 900, h: 400 };

describe("parseBoardBlock", () => {
  test("表格：行列与表头", () => {
    const spec = parseBoardBlock("table", "方案 | 成本\n自建 | 高");
    expect(spec).toEqual({
      kind: "table",
      rows: [
        ["方案", "成本"],
        ["自建", "高"],
      ],
    });
  });

  test("表格：列数不齐报错", () => {
    expect(() => parseBoardBlock("table", "a | b\nc")).toThrow(ValidationError);
  });

  test("表格：单格过长报错", () => {
    expect(() =>
      parseBoardBlock("table", "a | b\nc | 九个字九个字九个字"),
    ).toThrow(/过长/);
  });

  test("流程：问号结尾是判断，无入边/无出边的是起止", () => {
    const spec = parseBoardBlock("flow", "开始\n判断吗？\n结束");
    if (spec.kind !== "flow") throw new Error("kind");
    expect(spec.nodes.map((n) => n.kind)).toEqual([
      "terminal",
      "decision",
      "terminal",
    ]);
    expect(spec.nodes[1]!.text).toBe("判断吗");
    // 相邻节点行自动串链
    expect(spec.edges.length).toBe(2);
  });

  test("流程：分支 + 汇合（同一段文本被两条边指向 = 汇合）", () => {
    const spec = parseBoardBlock(
      "flow",
      [
        "预算够吗？",
        "预算够吗？ -[够]-> 定方案",
        "预算够吗？ -[不够]-> 砍范围",
        "定方案 -> 上线",
        "砍范围 -> 上线",
      ].join("\n"),
    );
    if (spec.kind !== "flow") throw new Error("kind");
    expect(spec.nodes.map((n) => n.text)).toEqual([
      "预算够吗",
      "定方案",
      "砍范围",
      "上线",
    ]);
    expect(spec.edges.filter((e) => e.to === spec.nodes[3]!.id).length).toBe(2);
    expect(spec.edges.map((e) => e.label).filter(Boolean)).toEqual([
      "够",
      "不够",
    ]);
    // 判断节点保持菱形；汇合点两条入边、无出边 → 终止形状
    expect(spec.nodes[0]!.kind).toBe("decision");
    expect(spec.nodes[3]!.kind).toBe("terminal");
  });

  test("流程：自环报错", () => {
    expect(() => parseBoardBlock("flow", "甲\n甲 -> 甲")).toThrow(/自环/);
  });

  test("导图：首行是中心", () => {
    const spec = parseBoardBlock("mindmap", "中心\n分支一\n分支二");
    if (spec.kind !== "mindmap") throw new Error("kind");
    expect(spec.center).toBe("中心");
    expect(spec.branches).toEqual(["分支一", "分支二"]);
  });

  test("图标流：未知图标名报错并给提示", () => {
    expect(() =>
      parseBoardBlock("icons", "no-such | 标签\nstar | 另一个"),
    ).toThrow(/不在图标库/);
  });

  test("场景：未知场景名报错", () => {
    expect(() => parseBoardBlock("scene lecture", "")).not.toThrow();
    expect(() => parseBoardBlock("scene nope", "")).toThrow(/不支持/);
  });

  test("便签：形状白名单 + 恰好一行", () => {
    expect(parseBoardBlock("note cloud", "一句话")).toEqual({
      kind: "note",
      shape: "cloud",
      text: "一句话",
    });
    expect(() => parseBoardBlock("note", "一行\n两行")).toThrow(/一行/);
    expect(() => parseBoardBlock("note box", "x")).toThrow(/不支持/);
  });

  test("状态：状态名白名单", () => {
    expect(() => parseBoardBlock("status", "success | 好了")).not.toThrow();
    expect(() => parseBoardBlock("status", "nope | 好了")).toThrow(/不支持/);
  });

  test("未知块种类报错", () => {
    expect(() => parseBoardBlock("wat", "")).toThrow(/不支持/);
  });

  test("kind 守卫与清单一致", () => {
    for (const k of BOARD_BLOCK_KINDS) expect(isBoardBlockKind(k)).toBe(true);
    expect(isBoardBlockKind("nope")).toBe(false);
  });
});

describe("boardBeats", () => {
  const cases: Array<[string, string]> = [
    ["table", "a | b\nc | d"],
    ["flow", "开始\n中间\n结束"],
    ["mindmap", "中心\n一\n二"],
    ["icons", "star | 一\nheart | 二"],
    ["scene lecture", ""],
    ["note sticky", "便签"],
    ["status", "success | 好"],
  ];

  for (const [info, body] of cases) {
    test(`${info}：拍子非空、时间单调、底边在框内`, () => {
      const spec = parseBoardBlock(info, body);
      const { beats, bottomY } = boardBeats(spec, BOX, CTX);
      expect(beats.length).toBeGreaterThan(0);
      let t = 0;
      for (const b of beats) {
        const r = b.build(t);
        expect(r.els.length).toBeGreaterThan(0);
        // 每一拍都必须推进时间，否则排片会把所有拍子叠在同一刻
        expect(r.end).toBeGreaterThan(t);
        t = r.end;
      }
      expect(bottomY).toBeGreaterThan(BOX.y);
      expect(bottomY).toBeLessThanOrEqual(BOX.y + BOX.h + 1);
    });
  }

  test("图标流在窄框里改成纵向排（拍子数不变、底边更深）", () => {
    const spec = parseBoardBlock("icons", "star | 一\nheart | 二\nstar | 三");
    const wide = boardBeats(spec, { x: 0, y: 0, w: 1200, h: 400 }, CTX);
    const narrow = boardBeats(spec, { x: 0, y: 0, w: 420, h: 400 }, CTX);
    expect(narrow.beats.length).toBe(wide.beats.length);
    expect(narrow.bottomY).toBeGreaterThan(wide.bottomY);
  });
});

describe("parseInlineMarks", () => {
  test("三种标记都拆出区间，文本去掉符号", () => {
    const r = parseInlineMarks("成本要==按季度==复核 **重点** ((圈))");
    expect(r.text).toBe("成本要按季度复核 重点 圈");
    expect(r.marks.map((m) => m.kind)).toEqual(["highlight", "key", "circle"]);
    const hl = r.marks[0]!;
    expect(r.text.slice(hl.from, hl.to)).toBe("按季度");
  });

  test("未闭合报错", () => {
    expect(() => parseInlineMarks("这是==半个")).toThrow(/没有闭合/);
  });

  test("嵌套报错", () => {
    expect(() => parseInlineMarks("==外**内**外==")).toThrow(/不能嵌套/);
  });

  test("空标记报错", () => {
    expect(() => parseInlineMarks("前====后")).toThrow(/没有文字/);
  });

  test("无标记时原样返回", () => {
    const r = parseInlineMarks("普通一行");
    expect(r.text).toBe("普通一行");
    expect(r.marks).toEqual([]);
    expect(hasInlineMarks("普通一行")).toBe(false);
    expect(hasInlineMarks("有==标记==")).toBe(true);
  });
});
