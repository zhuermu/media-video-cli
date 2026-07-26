/**
 * @module @core/pkg (summary)
 *
 * SUMMARY.md rendering: the UploadChecklist factory (9 fixed items, Q2=A)
 * and the pure renderSummary function (counted in the coverage denominator).
 *
 * Boundary rules honored here:
 * - BR-U5-6: fixed item set; the aigc-declare reminder MUST be prominent —
 *   it is placed FIRST in the canonical order and rendered bold.
 * - Footer interpolates the `register add` command template with the
 *   package ref (domain-entities UploadChecklist 尾注插值).
 */

import type { ChecklistItem, ManifestV1, UploadChecklist } from "./types";

/**
 * Builds the fixed 9-item checklist (Q2=A). Canonical order places the
 * prominent aigc-declare item first (置顶, BR-U5-6/C11); the remaining 8
 * follow the domain-entities id enum order.
 */
export function buildUploadChecklist(packageRef: string): UploadChecklist {
  const items: ChecklistItem[] = [
    {
      id: "aigc-declare",
      label:
        "【AIGC 声明】发布时必须勾选平台「AI 生成内容」声明（法规红线，全文见 aigc-declaration.md）",
      prominent: true,
    },
    {
      id: "video-plays",
      label: "成片可正常播放（video.mp4）",
      prominent: false,
    },
    { id: "av-sync", label: "音画同步无漂移", prominent: false },
    {
      id: "subtitle-readable",
      label: "卡片/字幕文字清晰可读",
      prominent: false,
    },
    { id: "cover-ok", label: "封面显示正常（cover.jpg）", prominent: false },
    {
      id: "title-pick",
      label: "每平台从 3 条候选标题中选定 1 条（见 metadata-*.md）",
      prominent: false,
    },
    {
      id: "tags-check",
      label: "核对话题标签（视频号/抖音各自的 tags）",
      prominent: false,
    },
    {
      id: "materials-review",
      label: "素材来源清单已复核（materials-manifest.md）",
      prominent: false,
    },
    {
      id: "publish-time",
      label: "按 publish-advice.md 选择发布时间",
      prominent: false,
    },
    {
      id: "follow-cta",
      label:
        "简介结尾或评论区首条带关注引导（文案见 manifest.json 的 author.cta）",
      prominent: false,
    },
  ];
  return { packageRef, items };
}

/**
 * Pure function: checklist + manifest → SUMMARY.md content.
 *
 * Prominent items render bold (`**...**`); the manifest contributes the
 * probe-measured video facts to the header so the human reviewer sees the
 * actual numbers, not claims. The footer interpolates the register command
 * with the package ref.
 */
export function renderSummary(
  checklist: UploadChecklist,
  manifest: ManifestV1,
): string {
  const { video } = manifest;
  const lines: string[] = [
    "# 发布包 SUMMARY — 上传前人工核对单",
    "",
    `> 成片实测: ${video.durationSec.toFixed(1)}s, ${video.width}x${video.height}` +
      `（probe 数据，非声明值）; 组装时间: ${manifest.generated_at}`,
    "",
  ];

  for (const item of checklist.items) {
    lines.push(
      item.prominent ? `- [ ] **${item.label}**` : `- [ ] ${item.label}`,
    );
  }

  lines.push(
    "",
    "---",
    "",
    "发布完成后登记（幂等键 platform+url，重复登记会被拒绝）：",
    "",
    "```",
    `register add --platform <shipinhao|douyin> --url <发布链接> --title <所选标题> --package ${checklist.packageRef}`,
    "```",
    "",
  );
  return lines.join("\n");
}
