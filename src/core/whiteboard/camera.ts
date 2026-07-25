/**
 * @module @core/whiteboard (camera)
 *
 * 镜头模型（质感维度 D：运镜与节奏）：
 * - 平移用 easeInOutQuint（中段快、起停稳，比 cubic 少"漂"感）；
 * - 驻留期做 Ken Burns 微漂移：每个场景驻留时视野缓慢缩小 1.5%，
 *   画面不再死板静止；
 * - 收尾 zoom-out 用更长的 quint 缓出。
 *
 * 纯函数：CamMove 表 + t → CamPose。
 */

import { clamp01, easeInOutQuint, lerp } from "./geometry";
import type { CamMove, CamPose } from "./types";

/** 驻留微漂移的视野收缩比例（1.5%）. */
const DRIFT_ZOOM = 0.015;

function interpolate(m: CamMove, t: number): CamPose {
  const p = easeInOutQuint(clamp01((t - m.t0) / (m.t1 - m.t0)));
  return [
    lerp(m.from[0], m.to[0], p),
    lerp(m.from[1], m.to[1], p),
    lerp(m.from[2], m.to[2], p),
  ];
}

/**
 * 时刻 t 的镜头位。moves 必须按 t0 升序且不重叠（scene.ts 保证）。
 * 驻留段（两次移动之间）施加缓慢的微缩放漂移。
 */
export function cameraAt(t: number, moves: readonly CamMove[]): CamPose {
  if (moves.length === 0) return [540, 960, 1080];
  if (t <= moves[0]!.t0) {
    return driftPose(moves[0]!.from, t - 0, moves[0]!.t0 - 0);
  }
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    if (t >= m.t0 && t <= m.t1) return interpolate(m, t);
    const next = moves[i + 1];
    if (t > m.t1 && (next === undefined || t < next.t0)) {
      const holdEnd = next?.t0 ?? m.t1 + 3600;
      return driftPose(m.to, t - m.t1, holdEnd - m.t1);
    }
  }
  return moves[moves.length - 1]!.to;
}

/** 驻留微漂移：驻留时长内视野从 1.0 缓慢收到 1-DRIFT_ZOOM. */
function driftPose(base: CamPose, held: number, holdDur: number): CamPose {
  if (holdDur <= 0.01) return base;
  const p = clamp01(held / holdDur);
  const zoom = 1 - DRIFT_ZOOM * easeInOutQuint(p);
  return [base[0], base[1], base[2] * zoom];
}
