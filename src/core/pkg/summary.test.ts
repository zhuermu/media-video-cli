/**
 * Pure-function tests for the SUMMARY.md checklist (Q2=A): fixed 9 items,
 * aigc-declare prominent top + bold (BR-U5-6/C11), register command footer
 * interpolation.
 */
import { describe, expect, test } from "bun:test";

import {
  buildUploadChecklist,
  renderSummary,
  type ChecklistItemId,
  type ManifestV1,
} from "@core/pkg";

const manifest: ManifestV1 = {
  schema_version: "1",
  generated_at: "2026-07-23T10:00:00.000Z",
  video: { path: "video.mp4", durationSec: 72.4, width: 1080, height: 1920 },
  cover: { path: "cover.jpg" },
  platform_metadata: {
    shipinhao: {
      path: "metadata-shipinhao.md",
      titles: ["t1", "t2", "t3"],
      tags: ["科技"],
      description: "d",
    },
    douyin: {
      path: "metadata-douyin.md",
      titles: ["t1", "t2", "t3"],
      tags: ["AI"],
      description: "d",
    },
  },
  aigc_declaration: { path: "aigc-declaration.md", must_declare: true },
  materials_manifest: { path: "materials-manifest.md", entryCount: 5 },
  publish_advice: { path: "publish-advice.md" },
};

describe("buildUploadChecklist", () => {
  test("fixed 9 items, aigc-declare first and the only prominent one", () => {
    const checklist = buildUploadChecklist("videos/test/package");

    expect(checklist.items).toHaveLength(9);
    expect(checklist.items[0]!.id).toBe("aigc-declare");
    expect(checklist.items[0]!.prominent).toBe(true);
    expect(checklist.items.filter((i) => i.prominent)).toHaveLength(1);

    const expectedIds: ChecklistItemId[] = [
      "aigc-declare",
      "video-plays",
      "av-sync",
      "subtitle-readable",
      "cover-ok",
      "title-pick",
      "tags-check",
      "materials-review",
      "publish-time",
    ];
    expect(checklist.items.map((i) => i.id)).toEqual(expectedIds);
  });
});

describe("renderSummary", () => {
  test("9 checkboxes, first is the bold AIGC reminder (BR-U5-6)", () => {
    const text = renderSummary(
      buildUploadChecklist("videos/test/package"),
      manifest,
    );

    const boxes = text.split("\n").filter((line) => line.startsWith("- [ ]"));
    expect(boxes).toHaveLength(9);
    expect(boxes[0]).toStartWith("- [ ] **");
    expect(boxes[0]).toContain("AIGC");
    // Only the prominent item is bold.
    expect(boxes.filter((line) => line.includes("**"))).toHaveLength(1);
  });

  test("probe facts in header, register command footer interpolates packageRef", () => {
    const text = renderSummary(
      buildUploadChecklist("videos/test/package"),
      manifest,
    );

    expect(text).toContain("72.4s, 1080x1920");
    expect(text).toContain(
      "register add --platform <shipinhao|douyin> --url <发布链接> --title <所选标题> --package videos/test/package",
    );
  });
});
