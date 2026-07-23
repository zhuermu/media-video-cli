/**
 * @module @core/script (types)
 *
 * Locked script types (component-methods.md 核心类型定义: Script / Segment /
 * DurationEstimate) plus the U3 schema-constraint table, speech-rate
 * defaults, and the domain-guard table shape (domain-entities.md).
 *
 * Boundary rules honored here:
 * - Schema constraint table is the single source for validateScript
 *   assertions (title ≤60, topic ≤500, segments 3-20, text ≤300/段,
 *   cardText ≤80, emphasis ⊂ cardText — BR-U3-10).
 * - BR-U3-8: charsPerSec is configurable (default 4.5), pause 0.3s; the
 *   estimate is preview-only — U4 card timing MUST come from U2's
 *   ffprobe-measured durations.json.
 */

/** Script root (locked fields, FR-1.3 的结构化落地). */
export interface Script {
  /** 视频工作标题. */
  title: string;
  /** 主题（领域守卫的输入之一）. */
  topic: string;
  /** ≥3 段（schema 校验下限）. */
  segments: Segment[];
  /** 素材来源追溯. */
  source: { kind: "article" | "topic"; ref: string };
}

/** One narration segment (locked fields). */
export interface Segment {
  /** 口播文字（TTS 输入）. */
  text: string;
  /** 卡片要点文案（渲染输入，≠口播全文）. */
  cardText: string;
  /** 卡片高亮词（模板可用）；每项必须是 cardText 的子串（BR-U3-10）. */
  emphasis?: string[];
}

/** Duration estimate (locked fields). Preview-only — see BR-U3-8. */
export interface DurationEstimate {
  /** 估算总秒数（0.1s 精度）. */
  total: number;
  /** 逐段估算秒数（与 segments 等长，0.1s 精度）. */
  perSegment: number[];
  /** 是否落在 60-180s 目标区间. */
  withinTarget: boolean;
}

/**
 * Schema constraint table (domain-entities.md; validateScript 断言依据).
 * cardText 上限与 U4 默认 CardTemplate 容量协同（模板变更时随 config 同步）.
 */
export const SCRIPT_CONSTRAINTS = {
  /** title 非空且 ≤60 字符. */
  titleMaxChars: 60,
  /** topic ≤500 字符；超出截断+警告，不拒绝（BR-U3-5，FR-1 AC-3）. */
  topicMaxChars: 500,
  /** segments 长度下限（FR-1 AC-1）. */
  segmentsMin: 3,
  /** segments 长度上限. */
  segmentsMax: 20,
  /** 口播文字每段上限（约 66s/段上限内）. */
  textMaxChars: 300,
  /** 卡片文案上限（卡片容量约束）. */
  cardTextMaxChars: 80,
} as const;

/** Speech-rate parameters for {@link DurationEstimate} (Q2=A 可配置). */
export interface SpeechRateConfig {
  /** 语速（字/秒）. */
  charsPerSec: number;
  /** 段间停顿（秒），计入每段估算. */
  interSegmentPauseSec: number;
}

/** Default speech rate: 4.5 字/秒 + 0.3s 段间停顿 (domain-entities.md). */
export const DEFAULT_SPEECH_RATE: SpeechRateConfig = {
  charsPerSec: 4.5,
  interSegmentPauseSec: 0.3,
};

/** Target duration window for withinTarget (60-180s, FR-1). */
export const DURATION_TARGET = { minSec: 60, maxSec: 180 } as const;

/** One restricted-domain category inside the guard table. */
export interface DomainGuardCategory {
  /** 类别名（finance/medical/law/gambling 等严管域，C7）. */
  name: string;
  /** 词条（大小写不敏感子串匹配）. */
  keywords: string[];
}

/**
 * Domain-guard keyword table shape — maintained as the config asset
 * `assets/domain-guard.json`, never hardcoded (BR-U3-4, Q1=A).
 */
export interface DomainGuardTable {
  categories: DomainGuardCategory[];
}
