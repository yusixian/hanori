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

  it("uses the shorter default preview and notice for an oversized prompt", () => {
    const result = formatImageGenerationCaption({ prompt: "画".repeat(2_000), imageCount: 1 });

    expect(result.truncated).toBe(true);
    expect(result.plainTextLength).toBeLessThan(TELEGRAM_MEDIA_CAPTION_LIMIT);
    expect(result.html).toContain("画".repeat(200));
    expect(result.html).not.toContain("画".repeat(201));
    expect(result.html).toContain("Prompt 已截断，完整内容见任务详情");
    expect(result.html).toContain("…</blockquote>");
  });

  it("applies a configured preview length and escaped notice", () => {
    const result = formatImageGenerationCaption({
      prompt: "prompt".repeat(50),
      imageCount: 1,
      receiptConfig: {
        promptPreviewLength: 20,
        truncationNoticeText: "Open <details> & copy",
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.html).toContain("promptpromptpromptpr…");
    expect(result.html).toContain("Open &lt;details&gt; &amp; copy");
  });

  it("can make the truncation notice a safe task-details link", () => {
    const result = formatImageGenerationCaption({
      prompt: "prompt".repeat(50),
      imageCount: 2,
      truncationNoticeUrl: 'https://bot.example/task?a=1&label="details"',
    });

    expect(result.html).toContain(
      '<a href="https://bot.example/task?a=1&amp;label=&quot;details&quot;">',
    );
    expect(result.plainTextLength).toBeLessThanOrEqual(TELEGRAM_MEDIA_CAPTION_LIMIT);
  });

  it("omits the Prompt block and notice when both are disabled", () => {
    const result = formatImageGenerationCaption({
      prompt: "hidden prompt",
      imageCount: 1,
      receiptConfig: { promptPreviewLength: 0, truncationNoticeEnabled: false },
    });

    expect(result).toEqual({
      html: "<b>🎨 生成完成 · 1 张</b>",
      plainTextLength: "🎨 生成完成 · 1 张".length,
      truncated: true,
    });
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

  it("keeps the caption within Telegram's limit with maximum configured text", () => {
    const result = formatImageGenerationCaption({
      prompt: "🌙".repeat(1_000),
      imageCount: 4,
      presetKey: "preset-".repeat(300),
      receiptConfig: {
        promptPreviewLength: 800,
        truncationNoticeText: "提".repeat(500),
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.plainTextLength).toBeLessThanOrEqual(TELEGRAM_MEDIA_CAPTION_LIMIT);
    expect(result.html).not.toContain("�");
  });
});
