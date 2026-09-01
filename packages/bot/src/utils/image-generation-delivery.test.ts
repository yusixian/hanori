import { describe, expect, it } from "vitest";
import {
  formatImageGenerationCaption,
  TELEGRAM_MEDIA_CAPTION_LIMIT,
} from "./image-generation-delivery.js";

describe("formatImageGenerationCaption", () => {
  it("keeps a fitting prompt complete in an expandable quote", () => {
    const result = formatImageGenerationCaption({
      prompt: "character: ai_<hoshino> & friends",
      imageCount: 2,
      presetKey: "wallpaper",
      requestSnapshot: { width: 1536, height: 912 },
    });

    expect(result.truncated).toBe(false);
    expect(result.html).toContain("<blockquote expandable>");
    expect(result.html).toContain("ai_&lt;hoshino&gt; &amp; friends");
    expect(result.html).toContain("2 张 · 1536×912 · wallpaper");
  });

  it("uses the full caption budget and marks an oversized prompt", () => {
    const result = formatImageGenerationCaption({ prompt: "画".repeat(2_000), imageCount: 1 });

    expect(result.truncated).toBe(true);
    expect(result.plainTextLength).toBe(TELEGRAM_MEDIA_CAPTION_LIMIT);
    expect(result.html).toContain("当前内容已截断");
    expect(result.html).toContain("…</blockquote>");
  });

  it("does not split a surrogate pair at the boundary", () => {
    const result = formatImageGenerationCaption({ prompt: "🌙".repeat(1_000), imageCount: 1 });

    expect(result.truncated).toBe(true);
    expect(result.plainTextLength).toBeLessThanOrEqual(TELEGRAM_MEDIA_CAPTION_LIMIT);
    expect(result.html).not.toContain("�");
  });

  it("bounds an unexpectedly long preset key before budgeting the prompt", () => {
    const result = formatImageGenerationCaption({
      prompt: "complete prompt",
      imageCount: 1,
      presetKey: "preset-".repeat(300),
    });

    expect(result.plainTextLength).toBeLessThanOrEqual(TELEGRAM_MEDIA_CAPTION_LIMIT);
    expect(result.html).toContain("complete prompt");
  });
});
