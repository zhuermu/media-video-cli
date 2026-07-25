/**
 * PoC: 白板马克笔贴图
 *
 * 现状问题：`pen.ts` 画的是 Apple Pencil（25px 细笔身、金属箍、尖锥），
 * 与"白板"的语境不符——白板上用的是短粗的水性马克笔。
 *
 * 变更：筒身加粗变短、楔形笔头（chisel tip）、笔夹、标签环、盖顶；
 * 笔尖仍锚定 (pose.x, pose.y)，姿态由 `pen.ts` 的 penPoseAt 提供（不改
 * 运动学，只换贴图）。
 */

import { fmt } from "../whiteboard/index";
import type { PenPose } from "../whiteboard/index";

export interface MarkerPenStyle {
  /** 笔身主色（= 墨色系，观众会把笔色和笔迹色联系起来）. */
  body: string;
  bodyLight: string;
  bodyDark: string;
  /** 标签环颜色（笔身上的品牌色环）. */
  band: string;
  /** 笔头颜色（吸墨的毛毡头，比笔迹略深）. */
  nib: string;
}

export function markerPenStyle(ink: string, accent: string): MarkerPenStyle {
  return {
    body: "#33383d",
    bodyLight: "#697178",
    bodyDark: "#1c2024",
    band: accent,
    nib: ink,
  };
}

/** 笔身渐变 defs（id 固定，每帧一份）. */
export function markerPenDefs(s: MarkerPenStyle): string {
  return [
    `<linearGradient id="pocMkBody" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="${s.bodyDark}"/>`,
    `<stop offset="26%" stop-color="${s.bodyLight}"/>`,
    `<stop offset="52%" stop-color="${s.body}"/>`,
    `<stop offset="100%" stop-color="${s.bodyDark}"/>`,
    `</linearGradient>`,
    `<linearGradient id="pocMkCollar" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#9aa2a9"/>`,
    `<stop offset="40%" stop-color="#e6eaed"/>`,
    `<stop offset="100%" stop-color="#7c848b"/>`,
    `</linearGradient>`,
  ].join("");
}

/**
 * 马克笔贴图：笔尖（楔形头的着纸点）锚定 (pose.x, pose.y)。
 * 阴影随 lift 拉远变淡（同 pen.ts 的纸面透视暗示）。
 */
export function markerPenSvg(pose: PenPose, s: MarkerPenStyle): string {
  // 影子沿**笔身轴向**拉长并落在筒身下方（早先版本是笔尖旁的圆团，
  // 读起来像板面上的一块污渍，而不是笔的投影）
  // 影子要"能感觉到、看不见"：早先版本 rx/ry 随 lift 放大 1.5 倍、
  // 加上 0.14 的不透明度，提笔时在板面上留下一块显眼的灰斑。
  const shadowOp = 0.085 * (1 - pose.lift * 0.7);
  const shadowSpread = 1 + pose.lift * 0.22;
  const shadowOff = 20 + pose.lift * 26;
  return [
    `<g transform="translate(${fmt(pose.x)},${fmt(pose.y)})">`,
    `<g transform="rotate(${fmt(pose.tiltDeg)})">`,
    `<ellipse cx="${fmt(shadowOff)}" cy="-126" rx="${fmt(22 * shadowSpread)}" ry="${fmt(78 * shadowSpread)}" fill="#0f172a" opacity="${fmt(Math.max(0.015, shadowOp))}"/>`,
    // 楔形笔头（着纸点在原点，斜切面朝行笔方向）
    `<path d="M -3 1 L 9 -3 L 15 -30 L -15 -30 Z" fill="${s.nib}"/>`,
    // 笔头根部的塑料座
    `<path d="M -17 -30 L 17 -30 L 21 -46 L -21 -46 Z" fill="#4b5259"/>`,
    // 金属/塑料箍
    `<rect x="-23" y="-58" width="46" height="14" rx="3" fill="url(#pocMkCollar)"/>`,
    // 筒身（粗、短）
    `<rect x="-24" y="-236" width="48" height="180" rx="10" fill="url(#pocMkBody)"/>`,
    // 品牌色环
    `<rect x="-24" y="-150" width="48" height="19" fill="${s.band}" opacity="0.92"/>`,
    // 筒身高光条
    `<rect x="-15" y="-228" width="6" height="164" rx="3" fill="#ffffff" opacity="0.28"/>`,
    // 笔夹
    `<path d="M 20 -226 L 30 -222 L 30 -170 L 20 -178 Z" fill="${s.bodyLight}" opacity="0.95"/>`,
    // 盖顶
    `<rect x="-24" y="-248" width="48" height="14" rx="6" fill="${s.body}"/>`,
    `</g>`,
    `</g>`,
  ].join("");
}

/** 笔尖接触点的落笔高光（笔在板上时，笔尖周围一小圈反光）. */
export function markerNibGlowSvg(pose: PenPose): string {
  if (pose.lift > 0.05) return "";
  return `<ellipse cx="${fmt(pose.x)}" cy="${fmt(pose.y + 3)}" rx="13" ry="6" fill="#ffffff" opacity="0.5"/>`;
}
