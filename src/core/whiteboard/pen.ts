/**
 * @module @core/whiteboard (pen)
 *
 * 笔贴图与笔运动（质感维度 A）：
 * - 贴图：Apple Pencil 风格矢量笔——渐变笔身、金属箍、深色笔尖锥、
 *   随"提笔"高度缩放的软阴影；
 * - 书写微摆：倾角在书写时叠加 ±1.8° 平滑噪声摆动（真人手不僵直）；
 * - 移动：元素间提笔走弧线（高度随距离），入场自首元素起点，退场
 *   向右下滑出画面。
 *
 * 纯函数：位置/姿态全部由 t 与元素表决定；噪声 seed 固定。
 */

import type { Pt } from "./geometry";
import {
  clamp01,
  easeInOutCubic,
  fmt,
  hashSeed,
  lerp,
  valueNoise1D,
} from "./geometry";
import type { TimelineEl } from "./types";

/** 笔退场动画时长（秒）. */
export const PEN_EXIT_SEC = 0.55;

/** 笔入场动画时长（秒）. */
export const PEN_ENTER_SEC = 0.5;

/**
 * 空档超过这个长度就"出画等"，而不是"在板上挪过去"。
 *
 * 短空档（同一段里换行、写完标题去写正文）手不该离开板面——它就是抬笔挪
 * 一下。长空档（一段讲完、旁白还在说、下一段要过好几秒才开始）如果让手
 * 留在画面上，它会缓慢飘到下一笔的起点然后**悬在那里不动**，观众盯着一只
 * 僵住的手看好几秒。真人这时候是把手收回去的。
 */
export const LONG_GAP_SEC = 0.9;

/** 出画位移（px）：够把整条手臂推出 1080×1920 / 1920×1080 两种画幅. */
const OFF_DX = 900;
const OFF_DY = 1050;

/** 书写倾角摆动的平滑噪声（固定 seed，逐帧稳定）. */
const tiltNoise = valueNoise1D(hashSeed("wb-pen-tilt"));

/** 笔姿态：位置 + 提笔高度(0=纸面,1=最高) + 倾角. */
export interface PenPose {
  x: number;
  y: number;
  lift: number;
  tiltDeg: number;
}

/**
 * 取元素在某个端点的笔位；端点恰好取空时向区间内侧微退一点再取。
 *
 * 元素契约上应当在自身 `[t0,t1]` 端点给出坐标，但时间轴被平移/缩放后，
 * 端点值在浮点下常常落在元素判定的区间外一丝。为这点误差让整条渲染崩掉
 * 不值得——退 1ms 取到的点在视觉上没有区别。
 */
function penAt(el: TimelineEl, t: number): Pt | null {
  const hit = el.pen!(t);
  if (hit !== null) return hit;
  const inward =
    t >= el.t1 ? Math.max(el.t0, t - 1e-3) : Math.min(el.t1, t + 1e-3);
  return el.pen!(inward);
}

/**
 * 时刻 t 的笔姿态；null = 笔不可见（已退场）。
 * penEls 必须按 t0 升序（scene.ts 保证）。
 */
