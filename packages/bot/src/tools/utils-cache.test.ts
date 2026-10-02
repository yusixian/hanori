import type { Tool } from "ai";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRequestCache, wrapToolsWithCache, zodToAiSchema } from "./utils.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

describe("wrapToolsWithCache", () => {
  it("allows the enlarged delegation budget and blocks the next call", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = wrapToolsWithCache(
      {
        delegate_task: tool({
          description: "delegate",
          inputSchema: zodToAiSchema(z.object({})),
          execute,
        }),
      },
      createRequestCache(),
    );
    const delegate = tools.delegate_task as Tool as unknown as ExecutableTool;
    const options = { abortSignal: new AbortController().signal };

    for (let index = 0; index < 64; index++) await delegate.execute({}, options);
    await expect(delegate.execute({}, options)).resolves.toMatchObject({ blocked: true });
    expect(execute).toHaveBeenCalledTimes(64);
  });
});

describe("unified search result caching", () => {
  it("does not reuse results or reference bodies across query/provider/filter/page/limit changes or eviction", async () => {
    const { createUnifiedSearchTools } = await import("./search.js");
    const search = vi.fn().mockImplementation(async (request) => ({
      status: "ok",
      items: [
        {
          id: "item",
          title: "title",
          summary: JSON.stringify(request),
          content: "x".repeat(32_000),
        },
      ],
      hasMore: true,
    }));
    const tools = wrapToolsWithCache(
      createUnifiedSearchTools([
        {
          id: "p",
          scope: "characters",
          description: "test",
          pagination: "native",
          filters: { tag: { type: "string", description: "tag" } },
          search,
        },
        { id: "q", scope: "characters", description: "other", pagination: "native", search },
      ]),
      createRequestCache(),
    );
    const options = { toolCallId: "test", messages: [] };
    const input = { scope: "characters", provider: "p", query: "Tag_ID", page: 1, limit: 1 };
    const first = (await tools.search!.execute!(
      input as never,
      options,
    )) as import("@cos-tool-bot/shared").SearchResult;
    const reference = first.items[0]!.reference;
    await expect(
      tools.read_reference!.execute!({ reference, offset: 0, limit: 1 } as never, options),
    ).resolves.toMatchObject({ content: "x" });
    for (const change of [
      {},
      { query: "tag_id" },
      { scope: "missing" },
      { provider: "q" },
      { filters: { tag: "Exact_TAG" } },
      { page: 2 },
      { limit: 2 },
    ])
      await tools.search!.execute!({ ...input, ...change } as never, options);
    expect(search).toHaveBeenCalledTimes(7);
    const summaries = search.mock.calls.map(([request]) => JSON.stringify(request));
    expect(summaries).toContain(JSON.stringify({ ...input, query: "tag_id" }));
    expect(summaries).toContain(JSON.stringify({ ...input, filters: { tag: "Exact_TAG" } }));
    for (let index = 0; index < 20; index++) await tools.search!.execute!(input as never, options);
    await expect(
      tools.read_reference!.execute!({ reference, offset: 0, limit: 1 } as never, options),
    ).resolves.toMatchObject({ status: "forbidden", content: "" });
    await expect(
      tools.read_reference!.execute!({ reference, offset: 1, limit: 2 } as never, options),
    ).resolves.toMatchObject({ status: "forbidden", content: "" });
  });
});
