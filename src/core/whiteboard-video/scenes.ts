/**
 * @module core/whiteboard-video/scenes
 *
 * 设计稿 2.0 §10「场景化组件」：人物讲解 / 小组讨论 / 演示场景 / 思考状态 /
 * 完成·成功。
 *
 * ## 这一层是"组合"，不是"新画"
 *
 * 五个场景没有一笔是新形状——全部由已有的图标（`library.ts`）、容器与气泡
 * （`shapes.ts`）拼出来。所以本模块只做**摆放**：谁多大、谁在谁左边、气泡指向
 * 谁。这样做的好处是场景自动继承了元素库的一切（同一套笔法、同一套配色、
 * 换字体不受影响），代价是场景的表现力被元素库的上限框住——这个代价是对的，
 * 因为场景多画一笔"专属"的形状，就多一处需要独立维护的视觉。
 *
 * ## 为什么值得单独一层
 *
 * "一个人站在板前讲"这件事在讲解视频里会出现几十次。每次都由调用方现拼
 * "人物图标 + 一个框 + 三条线"，等于把同一个构图决策做几十遍，而且每次比例
 * 都略有不同——观众会觉得画面"不稳"。固定成组件之后，同一个语义永远是同一个
 * 构图。
 */

import type { Pt } from "../whiteboard/index";
import { iconPaths } from "../whiteboard/index";
import { PALETTE } from "./palette";
import type { InkRole } from "./palette";
import {
  rectPath,
  speechBoxPath,
  starPath,
  thoughtBubblePaths,
} from "./shapes";
import { radiatingPaths } from "./emphasis";

/** 设计稿 2.0 §10 的五个场景. */
export const SCENE_NAMES = [
  "lecture",
  "discussion",
  "presentation",
  "thinking",
  "success",
] as const;

export type SceneName = (typeof SCENE_NAMES)[number];

export function isSceneName(v: string): v is SceneName {
  return (SCENE_NAMES as readonly string[]).includes(v);
}

/** 场景的绘制材料：按描画顺序分组，每组可单独上色. */
export interface ScenePart {
  paths: Pt[][];
  /** 该组的语义色角色. */
  role: InkRole;
}

export interface SceneDrawing {
  parts: ScenePart[];
}

/** 场景摆放的画布矩形. */
export interface SceneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 人物讲解（§10「人物讲解」）：人在左，板在右，板上三条内容线。
 *
 * 人物占画面高度的 ~62% 而不是更大：这个场景的主体是**板上的内容**，人只是
 * 交代"有人在讲"。人画大了，观众会去看人。
 */
export function lectureScene(b: SceneBox): SceneDrawing {
  const personH = b.h * 0.62;
  const personW = personH * 0.7;
  const px = b.x;
  const py = b.y + b.h - personH;
  const boardX = b.x + personW * 0.92;
  const boardW = b.w - (boardX - b.x);
  const boardH = b.h * 0.68;
  const lines: Pt[][] = [];
  for (let i = 0; i < 3; i++) {
    const ly = b.y + boardH * (0.3 + i * 0.2);
    lines.push([
      [boardX + boardW * 0.12, ly],
      [boardX + boardW * (i === 2 ? 0.62 : 0.86), ly],
    ]);
  }
  return {
    parts: [
      { paths: [rectPath(boardX, b.y, boardW, boardH)], role: "ink" },
      { paths: lines, role: "muted" },
      {
        paths: iconPaths(
          "person-speaker",
          px + personW / 2,
          py + personH / 2,
          personH,
        ),
        role: "ink",
      },
    ],
  };
}

/**
 * 小组讨论（§10「小组讨论」）：三个人 + 两个对话框。
 *
 * 对话框只给两个人而不是三个：三个人同时"说话"读起来是吵架；两个气泡加一个
 * 沉默的人，读起来才是"在讨论"（有人说、有人听）。
 */
export function discussionScene(b: SceneBox): SceneDrawing {
  const personH = b.h * 0.5;
  const slot = b.w / 3;
  const people: Pt[][] = [];
  const bubbles: Pt[][] = [];
  const kinds = ["user", "person-female", "user"] as const;
  for (let i = 0; i < 3; i++) {
    const cx = b.x + slot * (i + 0.5);
    const cy = b.y + b.h - personH / 2;
    people.push(...iconPaths(kinds[i]!, cx, cy, personH));
    if (i !== 1) {
      const bw = slot * 0.78;
      const bh = b.h * 0.3;
      bubbles.push(speechBoxPath(cx - bw / 2, b.y + b.h * 0.04, bw, bh));
    }
  }
  return {
    parts: [
      { paths: bubbles, role: "primary" },
      { paths: people, role: "ink" },
    ],
  };
}

/**
 * 演示场景（§10「演示场景」）：屏幕（内含一条上升折线）+ 站在旁边的人。
 *
 * 屏幕里画**折线图**而不是几条文字线：这个场景与「人物讲解」的区别就在于
 * "在展示数据"。若屏幕里也是三条线，两个场景就看不出分别了。
 */
