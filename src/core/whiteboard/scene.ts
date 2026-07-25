/**
 * @module @core/whiteboard (scene)
 *
 * 场景规划器：WhiteboardScene[]（每段口播一个场景）+ 实测段时长 →
 * WhiteboardPlan（时间轴元素 + 运镜表 + 笔活跃区间）。
 *
 * 版式：场景铺在大画布网格上（2 列 × N 行，单元格 = 1080×1920 镜头框），
 * 场景内元素竖排流式布局、垂直居中——脚本方只声明语义，不碰坐标。
 *
 * 时序（BR-U4-6 同款纪律）：时长唯一来源是实测 segmentDurations；
 * 每段内元素绘制时长按自然权重缩放进该段预算（画完早于说完，留尾部
 * 呼吸），段间运镜占下一段头部；收尾在末段尾部预留 zoom-out 全览。
 *
 * 纯度：本模块不读文件——image 元素的 data URI 由调用方经
 * imageDataUris 预读注入（cards.frames 的分工先例）。
 */

import { ValidationError } from "@core/errors";

import type { Pt } from "./geometry";
import { arrowHead, ellipsePts } from "./geometry";
import { fadeGroup, fadeRect, imageEl, strokesEl } from "./elements";
import { hanziTextEl, measureHanziText } from "./hanzi";
import {
  LINE_ART,
  STICKER_NAMES,
  iconDrawSec,
  iconPaths,
  stickerSvg,
} from "./library";
import { PEN_EXIT_SEC } from "./pen";
import type {
  CamMove,
  CamPose,
  ChartKind,
  SceneElement,
  TimelineEl,
  WhiteboardPlan,
  WhiteboardScene,
  WhiteboardTheme,
} from "./types";
import { CELL, SCENE_ELEMENTS_MAX, THEMES } from "./types";

/** 单元格安全区. */
const SAFE = { top: 220, bottom: 280, side: 96 } as const;

/** 元素间垂直间距. */
const VGAP = 84;

/** 段间运镜时长（秒，占下一段头部；不超过该段的 18%）. */
const PAN_SEC = 0.7;

/** 系统字体族（非 CJK 回退渲染；与 cards 模板一致）. */
const FONT_FAMILY = "PingFang SC";

export interface PlanOptions {
  theme?: WhiteboardTheme;
  /** image.src → data URI 预读表. */
  imageDataUris?: ReadonlyMap<string, string>;
}

/** 布局盒：一个场景元素在单元格内占用的高度与构建器. */
interface ElementBox {
  h: number;
  /** 自然绘制时长（秒，未缩放）. */
  naturalSec: number;
  /** 是否 sticker（垫底渲染）. */
  background: boolean;
  build(y: number, t0: number, dur: number): TimelineEl[];
}

/** 场景校验（schema 侧 validateScript 也会做；这里防御直调）. */
function assertScene(scene: WhiteboardScene, index: number): void {
  if (scene.elements.length === 0) {
    throw new ValidationError(`场景 ${index} 元素为空（至少 1 个）`);
  }
  if (scene.elements.length > SCENE_ELEMENTS_MAX) {
    throw new ValidationError(
      `场景 ${index} 元素数 ${scene.elements.length} 超上限 ${SCENE_ELEMENTS_MAX}`,
    );
  }
  for (const el of scene.elements) {
    if (el.type === "icon" && LINE_ART[el.name] === undefined) {
      throw new ValidationError(
        `场景 ${index} 引用未知线稿元素 "${el.name}"（可用: ${Object.keys(LINE_ART).join(", ")}）`,
      );
    }
    if (
      el.type === "sticker" &&
      !(STICKER_NAMES as readonly string[]).includes(el.name)
    ) {
      throw new ValidationError(
        `场景 ${index} 引用未知装饰件 "${el.name}"（可用: ${STICKER_NAMES.join(", ")}）`,
      );
    }
  }
}

/** 单行手写的字号自适应（超宽缩小，下限 minSize）. */
function fitSize(
  text: string,
  base: number,
  maxW: number,
  minSize: number,
): number {
  const gap = Math.round(base * 0.08);
  const w = measureHanziText(text, base, gap);
  if (w <= maxW) return base;
  return Math.max(minSize, Math.floor((base * maxW) / w));
}

