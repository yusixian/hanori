import { describe, expect, it } from "vitest";
import { coverRichHtmlImages, coverRichMarkdownImages } from "./rich-image-safety.js";

describe("rich image safety", () => {
  it.each([
    "> text\n> ![](https://example.com/x.jpg)",
    "- text\n  ![](https://example.com/x.jpg)",
    "| image |\n|---|\n| **![](https://example.com/x.jpg)** |",
    "![art][ref]\n\n[ref]: https://example.com/x.jpg",
  ])("covers images within rich formatting: %s", (markdown) => {
    const result = coverRichMarkdownImages(markdown);
    expect(result).toContain("tg-spoiler");
    expect(result).not.toContain("![](");
  });
  it.each([
    '<img src="https://example.com/a.jpg" alt=" tg-spoiler >"/>',
    '<img src="https://example.com/a.jpg" alt=" src=\'tg://emoji?x\'"/>',
    '<img src="https://example.com/a.jpg" tg-spoiler="false"/>',
  ])("does not mistake attribute values for protection: %s", (html) => {
    expect(coverRichHtmlImages(html)).toMatch(/ tg-spoiler\/>$/);
  });
  it("preserves custom emoji and fenced code", () => {
    expect(coverRichHtmlImages('<img src="tg://emoji?id=123" alt="hi"/>')).toBe(
      '<img src="tg://emoji?id=123" alt="hi"/>',
    );
    const code = "```md\n![](https://example.com/x.jpg)\n```";
    expect(coverRichMarkdownImages(code)).toBe(code);
  });
});
