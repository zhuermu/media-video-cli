/**
 * @module @core/script (preview)
 *
 * Pure markdown rendering of the review artifact `script/script.md`
 * (Workflow 4, 审核物 1, Q3=A structure): header meta block with a
 * prominent target-window marker, per-segment table, review-guidance
 * footer. Deterministic — snapshot-testable.
 *
 * Boundary rules honored here:
 * - BR-U3-9: script.md MUST carry the target-window marker and the review
 *   footer (确认/修改指引).
 * - BR-U3-7: an out-of-window total is a WARNING annotation, never a block.
 */

import { estimateDuration } from "./estimate";
import { DURATION_TARGET, type DurationEstimate, type Script } from "./types";

/** Escapes markdown-table-breaking characters inside a cell. */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Renders the script review preview (Q3=A): H1 + meta block + segment
 * table + review footer. The estimate defaults to {@link estimateDuration}
 * over the script, keeping the locked single-argument signature callable.
 */
export function renderPreview(
  script: Script,
  estimate: DurationEstimate = estimateDuration(script),
): string {
  const window = `${DURATION_TARGET.minSec}-${DURATION_TARGET.maxSec}s`;
  const marker = estimate.withinTarget
    ? `**✓ 落在 ${window} 目标区间内**`
    : `**✗ 不在 ${window} 目标区间（仅警告，不阻断——时长是创作裁量，请人工判断）**`;

  const lines: string[] = [
    `# 脚本审核 — ${script.title}`,
    "",
    `- 主题: ${script.topic}`,
    `- 来源: ${script.source.kind}（${script.source.ref}）`,
    `- 总时长估算: ${estimate.total.toFixed(1)}s — ${marker}`,
    "",
    "| # | 口播文字 | 卡片文案 | 估算秒数 |",
    "|---|----------|----------|----------|",
  ];

  for (const [i, segment] of script.segments.entries()) {
    const sec = (estimate.perSegment[i] ?? 0).toFixed(1);
    lines.push(
      `| ${i + 1} | ${tableCell(segment.text)} | ${tableCell(segment.cardText)} | ${sec} |`,
    );
  }

  lines.push(
    "",
    "---",
    "",
    "审核指引: 确认无误 → 运行 `tts run <slug>` 继续；需修改 → 编辑 " +
      "`script/script.json` 后重跑 `script validate <slug>`。",
    "",
  );
  return lines.join("\n");
}