/** 手写行元素 + 时长（title/text 共用）. */
function textBox(
  text: string,
  baseSize: number,
  minSize: number,
  perCharBase: number,
  cellX: number,
  theme: WhiteboardTheme,
  idp: string,
  underline: boolean,
): ElementBox {
  const maxW = CELL.width - SAFE.side * 2;
  const size = fitSize(text, baseSize, maxW, minSize);
  const gap = Math.round(size * 0.08);
  const w = measureHanziText(text, size, gap);
  const x = cellX + (CELL.width - w) / 2;
  const chars = [...text].length;
  // 含字间停顿（hanziTextEl 每字 +0.12s）——低估会挤占尾部呼吸
  const naturalSec =
    chars * perCharBase +
    Math.max(0, chars - 1) * 0.12 +
    (underline ? 0.35 : 0);
  const h = size * 1.15 + (underline ? 46 : 0);
  return {
    h,
    naturalSec,
    background: false,
    build(y, t0, dur) {
      const writeDur = underline ? dur * 0.82 : dur;
      const els: TimelineEl[] = [
        hanziTextEl(text, {
          x,
          y,
          size,
          gap,
          t0,
          perChar: Math.max(0.14, writeDur / Math.max(1, chars)),
          color: theme.ink,
          fontFamily: FONT_FAMILY,
          idp,
        }),
      ];
      if (underline) {
        const uy = y + size * 1.2;
        els.push(
          strokesEl(
            [
              [
                [x - 14, uy],
                [x + w + 14, uy - 6],
              ],
            ],
            {
              t0: t0 + writeDur + 0.05,
              dur: Math.max(0.2, dur - writeDur - 0.05),
              color: theme.accent,
              width: 11,
              seed: `${idp}ul`,
              amp: 3,
            },
          ),
        );
      }
      return els;
    },
  };
}

/** 图表预设的折线组构建. */
function chartBox(
  kind: ChartKind,
  label: string | undefined,
  cellX: number,
  theme: WhiteboardTheme,
  idp: string,
): ElementBox {
  const w = CELL.width - SAFE.side * 2 - 60;
  const h = 520;
  const labelH = label !== undefined ? 190 : 0;
  return {
    h: h + labelH,
    naturalSec: 2.1 + (label !== undefined ? [...label].length * 0.42 : 0),
    background: false,
    build(y, t0, dur) {
      const x = cellX + (CELL.width - w) / 2;
      const ox = x + 20;
      const oy = y + h - 30; // 原点（左下）
      const els: TimelineEl[] = [];
      const labelSec =
        label !== undefined
          ? (dur * (0.42 * [...label].length)) /
            (2.1 + 0.42 * [...label].length)
          : 0;
      const drawDur = dur - labelSec;
      // 坐标轴
      const axesDur = drawDur * 0.24;
      els.push(
        strokesEl(
          [
            [
              [ox, y + 20],
              [ox, oy],
              [x + w, oy],
            ],
          ],
          {
            t0,
            dur: axesDur,
            color: theme.ink,
            width: 8,
            seed: `${idp}axes`,
          },
        ),
      );
      let t = t0 + axesDur + 0.06;
      const bodyDur = drawDur * 0.72 - 0.12;
      const plotW = w - 60;
      if (kind === "bars-up") {
        const barW = plotW / 5;
        const heights = [0.32, 0.55, 0.82];
        const per = bodyDur / 3;
        heights.forEach((hh, i) => {
          const bx = ox + barW * (0.55 + i * 1.5);
          const bh = (h - 90) * hh;
          els.push(
            strokesEl(
              [
                [
                  [bx, oy],
                  [bx, oy - bh],
                  [bx + barW, oy - bh],
                  [bx + barW, oy],
                ],
              ],
              {
                t0: t,
                dur: per * 0.85,
                color: theme.ink,
                width: 7,
                seed: `${idp}bar${i}`,
              },
            ),
            fadeRect(bx + 4, oy - bh + 4, barW - 8, bh - 6, {
              t0: t + per * 0.5,
              dur: per * 0.5,
              fill: theme.accentSoft,
              maxOpacity: 0.18,
            }),
          );
          t += per;
        });
      } else if (kind === "line-up") {
        const pts: Pt[] = [];
        for (let i = 0; i <= 48; i++) {
          const p = i / 48;
          pts.push([
            ox + 40 + plotW * p,
            oy - 40 - (h - 150) * Math.pow(p, 1.7),
          ]);
        }
        els.push(
          strokesEl([pts, arrowHead(pts, 34)], {
            t0: t,
            dur: bodyDur,
            color: theme.accent,
            width: 10,
            seed: `${idp}line`,
            amp: 1.8,
          }),
        );
      } else {
        // steps：三级台阶
        const stepW = plotW / 3;
        const stepH = (h - 110) / 3;
        const pts: Pt[] = [[ox + 20, oy]];
        for (let i = 0; i < 3; i++) {
          const sx = ox + 20 + stepW * i;
          pts.push(
            [sx, oy - stepH * (i + 1)],
            [sx + stepW, oy - stepH * (i + 1)],
          );
        }
        els.push(
          strokesEl([pts], {
            t0: t,
            dur: bodyDur,
            color: theme.ink,
            width: 8,
            seed: `${idp}steps`,
          }),
        );
      }
      if (label !== undefined) {
        const size = fitSize(label, 130, w - 80, 72);
        const gap = Math.round(size * 0.08);
        const lw = measureHanziText(label, size, gap);
        els.push(
          hanziTextEl(label, {
            x: cellX + (CELL.width - lw) / 2,
            y: y + h + 34,
            size,
            gap,
            t0: t0 + drawDur + 0.08,
            perChar: Math.max(
              0.16,
              (labelSec - 0.08) / Math.max(1, [...label].length),
            ),
            color: theme.ink,
            fontFamily: FONT_FAMILY,
            idp: `${idp}lb`,
          }),
        );
      }
      return els;
    },
  };
}