export function penPoseAt(
  t: number,
  penEls: readonly TimelineEl[],
  baseTiltDeg: number,
): PenPose | null {
  if (penEls.length === 0) return null;
  const wobbleDeg = tiltNoise(t * 1.7) * 1.8;

  const first = penEls[0]!;
  if (t <= first.t0) {
    const p = penAt(first, first.t0);
    if (p === null) return null;
    // 开片：手从画外滑进来，不是一开始就悬在第一笔上等着
    const k =
      1 -
      easeInOutCubic(clamp01((t - (first.t0 - PEN_ENTER_SEC)) / PEN_ENTER_SEC));
    if (k >= 1) return null;
    return {
      x: p[0] + OFF_DX * k,
      y: p[1] + OFF_DY * k,
      lift: 0.35 + k * 0.65,
      tiltDeg: baseTiltDeg + k * 10,
    };
  }
  // 多个元素同时活跃时跟**最新**那个（而不是第一个命中的）。
  //
  // 理想情况下笔描元素首尾相接不重叠，但排版组件一旦把某段时长估短，
  // 两个元素就会重叠；此时"跟第一个"会把笔钉在上一段的末尾，而下一段的
  // 笔迹已经在长出来——画面上就是"字先出现了，笔还没移动"。笔应该在
  // 最后开始的那一笔上：那才是此刻正在写的东西。
  let active: TimelineEl | undefined;
  for (const e of penEls) {
    if (t >= e.t0 && t <= e.t1 && e.pen!(t) !== null) active = e;
  }
  if (active !== undefined) {
    const p = active.pen!(t)!;
    return {
      x: p[0],
      y: p[1],
      lift: 0,
      tiltDeg: baseTiltDeg + wobbleDeg,
    };
  }
  // 间隙：上一元素终点 → 下一元素起点，提笔走弧线
  let prev: TimelineEl | undefined;
  let next: TimelineEl | undefined;
  for (const e of penEls) {
    if (e.t1 < t) prev = e;
    if (next === undefined && e.t0 > t) next = e;
  }
  if (prev !== undefined && next !== undefined) {
    const a = penAt(prev, prev.t1);
    const b = penAt(next, next.t0);
    if (a === null || b === null) return null;
    const gap = next.t0 - prev.t1;

    if (gap > LONG_GAP_SEC) {
      // 长空档：出画 → 画外等 → 再入画（见 LONG_GAP_SEC 的注释）
      const exitDur = Math.min(PEN_EXIT_SEC, gap * 0.3);
      const enterDur = Math.min(PEN_ENTER_SEC, gap * 0.3);
      if (t < prev.t1 + exitDur) {
        const e = easeInOutCubic(clamp01((t - prev.t1) / exitDur));
        return {
          x: a[0] + OFF_DX * e,
          y: a[1] + OFF_DY * e,
          lift: e,
          tiltDeg: baseTiltDeg + e * 10,
        };
      }
      if (t > next.t0 - enterDur) {
        const k =
          1 - easeInOutCubic(clamp01((t - (next.t0 - enterDur)) / enterDur));
        return {
          x: b[0] + OFF_DX * k,
          y: b[1] + OFF_DY * k,
          lift: k,
          tiltDeg: baseTiltDeg + k * 10,
        };
      }
      // 手不在画面上
      return null;
    }

    // 短空档：抬笔在板面上方挪过去
    const p = easeInOutCubic(clamp01((t - prev.t1) / gap));
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const liftPeak = clamp01(dist / 900) * 0.85 + 0.15;
    const lift = Math.sin(Math.PI * p) * liftPeak;
    return {
      x: lerp(a[0], b[0], p),
      y: lerp(a[1], b[1], p) - lift * 90,
      lift,
      tiltDeg: baseTiltDeg + wobbleDeg * 0.4,
    };
  }
  if (prev !== undefined) {
    // 退场：向右下滑出画面
    const a = penAt(prev, prev.t1);
    if (a === null) return null;
    const p = clamp01((t - prev.t1) / PEN_EXIT_SEC);
    if (p >= 1) return null;
    const e = easeInOutCubic(p);
    return {
      x: a[0] + OFF_DX * e,
      y: a[1] + OFF_DY * e,
      lift: e,
      tiltDeg: baseTiltDeg + e * 10,
    };
  }
  return null;
}

/** 笔贴图渐变 defs（每帧 defs 里包含一次）. */
export function penDefs(): string {
  return [
    `<linearGradient id="wbPenBody" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="#ffffff"/>`,
    `<stop offset="0.45" stop-color="#f4f5f7"/>`,
    `<stop offset="1" stop-color="#dfe2e7"/>`,
    `</linearGradient>`,
    `<linearGradient id="wbPenFerrule" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="#d8dce2"/>`,
    `<stop offset="0.5" stop-color="#aab1bb"/>`,
    `<stop offset="1" stop-color="#8f96a1"/>`,
    `</linearGradient>`,
  ].join("");
}

/**
 * 笔贴图 SVG：笔尖锚定 (pose.x, pose.y)。阴影随 lift 拉远变淡，
 * 笔体随 lift 轻微上移（纸面透视暗示）。
 */
export function penSvg(pose: PenPose): string {
  const shadowDx = 14 + pose.lift * 26;
  const shadowDy = 10 + pose.lift * 34;
  const shadowOp = 0.1 * (1 - pose.lift * 0.65);
  const shadowR = 26 + pose.lift * 18;
  return [
    `<g transform="translate(${fmt(pose.x)},${fmt(pose.y)})">`,
    `<ellipse cx="${fmt(shadowDx)}" cy="${fmt(shadowDy)}" rx="${fmt(shadowR)}" ry="${fmt(shadowR * 0.36)}" fill="#0f172a" opacity="${fmt(Math.max(0.02, shadowOp))}"/>`,
    `<g transform="rotate(${fmt(pose.tiltDeg)})">`,
    // 笔尖锥（两段：外锥浅、尖端深）
    `<path d="M 0 0 L -11.5 -32 L 11.5 -32 Z" fill="#4a5160"/>`,
    `<path d="M 0 0 L -4.5 -13.5 L 4.5 -13.5 Z" fill="#15181d"/>`,
    // 金属箍
    `<rect x="-12.5" y="-44" width="25" height="13" fill="url(#wbPenFerrule)"/>`,
    // 笔身（渐变 + 细描边）
    `<rect x="-12.5" y="-208" width="25" height="166" rx="12" fill="url(#wbPenBody)" stroke="#c2c8d1" stroke-width="2"/>`,
    // 笔身高光
    `<rect x="-7.5" y="-198" width="4" height="146" rx="2" fill="#ffffff" opacity="0.8"/>`,
    // 尾帽
    `<rect x="-12.5" y="-216" width="25" height="12" rx="6" fill="#e3e6ea" stroke="#c2c8d1" stroke-width="1.5"/>`,
    `</g>`,
    `</g>`,
  ].join("");
}
