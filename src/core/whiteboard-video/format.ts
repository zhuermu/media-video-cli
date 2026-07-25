/**
 * PoC: 体裁 —— 短竖版 vs 长横版
 *
 * 同一份分镜要能出两种片子，区别不只是画幅：
 *
 * | | 短片（<3min） | 长片（≥3min） |
 * |-|---------------|----------------|
 * | 画幅 | 1080×1920 竖 | 1920×1080 横 |
 * | 版式 | 单栏纵向流 | 双栏（左文右图） |
 * | 页眉 | 无 | 全片标题 + 进度 `02 / 05` |
 * | 字号 | 相对更大（手机近看） | 相对更小（一屏放更多） |
 * | 音色 | 年轻、语速偏快 | 播音腔、语速偏慢 |
 * | 转场 | 整板擦净 | 整板擦净 |
 *
 * ## 为什么按时长分而不是让用户选
 *
 * 时长是内容决定的，不是偏好：3 分钟以上的教程在竖屏里没法双栏排版（横向
 * 只有 1080，一栏文字加一栏图就都挤成条），而 30 秒的短片放进横屏则大片
 * 留白。所以体裁应该从"这篇文章要讲多久"推出来，而不是当成一个独立选项。
 *
 * 判定用的是**实测配音总时长**（TTS 合成之后才知道），不是字数估算——中文
 * 每秒字数因音色和标点差异能有 30% 的浮动。
 *
 * 用户仍可用 `> format: short|long` 强制覆盖（比如明知内容长但只想发竖版）。
 */

import { fmt } from "../whiteboard/index";
import type { VideoKind } from "./article";
import { LANDSCAPE, PORTRAIT } from "./layout";
import type { Layout } from "./layout";
import { vectorText } from "./subtitle";
import { KIND_DEFAULT_VOICE } from "./voices";

/** 短/长片的分界（秒）. */
export const LONG_FORM_THRESHOLD_SEC = 180;

/** 确定的体裁（auto 已被解析掉）. */
export type ResolvedKind = "short" | "long";

export interface FormatSpec {
  kind: ResolvedKind;
  layout: Layout;
  /** 默认旁白音色 id（脚本里的 cast 优先）. */
  defaultVoiceId: string;
  /** 是否画页眉（全片标题 + 段序）. */
  chrome: boolean;
}

/**
 * 定体裁。
 *
 * @param declared 脚本里的 `> format:`（auto = 按时长判）
 * @param narrationTotalSec 实测配音总时长
 */
export function resolveFormat(
  declared: VideoKind,
  narrationTotalSec: number,
): FormatSpec {
  const kind: ResolvedKind =
    declared === "auto"
      ? narrationTotalSec >= LONG_FORM_THRESHOLD_SEC
        ? "long"
        : "short"
      : declared;
  return {
    kind,
    layout: kind === "long" ? LANDSCAPE : PORTRAIT,
    defaultVoiceId: KIND_DEFAULT_VOICE[kind],
    chrome: kind === "long",
  };
}

export interface ChromeOpts {
  /** 全片标题（页眉左侧）. */
  title: string;
  /** 当前段序（1 起）与总段数. */
  index: number;
  total: number;
  color: string;
  accent: string;
}

/**
 * 长片页眉：一条细横线 + 左侧全片标题 + 右侧 `02 / 05`。
 *
 * 长教程里观众会中途加入或跳看，页眉是"我现在在哪"的唯一线索。短片不需要
 * ——30 秒的东西没人会跳看，页眉只会占掉本来就紧张的竖向空间。
 *
 * 页眉**不用手写体也不用笔画出来**：它是取景框的一部分，不是白板上的内容。
 * 让它跟着笔一起被画出来，观众会以为它也是讲解的一环。
 */
export function chromeSvg(l: Layout, o: ChromeOpts): string {
  const size = l.type.label * 0.6;
  const top = l.marginTop * 0.34;
  const right = l.width - l.marginX;
  const ruleY = top + size * 1.5;
  const title = vectorText(o.title, {
    x: l.marginX,
    y: top,
    size,
    color: o.color,
    opacity: 0.5,
    tracking: size * 0.06,
  });
  const counter = vectorText(
    `${String(o.index).padStart(2, "0")} / ${String(o.total).padStart(2, "0")}`,
    {
      x: right,
      y: top,
      size,
      color: o.accent,
      opacity: 0.85,
      anchor: "end",
      tracking: size * 0.04,
    },
  );
  return [
    title.svg,
    counter.svg,
    `<line x1="${fmt(l.marginX)}" y1="${fmt(ruleY)}" x2="${fmt(right)}" y2="${fmt(ruleY)}" ` +
      `stroke="${o.color}" stroke-opacity="0.13" stroke-width="1.5"/>`,
    // 进度条：走完一段填一段（比只写数字更容易一眼看懂）
    `<line x1="${fmt(l.marginX)}" y1="${fmt(ruleY)}" ` +
      `x2="${fmt(l.marginX + (right - l.marginX) * (o.index / o.total))}" y2="${fmt(ruleY)}" ` +
      `stroke="${o.accent}" stroke-opacity="0.7" stroke-width="3"/>`,
  ].join("");
}
