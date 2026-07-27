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
        maxSteps: 2,
        taskLength: delegatedTask.length,
        contextLength: context.length,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(delegatedTask);
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(context);
  });
});