/** 场景元素 → 布局盒. */
function boxOf(
  el: SceneElement,
  sceneIdx: number,
  elIdx: number,
  cellX: number,
  cellY: number,
  theme: WhiteboardTheme,
  images: ReadonlyMap<string, string>,
): ElementBox {
  const idp = `s${sceneIdx}e${elIdx}`;
  switch (el.type) {
    case "title":
      return textBox(
        el.text,
        176,
        104,
        0.5,
        cellX,
        theme,
        idp,
        el.underline ?? true,
      );
    case "text":
      return textBox(el.text, 96, 62, 0.3, cellX, theme, idp, false);
    case "bullet": {
      const inner = textBox(
        el.text,
        90,
        60,
        0.3,
        cellX + 60,
        theme,
        idp,
        false,
      );
      return {
        h: Math.max(inner.h, 92),
        naturalSec: inner.naturalSec + 0.3,
        background: false,
        build(y, t0, dur) {
          const checkDur = Math.min(0.32, dur * 0.22);
          const cx = cellX + SAFE.side + 44;
          const els = [
            strokesEl(iconPaths("check", cx, y + 48, 78), {
              t0,
              dur: checkDur,
              color: theme.accent,
              width: 12,
              seed: `${idp}ck`,
              amp: 1.4,
            }),
            ...inner.build(y, t0 + checkDur + 0.05, dur - checkDur - 0.05),
          ];
          return els;
        },
      };
    }
    case "icon": {
      const size = 300;
      const label = el.label;
      const labelH = label !== undefined ? 160 : 0;
      return {
        h: size + labelH,
        naturalSec:
          iconDrawSec(el.name) +
          (label !== undefined ? [...label].length * 0.36 : 0),
        background: false,
        build(y, t0, dur) {
          const labelSec =
            label !== undefined
              ? (dur * [...label].length * 0.36) /
                (iconDrawSec(el.name) + [...label].length * 0.36)
              : 0;
          const els: TimelineEl[] = [
            strokesEl(
              iconPaths(el.name, cellX + CELL.width / 2, y + size / 2, size),
              {
                t0,
                dur: dur - labelSec,
                color: el.accent === true ? theme.accent : theme.ink,
                width: 9,
                seed: idp,
                amp: 2.2,
              },
            ),
          ];
          if (label !== undefined) {
            const lsize = fitSize(label, 104, CELL.width - SAFE.side * 2, 64);
            const gap = Math.round(lsize * 0.08);
            const lw = measureHanziText(label, lsize, gap);
            els.push(
              hanziTextEl(label, {
                x: cellX + (CELL.width - lw) / 2,
                y: y + size + 26,
                size: lsize,
                gap,
                t0: t0 + (dur - labelSec) + 0.06,
                perChar: Math.max(
                  0.16,
                  (labelSec - 0.06) / Math.max(1, [...label].length),
                ),
                color: theme.ink,
                fontFamily: FONT_FAMILY,
                idp: `${idp}lb`,
              }),
            );
          }
          return els;
        },
      };
    }
    case "chart":
      return chartBox(el.chart, el.label, cellX, theme, idp);
    case "image": {
      const dataUri = images.get(el.src);
      if (dataUri === undefined) {
        throw new ValidationError(
          `场景 ${sceneIdx} image "${el.src}" 缺少预读 data URI（imageDataUris 未提供）`,
        );
      }
      const w = 560;
      const h = 470;
      const circle = el.circle ?? false;
      const label = el.label;
      const frameH = h + 30 + 96;
      const labelH = label !== undefined ? 170 : 0;
      return {
        h: frameH + (circle ? 70 : 20) + labelH,
        naturalSec:
          0.9 +
          (circle ? 0.7 : 0) +
          (label !== undefined ? [...label].length * 0.36 : 0),
        background: false,
        build(y, t0, dur) {
          const natural =
            0.9 +
            (circle ? 0.7 : 0) +
            (label !== undefined ? [...label].length * 0.36 : 0);
          const slideDur = (dur * 0.9) / natural;
          const cx = cellX + CELL.width / 2;
          const cy = y + frameH / 2 + (circle ? 30 : 0);
          const els: TimelineEl[] = [
            imageEl({
              cx,
              cy,
              w,
              h,
              rotDeg: -4,
              t0,
              dur: slideDur,
              fromDx: 780,
              fromDy: -120,
              dataUri,
              frameFill: "#ffffff",
              frameStroke: "#d6dae0",
              idp,
            }),
          ];
          let t = t0 + slideDur + 0.08;
          if (circle) {
            const circleDur = (dur * 0.7) / natural;
            els.push(
              strokesEl(
                [ellipsePts(cx, cy, w / 2 + 88, frameH / 2 + 62, -78, 385)],
                {
                  t0: t,
                  dur: circleDur,
                  color: theme.accent,
                  width: 10,
                  seed: `${idp}cir`,
                  amp: 2,
                },
              ),
            );
            t += circleDur + 0.06;
          }
          if (label !== undefined) {
            const lsize = fitSize(label, 100, CELL.width - SAFE.side * 2, 62);
            const gap = Math.round(lsize * 0.08);
            const lw = measureHanziText(label, lsize, gap);
            els.push(
              hanziTextEl(label, {
                x: cellX + (CELL.width - lw) / 2,
                y: y + frameH + (circle ? 76 : 30),
                size: lsize,
                gap,
                t0: t,
                perChar: Math.max(
                  0.16,
                  (t0 + dur - t) / Math.max(1, [...label].length),
                ),
                color: theme.ink,
                fontFamily: FONT_FAMILY,
                idp: `${idp}lb`,
              }),
            );
          }
          return els;
        },
      };
    }
    case "sticker":
      return {
        h: 0, // 装饰件不占竖排空间（角落定位）
        naturalSec: 0.45,
        background: true,
        build(_y, t0, dur) {
          return [
            fadeGroup(
              stickerSvg(
                el.name,
                cellX + CELL.width - SAFE.side - 150,
                cellY + SAFE.top + 120,
                300,
                theme.accentSoft,
              ),
              { t0, dur },
            ),
          ];
        },
      };
  }
}

