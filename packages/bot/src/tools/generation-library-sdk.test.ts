import type { GenerationLibraryPort } from "@cos-tool-bot/shared";
import { GenerationLibraryError } from "@cos-tool-bot/shared";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createGenerationLibraryTools } from "./generation-library.js";
import { composeTurnTools } from "../utils/tool-pipeline.js";
import { createRequestCache } from "./utils.js";

const actor = { botId: "bot-1", source: "telegram" as const, telegramUserId: 42, isAdmin: true };
const input = { name: "Soft light", type: "style", content: "soft lighting", safety: "safe" };

async function saveThroughSdk(
  args: Record<string, unknown>,
  saveAsset = vi.fn().mockResolvedValue({ id: 7 }),
) {
  const onLog = vi.fn();
  const onDiagnostic = vi.fn();
  const onEffect = vi.fn();
  const tools = composeTurnTools(
    createGenerationLibraryTools({
      port: { saveAsset } as unknown as GenerationLibraryPort,
      getActor: () => actor,
    }),
    {
      onLog,
      onDiagnostic,
      onEffect,
      requestCache: createRequestCache(),
      getStep: () => 1,
      secrets: ["private-storage-token"],
    },
  );
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "save-1",
          toolName: "save_prompt_asset",
          input: JSON.stringify(args),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 0, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const result = await generateText({
    model,
    tools,
    prompt: "Save this style",
    stopWhen: stepCountIs(1),
  });
  return { result, saveAsset, model, onLog, onDiagnostic, onEffect };
}

describe("prompt asset SDK contract", () => {
  it.each([undefined, null])(
    "creates without a guessed id (%s) and applies schema defaults",
    async (id) => {
      const { result, saveAsset, model, onEffect } = await saveThroughSdk({
        ...input,
        ...(id === null ? { id } : {}),
      });
      expect(saveAsset).toHaveBeenCalledExactlyOnceWith(
        actor,
        { ...input, notes: "", pinned: false },
        undefined,
      );
      expect(result.toolResults[0]?.output).toMatchObject({
        ok: true,
        action: "created",
        asset: { id: 7 },
      });
      expect(
        model.doGenerateCalls[0]!.tools!.find(
          (tool) => tool.type === "function" && tool.name === "save_prompt_asset",
        ),
      ).toMatchObject({
        inputSchema: { required: expect.not.arrayContaining(["id", "notes", "pinned"]) },
      });
      expect(onEffect).toHaveBeenCalledExactlyOnceWith("save_prompt_asset");
    },
  );

  it("validates malformed input before any storage call", async () => {
    const { result, saveAsset, onDiagnostic, onLog, onEffect } = await saveThroughSdk({
      ...input,
      content: "",
      id: 0,
    });
    expect(saveAsset).not.toHaveBeenCalled();
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool-error" })]),
    );
    expect(onEffect).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "tool",
        outcome: "failed",
        code: "tool_invalid_input",
        toolName: "save_prompt_asset",
      }),
    );
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "AI tool input invalid",
        meta: expect.objectContaining({
          toolName: "save_prompt_asset",
          error: expect.objectContaining({ name: "ZodError" }),
        }),
      }),
    );
  });

  it("returns a specific rejection when the requested asset no longer exists", async () => {
    const error = new GenerationLibraryError("not_found", "Prompt asset not found");
    const { result, onDiagnostic, onEffect } = await saveThroughSdk(
      { ...input, id: 9 },
      vi.fn().mockRejectedValue(error),
    );
    expect(result.toolResults[0]?.output).toMatchObject({
      ok: false,
      code: "not_found",
      error: "Prompt asset not found",
      saveState: "not_saved",
    });
    expect(onEffect).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "tool_not_found", outcome: "failed" }),
    );
  });

  it("updates the explicitly selected asset without creating another", async () => {
    const { result, saveAsset } = await saveThroughSdk({ ...input, id: 7 });
    expect(saveAsset).toHaveBeenCalledExactlyOnceWith(
      actor,
      { ...input, notes: "", pinned: false },
      7,
    );
    expect(result.toolResults[0]?.output).toMatchObject({
      ok: true,
      action: "updated",
      asset: { id: 7 },
    });
  });

  it("keeps an uncertain storage outcome explicit and redacts the original cause in owner logs", async () => {
    const storageError = new Error("connection dropped private-storage-token");
    const { result, onLog, onEffect, onDiagnostic, saveAsset } = await saveThroughSdk(
      input,
      vi.fn().mockRejectedValue(storageError),
    );
    const failure = result.content.find((part) => part.type === "tool-error");
    expect(failure).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("save outcome is unknown"),
      }),
    });
    expect(saveAsset).toHaveBeenCalledOnce();
    expect(onEffect).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "tool_storage_error", outcome: "failed" }),
    );
    const logs = JSON.stringify(onLog.mock.calls);
    expect(logs).toContain("connection dropped [REDACTED]");
    expect(logs).not.toContain("private-storage-token");
    expect(JSON.stringify(result.response.messages)).not.toContain("private-storage-token");
  });
});
