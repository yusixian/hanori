import type { LanguageModel, Tool } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createAgentTools } from "./agents.js";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
}));

interface ExecutableTool {
  execute: (input: { agent: string; task: string; context?: string }) => Promise<unknown>;
}

describe("createAgentTools logging", () => {
  test("logs delegated task structure without task or context content", async () => {
    generateTextMock.mockResolvedValue({ text: "delegated answer", steps: [] });
    const onLog = vi.fn();
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test-model",
      onLog,
    });
    const delegatedTask = "confidential delegated task";
    const context = "private background context";

    await (tools.delegate_task as Tool as unknown as ExecutableTool).execute({
      agent: "translator",
      task: delegatedTask,
      context,
    });

    expect(onLog).toHaveBeenCalledWith({
      level: "debug",
      message: "[delegate] agent=translator started",
      meta: {
        agent: "translator",
        subAgentModel: "test-model",
        maxSteps: 64,
        taskLength: delegatedTask.length,
        contextLength: context.length,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(delegatedTask);
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(context);
  });

  test("keeps the Danbooru tag tool when researcher web tools are enabled", async () => {
    generateTextMock.mockResolvedValue({ text: "research answer", steps: [] });
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test-model",
      webToolsConfig: { enabled: true },
    });

    await (tools.delegate_task as Tool as unknown as ExecutableTool).execute({
      agent: "researcher",
      task: "resolve a character tag",
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          fetch_webpage: expect.any(Object),
          search_danbooru_character_tags: expect.any(Object),
        }),
      }),
    );
  });
});
