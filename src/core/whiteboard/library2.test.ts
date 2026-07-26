/**
 * 设计稿 2.0 收尾四块的单测：§6 分类图标库 / §10 场景化组件 / §4 笔触效果 /
 * §11 中英字体配对。
 *
 * 这四块的共同风险不是"算错坐标"，而是**引用不存在的东西**：分类表写了个已改名
 * 的图标、场景引用了个不存在的图标、字体清单声明了个没下载的文件。这类错误在
 * 渲染时全部表现为"静默少画一个元素"，成片里极难发现，所以这里主要测引用完整性。
 */

import { describe, expect, it } from "bun:test";

import {
  ICON_CATEGORIES,
  ICON_CATEGORY_NAMES,
  LINE_ART,
  LINE_ART_NAMES,
  danglingCategoryIcons,
  iconPaths,
  iconsInCategory,
} from "./index";
import {
  handwritingFont,
  handwritingFontCandidates,
  isCjk,
  latinHandwritingFont,
  setLatinFontPath,
} from "./glyphs";

describe("§6 分类图标库", () => {
  it("分类表不引用任何不存在的图标（改名/删图标时这条会红）", () => {
    expect(danglingCategoryIcons()).toEqual([]);
  });

  it("八个分类齐全，每类至少四个图标", () => {
    // 设计稿 §6 的八类 + 我们多加的「强调」一类
    expect(ICON_CATEGORY_NAMES.length).toBeGreaterThanOrEqual(8);
    for (const cat of ICON_CATEGORY_NAMES) {
      expect(iconsInCategory(cat).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("设计稿点名的八个分类都在", () => {
    for (const cat of [
      "人物",
      "物品",
      "办公",
      "商业",
      "教育",
      "科技",
      "自然",
      "符号",
    ]) {
      expect(ICON_CATEGORIES[cat]).toBeDefined();
    }
  });

  it("未知分类返回空数组，不抛错", () => {
    expect(iconsInCategory("不存在的分类")).toEqual([]);
  });

  it("每个图标都能实例化出有限坐标的折线（不产生 NaN）", () => {
    for (const name of LINE_ART_NAMES) {
      const paths = iconPaths(name, 50, 50, 80);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p.length).toBeGreaterThan(1);
        for (const [x, y] of p) {
          expect(Number.isFinite(x)).toBe(true);
          expect(Number.isFinite(y)).toBe(true);
        }
      }
    }
  });

  it("每个图标的笔画都落在实例化框内（留 10% 余量给手抖）", () => {
    for (const name of LINE_ART_NAMES) {
      const size = 100;
      const paths = iconPaths(name, 0, 0, size);
      const xs = paths.flat().map((p) => p[0]);
      const ys = paths.flat().map((p) => p[1]);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-size * 0.6);
      expect(Math.max(...xs)).toBeLessThanOrEqual(size * 0.6);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-size * 0.6);
      expect(Math.max(...ys)).toBeLessThanOrEqual(size * 0.6);
    }
  });

  it("2.0 新增的分类图标确实入库", () => {
    for (const n of [
      "person-female",
      "person-speaker",
      "file",
      "book",
      "gift",
      "calendar",
      "folder",
      "printer",
      "chart",
      "growth",
      "money",
      "blackboard",
      "pencil",
      "graduation",
      "robot",
      "chip",
      "cloud-sync",
      "tree",
      "flower",
      "mountain",
      "sun",
      "question",
      "exclaim",
    ]) {
      expect(LINE_ART[n]).toBeDefined();
    }
  });
});

describe("§11 中英字体配对", () => {
  it("主字体与拉丁字体都能加载，且不是同一支", () => {
    const main = handwritingFont();
    const latin = latinHandwritingFont();
    expect(main).not.toBeNull();
    expect(latin).not.toBeNull();
    expect(main?.names.fontFamily.en).not.toBe(latin?.names.fontFamily.en);
  });

  it("主字体覆盖 CJK，拉丁字体不覆盖（这正是需要配对的原因）", () => {
    expect(handwritingFont()?.charToGlyph("白").index).not.toBe(0);
    expect(latinHandwritingFont()?.charToGlyph("白").index).toBe(0);
  });

  it("候选顺序由 manifest 决定：主字体排在兜底楷体之前", () => {
    const order = handwritingFontCandidates();
    const zcool = order.indexOf("ZCOOLKuaiLe-Regular.ttf");
    const wenkai = order.indexOf("LXGWWenKai-Regular.ttf");
    expect(zcool).toBeGreaterThanOrEqual(0);
    expect(wenkai).toBeGreaterThan(zcool);
  });

  it("CJK 判定覆盖汉字与全角标点，排除拉丁与数字", () => {
    for (const c of ["白", "板", "，", "、", "！"]) expect(isCjk(c)).toBe(true);
    for (const c of ["A", "z", "5", "-", " "]) expect(isCjk(c)).toBe(false);
  });

  it("禁用拉丁字体后整套退回主字体（可降级，不报错）", () => {
    setLatinFontPath(null);
    try {
      expect(latinHandwritingFont()).toBeNull();
      // 主字体仍然可用
      expect(handwritingFont()).not.toBeNull();
    } finally {
      setLatinFontPath(undefined);
    }
    // 恢复后拉丁字体重新可用
    expect(latinHandwritingFont()).not.toBeNull();
  });
});
