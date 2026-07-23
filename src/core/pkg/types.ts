/**
 * @module @core/pkg (types)
 *
 * Publish-package types: locked contracts (component-methods.md 核心类型
 * 定义 — MetadataFiles / PackageDir / ContractReport), the Manifest v1
 * schema entity (domain-entities.md, full JSON shape locked at review),
 * and the UploadChecklist structured value object (Q2=A, 9 fixed items).
 */

import type { ContractViolation } from "@core/errors";

// ---- Locked type contracts (component-methods.md) ----

/** LLM-authored metadata files produced by skills (assemble input). */
export interface MetadataFiles {
  /** metadata-shipinhao.md path. */
  shipinhao: string;
  /** metadata-douyin.md path. */
  douyin: string;
  /** aigc-declaration.md path. */
  aigcDeclaration: string;
  /** materials-manifest.md path. */
  materialsManifest: string;
  /** publish-advice.md path. */
  publishAdvice: string;
  /** Optional custom cover image (default: first card render, Q1=A). */
  cover?: string;
}

/** Assembled package locator (locked fields). */
export interface PackageDir {
  path: string;
  manifestPath: string;
  summaryPath: string;
}

/** Contract validation result: itemized violations (FR-4.2). */
export interface ContractReport {
  valid: boolean;
  violations: ContractViolation[];
}

// ---- Manifest v1 (domain-entities.md schema entity, FR-4.2) ----

/** Per-platform metadata block, redundantly filled from md frontmatter. */
export interface PlatformMetadataEntry {
  /** Package-relative md file name. */
  path: string;
  /** Exactly 3 candidate titles (BR-U5-12). */
  titles: string[];
  /** At least 1 tag. */
  tags: string[];
  /** Non-empty description. */
  description: string;
}

/** manifest.json v1 — the machine gate's single input (FR-4.2). */
export interface ManifestV1 {
  schema_version: "1";
  /** ISO 8601 assembly timestamp. */
  generated_at: string;
  /** probe-measured video facts (never claimed values). */
  video: { path: string; durationSec: number; width: number; height: number };
  cover: { path: string };
  platform_metadata: {
    shipinhao: PlatformMetadataEntry;
    douyin: PlatformMetadataEntry;
  };
  /** must_declare is the layer-3 constant assertion (C11 红线机器化). */
  aigc_declaration: { path: string; must_declare: true };
  materials_manifest: { path: string; entryCount: number };
  publish_advice: { path: string };
}

// ---- UploadChecklist (SUMMARY.md 检查单, Q2=A structured value object) ----

/** The 9 fixed checklist item ids (domain-entities.md, order canonical). */
export type ChecklistItemId =
  | "video-plays"
  | "av-sync"
  | "subtitle-readable"
  | "cover-ok"
  | "title-pick"
  | "tags-check"
  | "aigc-declare"
  | "materials-review"
  | "publish-time";

/** One human-checkable item; `prominent` renders top + bold (BR-U5-6). */
export interface ChecklistItem {
  id: ChecklistItemId;
  /** Human-readable label. */
  label: string;
  /** aigc-declare is always true (置顶+加粗渲染, C11). */
  prominent: boolean;
}

/** SUMMARY.md checklist value object (rendered by the pure renderSummary). */
export interface UploadChecklist {
  /** Package directory — interpolated into the register command footer. */
  packageRef: string;
  /** Fixed 9 items (Q2=A), canonical order. */
  items: ChecklistItem[];
}

// ---- Canonical package file names (八件套 + manifest, FR-4.1) ----

/** Package-relative canonical file names (the FR-4.1 eight-piece set). */
export const PKG_FILES = {
  video: "video.mp4",
  cover: "cover.jpg",
  shipinhao: "metadata-shipinhao.md",
  douyin: "metadata-douyin.md",
  aigcDeclaration: "aigc-declaration.md",
  materialsManifest: "materials-manifest.md",
  publishAdvice: "publish-advice.md",
  manifest: "manifest.json",
  summary: "SUMMARY.md",
} as const;

/** Minimum width for a user-specified cover image (BR-U5-5, Q1=A). */
export const COVER_MIN_WIDTH = 720;