/** 全画布 overview 镜头位（9:16 适配 + 6% 留白）. */
export function overviewPose(canvasW: number, canvasH: number): CamPose {
  const aspectW = Math.max(canvasW, (canvasH * CELL.width) / CELL.height);
  return [canvasW / 2, canvasH / 2, aspectW * 1.06];
}

/**
 * 规划整支白板视频（纯函数）。
 *
 * @param scenes 每段口播一个场景（与 segmentDurations 等长）
 * @param segmentDurations durations.json 实测逐段秒数
 * @throws ValidationError 输入不合法（长度不匹配/元素超限/未知元素名/缺图）
 */
export function planWhiteboard(
  scenes: readonly WhiteboardScene[],
  segmentDurations: readonly number[],
  options: PlanOptions = {},
): WhiteboardPlan {
  if (scenes.length === 0) {
    throw new ValidationError("场景列表为空");
  }
  if (scenes.length !== segmentDurations.length) {
    throw new ValidationError(
      `场景数 ${scenes.length} ≠ 段时长数 ${segmentDurations.length}（须来自 durations.json 实测）`,
    );
  }
  for (const [i, d] of segmentDurations.entries()) {
    if (!Number.isFinite(d) || d <= 0) {
      throw new ValidationError(`segmentDurations[${i}] 非法: ${d}`);
    }
  }
  scenes.forEach(assertScene);

  const theme = options.theme ?? THEMES["clean"]!;
  const images = options.imageDataUris ?? new Map<string, string>();

  const cols = scenes.length > 1 ? 2 : 1;
  const rows = Math.ceil(scenes.length / cols);
  const canvasW = cols * CELL.width;
  const canvasH = rows * CELL.height;

  const els: TimelineEl[] = [];
  const camMoves: CamMove[] = [];
  const poses: CamPose[] = scenes.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return [
      col * CELL.width + CELL.width / 2,
      row * CELL.height + CELL.height / 2,
      CELL.width,
    ] as const;
  });

  let t = 0;
  let lastDrawEnd = 0;
  for (const [i, scene] of scenes.entries()) {
    const duration = segmentDurations[i]!;
    const segEnd = t + duration;
    const cellX = (i % cols) * CELL.width;
    const cellY = Math.floor(i / cols) * CELL.height;

    // 段间运镜（占本段头部；首段无）
    let drawStart = t;
    if (i > 0) {
      const pan = Math.min(PAN_SEC, duration * 0.18);
      camMoves.push({ t0: t, t1: t + pan, from: poses[i - 1]!, to: poses[i]! });
      drawStart = t + pan + 0.05;
    }

    // 末段预留 overview 时间
    let tail = Math.max(0.35, duration * 0.1);
    if (i === scenes.length - 1 && scenes.length > 1) {
      tail += overviewSec(duration) + PEN_EXIT_SEC;
    }
    const budget = Math.max(0.6, segEnd - drawStart - tail);

    // 布局 + 时长分配
    const boxes = scene.elements.map((el, k) =>
      boxOf(el, i, k, cellX, cellY, theme, images),
    );
    const flow = boxes.filter((b) => !b.background);
    const totalH =
      flow.reduce((a, b) => a + b.h, 0) + VGAP * Math.max(0, flow.length - 1);
    const availH = CELL.height - SAFE.top - SAFE.bottom;
    const scaleH = totalH > availH ? availH / totalH : 1;
    let y = cellY + SAFE.top + Math.max(0, (availH - totalH * scaleH) / 2);

    const naturalSum = boxes.reduce((a, b) => a + b.naturalSec, 0);
    const gapSec = 0.12;
    const gaps = gapSec * Math.max(0, boxes.length - 1);
    // 时长缩放：内容多则加速（下限 0.4 保观感），时间富余不放慢（余量归尾部呼吸）
    const timeScale = Math.max(0.4, Math.min(1, (budget - gaps) / naturalSum));
    // 场景包围盒（含入场滑入余量）：帧渲染的视口剔除依据
    const sceneBBox = [
      cellX - 200,
      cellY - 200,
      cellX + CELL.width + 900, // image 从右侧 +780 滑入
      cellY + CELL.height + 200,
    ] as const;
    let et = drawStart;
    for (const box of boxes) {
      const dur = Math.max(0.2, box.naturalSec * timeScale);
      const built = box.build(y, et, dur);
      for (const el of built) el.bbox = sceneBBox;
      // sticker 垫底：background 元素插到最前
      if (box.background) els.unshift(...built);
      else els.push(...built);
      if (!box.background) y += box.h * scaleH + VGAP * scaleH;
      // 单笔不变式：按元素的**真实**结束时间推进（手写元素含字间停顿，
      // 实际时长会超过名义 dur；按名义推进会造成两处同时在写）
      const builtEnd = built.reduce((m, e) => Math.max(m, e.t1), et + dur);
      et = builtEnd + gapSec;
    }
    lastDrawEnd = Math.max(lastDrawEnd, et - gapSec);
    t = segEnd;
  }

  const totalSec = segmentDurations.reduce((a, b) => a + b, 0);

  // 收尾 overview（多场景才有意义）
  let penExitAt = lastDrawEnd + PEN_EXIT_SEC;
  if (scenes.length > 1) {
    const zoomDur = overviewSec(segmentDurations[segmentDurations.length - 1]!);
    const zoomStart = Math.min(penExitAt + 0.2, totalSec - zoomDur);
    camMoves.push({
      t0: zoomStart,
      t1: zoomStart + zoomDur,
      from: poses[poses.length - 1]!,
      to: overviewPose(canvasW, canvasH),
    });
  }

  // 笔活跃区间（音效混音输入）
  const penActive = els
    .filter((e) => e.pen !== undefined)
    .map((e) => ({ t0: e.t0, t1: e.t1 }))
    .sort((a, b) => a.t0 - b.t0);

  return {
    theme,
    canvasW,
    canvasH,
    els,
    camMoves,
    penExitAt,
    penActive,
    totalSec,
  };
}

/** 末段 overview zoom 时长. */
function overviewSec(lastSegSec: number): number {
  return Math.min(2.4, Math.max(1.2, lastSegSec * 0.18));
}
