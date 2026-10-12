import { describe, expect, it } from "vitest";
import {
  docsOrigin,
  docsRobots,
  docsSitemap,
  docsUrl,
} from "../packages/docs/app/lib/seo.server.ts";

describe("public documentation origin and discovery", () => {
  it("does not invent a deployment domain when configuration is absent", () => {
    expect(docsOrigin("")).toBeNull();
    expect(docsOrigin("   ")).toBeNull();
    expect(docsSitemap(null, ["/docs", "/docs/guides/ai-chat"])).not.toContain("<loc>");
    expect(docsRobots(null)).not.toContain("Sitemap:");
  });

  it.each([
    "http://bot.example.com",
    "https://user:secret@bot.example.com",
    "https://bot.example.com/docs",
    "https://bot.example.com/?key=secret",
    "https://bot.example.com/#fragment",
    "not-a-url",
  ])("rejects invalid or credential-bearing public origin %s", (value) => {
    expect(() => docsOrigin(value)).toThrow();
  });

  it("uses one canonical URL per page and advertises the matching sitemap", () => {
    const origin = docsOrigin(" https://bot.example.com/ ");
    expect(origin).toBe("https://bot.example.com");
    expect(docsUrl(origin, "/docs")).toBe("https://bot.example.com/docs/");
    expect(docsUrl(origin, "/docs/guides/ai-chat/")).toBe(
      "https://bot.example.com/docs/guides/ai-chat",
    );
    const xml = docsSitemap(origin, ["/docs/", "/docs", "/docs/guides/a&b"]);
    expect(xml.match(/<loc>/g)).toHaveLength(2);
    expect(xml).toContain("https://bot.example.com/docs/guides/a&amp;b");
    expect(docsRobots(origin)).toContain("Sitemap: https://bot.example.com/docs/sitemap.xml");
    expect(docsRobots(origin)).not.toContain("Disallow: /docs");
  });
});
