import { describe, expect, it, vi } from "vitest";
import { searchDanbooruCharacterTags } from "./danbooru.js";

describe("searchDanbooruCharacterTags", () => {
  it("resolves a Chinese alias to a canonical English character tag", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              type: "tag-other-name",
              label: "hakurei_reimu",
              value: "hakurei_reimu",
              category: 4,
              post_count: 100384,
              antecedent: "博丽灵梦",
            },
            { type: "tag", label: "reimu", value: "reimu", category: 0, post_count: 2 },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              title: "hakurei_reimu",
              other_names: ["博丽灵梦", "Reimu Hakurei"],
              body: "The shrine maiden protagonist of [[touhou|Touhou Project]].",
            },
          ]),
        ),
      );

    await expect(
      searchDanbooruCharacterTags({ query: "博丽灵梦", limit: 5, fetch: fetchMock }),
    ).resolves.toEqual([
      expect.objectContaining({
        tag: "hakurei_reimu",
        matchedAlias: "博丽灵梦",
        postCount: 100384,
        otherNames: ["博丽灵梦", "Reimu Hakurei"],
        wikiSummary: "The shrine maiden protagonist of Touhou Project.",
      }),
    ]);
  });

  it("caches repeated English queries without another network request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { type: "tag", label: "hatsune_miku", value: "hatsune_miku", category: 4 },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])));

    const first = await searchDanbooruCharacterTags({
      query: "Hatsune Miku cache test",
      limit: 1,
      fetch: fetchMock,
    });
    const second = await searchDanbooruCharacterTags({
      query: "Hatsune Miku cache test",
      limit: 1,
      fetch: fetchMock,
    });

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
