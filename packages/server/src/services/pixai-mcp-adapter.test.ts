import { describe, expect, it, vi } from "vitest";
import type { PixaiMcpClient } from "./pixai-mcp-client.js";
import { PixaiMcpAdapter, PixaiMcpContractError } from "./pixai-mcp-adapter.js";

describe("PixaiMcpAdapter", () => {
  it("encapsulates prepare then generate and projects operation experience", async () => {
    const client = {
      prepareGeneration: vi.fn().mockResolvedValue({
        result: { planId: "plan-1", approval: { required: false } },
      }),
      generate: vi.fn().mockResolvedValue({
        result: {
          operationId: "operation-1",
          state: "submitted",
          experience: {
            phase: "provider_queue",
            terminal: false,
            nextAction: { type: "wait" },
          },
        },
      }),
    } as unknown as PixaiMcpClient;
    const adapter = new PixaiMcpAdapter(client);

    const result = await adapter.createGeneration(
      { presetKey: "daily-anime", prompt: "library" },
      { idempotencyKey: "request:1" },
    );

    expect(client.prepareGeneration).toHaveBeenCalledWith(
      { presetKey: "daily-anime", prompt: "library" },
      undefined,
    );
    expect(client.generate).toHaveBeenCalledWith(
      { planId: "plan-1", idempotencyKey: "request:1" },
      undefined,
    );
    expect(result.operation).toMatchObject({
      operationId: "operation-1",
      phase: "provider_queue",
      terminal: false,
      nextAction: { type: "wait" },
    });
  });

  it("returns all image content from get_result", async () => {
    const client = {
      getResult: vi.fn().mockResolvedValue({
        result: { operationId: "operation-1", terminal: true },
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/webp" }],
        resourceLinks: [
          {
            type: "resource_link",
            uri: "https://mcp.aistine.com/api/artifacts/11111111-1111-4111-8111-111111111111",
            name: "result",
          },
        ],
      }),
    } as unknown as PixaiMcpClient;

    const result = await new PixaiMcpAdapter(client).getGenerationResult("operation-1");
    expect(result.images).toHaveLength(1);
    expect(result.resourceLinks).toHaveLength(1);
    expect(result.operation.operationId).toBe("operation-1");
  });

  it("fails closed when required identifiers are absent", async () => {
    const client = {
      prepareGeneration: vi.fn().mockResolvedValue({ result: { approval: { required: false } } }),
    } as unknown as PixaiMcpClient;

    await expect(
      new PixaiMcpAdapter(client).prepareGeneration({ presetKey: "preset", prompt: "prompt" }),
    ).rejects.toEqual(new PixaiMcpContractError("planId"));
  });
});
