import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "./embedding-service.js";

function service() {
  return new EmbeddingService({
    apiKey: "synthetic-key",
    baseURL: "https://example.invalid/v1",
    model: "synthetic",
    dimensions: 2,
  });
}

function respond(data: unknown[]) {
  const fetch = vi.fn(async () => Response.json({ data }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("EmbeddingService with the real SDK response boundary", () => {
  it.each(["single", "parallel batch"])(
    "cancels an in-flight %s through the SDK wrapper",
    async (mode) => {
      const controller = new AbortController();
      const signals: AbortSignal[] = [];
      const fetch = vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            signals.push(signal);
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const texts = Array.from({ length: 2050 }, (_, i) => String(i));
      const pending =
        mode === "single"
          ? service().generateEmbedding("first", controller.signal)
          : service().generateEmbeddings(texts, controller.signal);
      try {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(mode === "single" ? 1 : 2));
        controller.abort();
        expect(await pending).toEqual(mode === "single" ? null : texts.map(() => null));
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(mode === "single" ? 1 : 2);
      } finally {
        controller.abort();
        await pending;
      }
    },
  );

  it("orders indexed vectors by input while preserving request settings", async () => {
    const fetch = respond([
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ]);
    expect(await service().generateEmbeddings(["first", "second"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      input: ["first", "second"],
      dimensions: 2,
      model: "synthetic",
    });
  });

  it("preserves ordered responses from compatible providers that omit every index", async () => {
    respond([{ embedding: [1, 0] }, { embedding: [0, 1] }]);
    expect(await service().generateEmbeddings(["first", "second"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it.each([
    ["missing entry", [{ index: 1, embedding: [0, 1] }]],
    ["extra entry", [{ embedding: [1, 0] }, { embedding: [0, 1] }, { embedding: [1, 1] }]],
    [
      "duplicate index",
      [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] },
      ],
    ],
    ["mixed indices", [{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }]],
    [
      "out of range",
      [
        { index: 0, embedding: [1, 0] },
        { index: 2, embedding: [0, 1] },
      ],
    ],
    [
      "negative index",
      [
        { index: -1, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
    ],
    [
      "fractional index",
      [
        { index: 0.5, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
    ],
    ["wrong dimensions", [{ embedding: [1] }, { embedding: [0, 1] }]],
    ["empty vector", [{ embedding: [] }, { embedding: [0, 1] }]],
  ])("degrades %s without retrying or shifting results", async (_name, data) => {
    const fetch = respond(data);
    expect(await service().generateEmbeddings(["first", "second"])).toEqual([null, null]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a single empty response", async () => {
    const fetch = respond([]);
    expect(await service().generateEmbedding("first")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("orders each valid chunk using its local indices", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string) as { input: string[] };
      return Response.json({
        data: input.map((text, index) => ({ index, embedding: [Number(text), 1] })).reverse(),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const texts = Array.from({ length: 2050 }, (_, i) => String(i));
    expect(await service().generateEmbeddings(texts)).toEqual(
      texts.map((text) => [Number(text), 1]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("checks each SDK chunk before concatenation even when the total count would match", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const { input } = JSON.parse(init.body as string) as { input: string[] };
      // 2048 + 2 inputs: one missing in the first chunk, one extra in the second.
      const count = input.length === 2048 ? 2047 : 3;
      return Response.json({ data: Array.from({ length: count }, () => ({ embedding: [1, 0] })) });
    });
    vi.stubGlobal("fetch", fetch);
    const texts = Array.from({ length: 2050 }, (_, i) => `text ${i}`);
    expect(await service().generateEmbeddings(texts)).toEqual(texts.map(() => null));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
