import type { GenerationLibraryActor, GenerationLibraryPort } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDanbooruTools, searchDanbooruCharacterTags } from "./danbooru.js";

describe("searchDanbooruCharacterTags", () => {
  afterEach(() => vi.useRealTimers());
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

  it("records cached results with their original fetch time and marks stale fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { type: "tag", label: "cache_actor", value: "cache_actor", category: 4 },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    const recordDanbooru = vi.fn().mockResolvedValue(undefined);
    const actor: GenerationLibraryActor = {
      botId: "bot-1",
      source: "telegram",
      telegramUserId: 42,
      isAdmin: false,
    };
    const tools = createDanbooruTools({
      fetch: fetchMock,
      generationLibraryPort: { recordDanbooru } as unknown as GenerationLibraryPort,
      getActor: () => actor,
    });
    const execute = (input: { query: string; limit: number }) =>
      (
        tools.search_danbooru_character_tags as Tool as unknown as {
          execute: (value: typeof input) => Promise<unknown>;
        }
      ).execute(input);

    const first = await execute({ query: "cache actor 53", limit: 1 });
    const cached = await execute({ query: "cache actor 53", limit: 1 });
    vi.setSystemTime(new Date("2026-09-21T12:00:00.001Z"));
    fetchMock.mockRejectedValueOnce(new Error("upstream unavailable"));
    const stale = await execute({ query: "cache actor 53", limit: 1 });

    expect(first).toMatchObject({ fetchedAt: "2026-09-21T00:00:00.000Z", stale: false });
    expect(cached).toMatchObject({ fetchedAt: "2026-09-21T00:00:00.000Z", stale: false });
    expect(stale).toMatchObject({
      fetchedAt: "2026-09-21T00:00:00.000Z",
      stale: true,
      note: expect.stringContaining("outdated"),
    });
    expect(recordDanbooru).toHaveBeenCalledTimes(3);
    expect(recordDanbooru).toHaveBeenNthCalledWith(
      3,
      actor,
      expect.arrayContaining([expect.objectContaining({ tag: "cache_actor" })]),
      new Date("2026-09-21T00:00:00.000Z"),
    );
  });

  it("returns external results when local persistence fails and logs bounded diagnostics", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { type: "tag", label: "external_only", value: "external_only", category: 4 },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    const onLog = vi.fn();
    const tools = createDanbooruTools({
      fetch: fetchMock,
      generationLibraryPort: {
        recordDanbooru: vi.fn().mockRejectedValue(new Error("x".repeat(1_000))),
      } as unknown as GenerationLibraryPort,
      getActor: () => ({
        botId: "bot-1",
        source: "telegram",
        telegramUserId: 42,
        isAdmin: false,
      }),
      onLog,
    });

    await expect(
      (
        tools.search_danbooru_character_tags as Tool as unknown as {
          execute: (value: { query: string; limit: number }) => Promise<unknown>;
        }
      ).execute({ query: "external only 53", limit: 1 }),
    ).resolves.toMatchObject({
      tags: [expect.objectContaining({ tag: "external_only" })],
      source: "https://danbooru.donmai.us",
    });
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        meta: expect.objectContaining({ error: "x".repeat(500), queryLength: 16 }),
      }),
    );
  });
});
