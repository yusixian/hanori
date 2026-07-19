import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
}));

vi.mock("ai", () => mocks);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({ embeddingModel: () => "embedding-model" }),
}));

import { EmbeddingService } from "./embedding-service.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("EmbeddingService", () => {
  it("passes the caller's abort signal to the embedding request", async () => {
    mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2] });
    const service = new EmbeddingService({
      apiKey: "test-key",
      baseURL: "https://example.invalid/v1",
      model: "embedding-model",
      dimensions: 2,
    });
    const controller = new AbortController();

    await expect(service.generateEmbedding("private query", controller.signal)).resolves.toEqual([
      0.1, 0.2,
    ]);

    expect(mocks.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "private query",
        abortSignal: controller.signal,
      }),
    );
  });

  it("degrades an aborted request without logging the query or provider error", async () => {
    const error = new DOMException("request with private query was aborted", "AbortError");
    mocks.embed.mockRejectedValue(error);
    const warn = vi.fn();
    const service = new EmbeddingService(
      {
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        model: "embedding-model",
        dimensions: 2,
      },
      { warn } as never,
    );

    await expect(
      service.generateEmbedding("private query", AbortSignal.abort()),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith("Embedding generation failed, degrading gracefully");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private query");
  });
});