export function presentationScene(b: SceneBox): SceneDrawing {
  const screenW = b.w * 0.68;
  const screenH = b.h * 0.62;
  const sx = b.x;
  const sy = b.y;
  // 屏幕内的上升折线（留出内边距）
  const padX = screenW * 0.14;
  const padY = screenH * 0.18;
  const pts: Pt[] = [0.1, 0.42, 0.3, 0.66, 0.55, 0.9].map((v, i, arr) => [
    sx + padX + ((screenW - padX * 2) * i) / (arr.length - 1),
    sy + screenH - padY - (screenH - padY * 2) * v,
  ]);
  const personH = b.h * 0.56;
  return {
    parts: [
      { paths: [rectPath(sx, sy, screenW, screenH)], role: "ink" },
      // 支架
      {
        paths: [
          [
            [sx + screenW / 2, sy + screenH],
            [sx + screenW / 2, sy + screenH + b.h * 0.1],
          ],
          [
            [sx + screenW * 0.32, sy + screenH + b.h * 0.1],
            [sx + screenW * 0.68, sy + screenH + b.h * 0.1],
          ],
        ],
        role: "ink",
      },
      { paths: [pts], role: "primary" },
      {
        paths: iconPaths(
          "person-speaker",
          b.x + b.w - personH * 0.35,
          b.y + b.h - personH / 2,
          personH,
        ),
        role: "ink",
      },
    ],
  };
}

/**
 * 思考状态（§10「思考状态」）：人 + 思维气泡 + 气泡里的灯泡。
 *
 * 气泡在人的**右上方**：中文与英文都是从左往右读，"人 → 想法"的顺序才符合
 * 阅读方向；气泡放左边会先看到结论再看到谁在想。
 */
export function thinkingScene(b: SceneBox): SceneDrawing {
  const personH = b.h * 0.58;
  const px = b.x + personH * 0.35;
  const py = b.y + b.h - personH / 2;
  const bubbleW = b.w * 0.52;
  const bubbleH = b.h * 0.52;
  const bx = b.x + b.w - bubbleW;
  const by = b.y;
  // 气泡主体（云朵占上 74%，与 thoughtBubblePaths 的比例一致）
  const bubble = thoughtBubblePaths(bx, by, bubbleW, bubbleH);
  const bulbSize = Math.min(bubbleW, bubbleH * 0.74) * 0.5;
  return {
    parts: [
      { paths: bubble, role: "ink" },
      {
        paths: iconPaths(
          "lightbulb",
          bx + bubbleW / 2,
          by + bubbleH * 0.36,
          bulbSize,
        ),
        role: "warn",
      },
      { paths: iconPaths("user", px, py, personH), role: "ink" },
    ],
  };
}

/**
 * 完成 / 成功（§10「完成/成功」）：人举着奖杯 + 放射线 + 星星。
 *
 * 放射线打在**奖杯**上而不是人身上：被庆祝的是成果。星星只放两颗（设计稿里
 * 也是零星几颗）——多了会变成"烟花特效"，冲淡"完成了一件事"的克制感。
 */
export function successScene(b: SceneBox): SceneDrawing {
  const personH = b.h * 0.62;
  const px = b.x + personH * 0.36;
  const py = b.y + b.h - personH / 2;
  const cupSize = b.h * 0.42;
  const cupCx = b.x + b.w - cupSize * 0.75;
  // 奖杯下移到 0.7 倍杯高处：放射线是绕着杯子画的，杯子太靠上会让光晕顶出画框，
  // 而场景组件一旦画到自己的矩形之外，上游版式就没法再为它留位（相邻内容会被压）
  const cupCy = b.y + cupSize * 0.7;
  const halo = cupSize * 0.8;
  return {
    parts: [
      {
        paths: radiatingPaths(cupCx, cupCy, cupSize * 0.58, halo, 8, 12),
        role: "warn",
      },
      { paths: iconPaths("trophy", cupCx, cupCy, cupSize), role: "warn" },
      {
        paths: [
          starPath(b.x + b.w * 0.52, b.y + b.h * 0.12, b.h * 0.06),
          starPath(b.x + b.w * 0.92, b.y + b.h * 0.52, b.h * 0.045),
        ],
        role: "warn",
      },
      { paths: iconPaths("person-speaker", px, py, personH), role: "ink" },
    ],
  };
}

/** 按名字取场景（未知名回退「人物讲解」——它是最通用的一个）. */
export function scene(name: SceneName, b: SceneBox): SceneDrawing {
  switch (name) {
    case "discussion":
      return discussionScene(b);
    case "presentation":
      return presentationScene(b);
    case "thinking":
      return thinkingScene(b);
    case "success":
      return successScene(b);
    case "lecture":
      return lectureScene(b);
  }
}

/** 场景中文名（对照表/文档用）. */
export const SCENE_LABELS: Readonly<Record<SceneName, string>> = {
  lecture: "人物讲解",
  discussion: "小组讨论",
  presentation: "演示场景",
  thinking: "思考状态",
  success: "完成/成功",
};

/** 把一组 ScenePart 的角色解析成颜色（调用方少写一层查表）. */
export function partColor(part: ScenePart): string {
  return PALETTE[part.role];
}
