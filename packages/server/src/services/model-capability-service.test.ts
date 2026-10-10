import { inferCapabilities } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelCapabilityService } from "./model-capability-service.js";

const fetchMock = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn() };
let service: ModelCapabilityService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.clearAllMocks();
  service = new ModelCapabilityService(logger as unknown as Logger);
});
afterEach(() => {
  service.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("loads models nested under providers and preserves longest-prefix matching", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      vendor: {
        models: {
          nova: { tool_call: true },
          "nova-small": { reasoning: true, modalities: { input: ["image"] } },
        },
      },
    }),
  );
  await service.init();
  expect(service.inferCapabilities("nova")).toEqual(["tool_calling"]);
  expect(service.inferCapabilities("nova-small-2026")).toEqual(["vision", "reasoning"]);
  expect(service.inferCapabilities("vendor")).toEqual(inferCapabilities("vendor"));
  expect(service.inferCapabilities("unknown-coder")).toEqual(inferCapabilities("unknown-coder"));
});

it("uses shared metadata for duplicate IDs and heuristics for conflicting providers", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      first: { models: { nova: { tool_call: true }, nebula: { reasoning: true } } },
      second: { models: { nova: { tool_call: false }, nebula: { reasoning: true } } },
      third: { models: { nova: { tool_call: true } } },
    }),
  );
  await service.init();
  expect(service.inferCapabilities("nova")).toEqual(inferCapabilities("nova"));
  expect(service.inferCapabilities("nebula")).toEqual(["reasoning"]);
});

it.each([
  null,
  [],
  {},
  { vendor: { models: {} } },
  { vendor: { models: { nova: { tool_call: "yes" } } } },
])("keeps the last valid cache when refresh data is invalid: %j", async (invalid) => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ vendor: { models: { nova: { reasoning: true } } } }))
    .mockResolvedValueOnce(Response.json(invalid));
  await service.init();
  await vi.advanceTimersByTimeAsync(service.getIntervalMs());
  expect(service.inferCapabilities("nova")).toEqual(["reasoning"]);
  expect(logger.warn).toHaveBeenCalled();
});

it("falls back to heuristics after initial failure and recovers at refresh", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ vendor: { models: { nova: { attachment: true } } } }));
  await service.init();
  expect(service.inferCapabilities("gpt-4o")).toEqual(inferCapabilities("gpt-4o"));
  await vi.advanceTimersByTimeAsync(service.getIntervalMs());
  expect(service.inferCapabilities("nova")).toEqual(["vision"]);
});

it("does not treat PDF attachments as vision and preserves known long-context metadata", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      vendor: {
        models: {
          "gpt-4.1": {
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"] },
          },
          nova: { attachment: true, modalities: { input: ["text", "pdf"] } },
        },
      },
    }),
  );
  await service.init();
  expect(service.inferCapabilities("gpt-4.1")).toEqual([
    "vision",
    "tool_calling",
    "code",
    "long_context",
  ]);
  expect(service.inferCapabilities("nova")).not.toContain("vision");
});

it.each([false, true])(
  "releases HTTP error bodies without losing the cached catalog (cancel fails: %s)",
  async (fails) => {
    const cancel = vi.fn(() => {
      if (fails) throw new Error("stream cleanup failed");
    });
    fetchMock
      .mockResolvedValueOnce(Response.json({ vendor: { models: { nova: { reasoning: true } } } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }));
    await service.init();
    await vi.advanceTimersByTimeAsync(service.getIntervalMs());
    expect(cancel).toHaveBeenCalledOnce();
    expect(service.inferCapabilities("nova")).toEqual(["reasoning"]);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "models.dev HTTP 503" }),
      "ModelCapabilityService: refresh failed",
    );
  },
);
