import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTaskPlan } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { LanguageModel } from "ai";
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  assemble: vi.fn(),
  dispose: vi.fn(),
  send: vi.fn(),
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: mocks.generateText,
}));
vi.mock("../tools/turn-toolset.js", () => ({
  createTurnToolset: mocks.assemble,
  resolveImageGenerationActor: vi.fn(),
}));
vi.mock("../utils/rich-message.js", () => ({ sendMarkdownWithFallback: mocks.send }));
import {
  bindTaskDestinationTopic,
  executeScheduledTask,
  resolveTaskAgentConfig,
  type ScheduledTaskExecutorConfig,
} from "./scheduled-task-executor.js";
const plan: ScheduledTaskPlan = {
  name: "Summary",
  instructions: "Summarize",
  dataScope: { kind: "chat", lookbackHours: 2, maxMessages: 10 },
  destination: { chatId: -2 },
  schedule: { kind: "once", at: "2026-11-12T00:00:00Z", timezone: "UTC" },
  agent: {},
};
function config(): ScheduledTaskExecutorConfig {
  return {
    toolsetConfig: { botId: "bot" } as ScheduledTaskExecutorConfig["toolsetConfig"],
    resolveModel: () => ({ model: {} as LanguageModel, modelId: "model", providerId: "provider" }),
    readTaskHistory: vi.fn().mockResolvedValue({ messages: [], complete: false }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assemble.mockResolvedValue({
    tools: { forbidden: {}, web_search: {} },
    dispose: mocks.dispose,
  });
  mocks.generateText.mockResolvedValue({
    text: "Result",
    totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  });
  mocks.send.mockResolvedValue({ message: { message_id: 42 } });
});
describe("task Agent execution", () => {
  it("inherits live defaults then named Agent then explicit overrides, retaining empty tools", () => {
    expect(
      resolveTaskAgentConfig(
        { agentName: "researcher", agent: { toolNames: [], maxSteps: 3 } },
        { modelId: "default", timeoutMs: 2000 },
        {
          enabled: true,
          agents: { researcher: { modelId: "named", systemPrompt: "research", timeoutMs: 3000 } },
        },
      ),
    ).toMatchObject({
      modelId: "named",
      timeoutMs: 3000,
      maxSteps: 3,
      toolNames: [],
      systemPrompt: "research",
    });
    expect(() => resolveTaskAgentConfig({ agentName: "missing", agent: {} })).toThrow(
      "not configured",
    );
  });
  it("starts independent context and exposes only the approved fixed source scope", async () => {
    const settings = config();
    const now = new Date("2026-11-12T12:00:00Z");
    const result = await executeScheduledTask({
      api: {} as Api,
      plan,
      chatId: -1,
      threadId: 7,
      userId: 9,
      config: settings,
      now,
    });
    const request = mocks.generateText.mock.calls[0]![0];
    expect(request.messages).toHaveLength(1);
    expect(request.tools.forbidden).toBeUndefined();
    await request.tools.read_task_history.execute({ chatId: 999 });
    expect(settings.readTaskHistory).toHaveBeenCalledWith({
      chatId: -1,
      threadId: 7,
      since: new Date("2026-11-12T10:00:00Z"),
      until: now,
      limit: 10,
    });
    expect(mocks.assemble.mock.calls[0]![0].chatId).toBe(-2);
    expect(result).toMatchObject({
      output: "Result",
      messageIds: [42],
      usage: { totalTokens: 3 },
      agent: { providerId: "provider", modelId: "model" },
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("scope none cannot be bypassed by a history allowlist; explicit empty tools stays empty", async () => {
    await executeScheduledTask({
      api: {} as Api,
      plan: { ...plan, dataScope: { kind: "none" }, agent: { toolNames: ["read_task_history"] } },
      chatId: -1,
      userId: 9,
      config: config(),
    });
    expect(mocks.generateText.mock.calls[0]![0].tools).toEqual({});
    await executeScheduledTask({
      api: {} as Api,
      plan: { ...plan, agent: { toolNames: [] } },
      chatId: -1,
      userId: 9,
      config: config(),
    });
    expect(mocks.generateText.mock.calls[1]![0].tools).toEqual({});
  });
  it("disposes plugins and does not send output when model execution fails", async () => {
    mocks.generateText.mockRejectedValue(new Error("model failed"));
    await expect(
      executeScheduledTask({ api: {} as Api, plan, chatId: -1, userId: 9, config: config() }),
    ).rejects.toThrow("model failed");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

it("binds every task message send to its approved topic without affecting other chats or edit methods", async () => {
  const use = vi.fn();
  bindTaskDestinationTopic({ config: { use } } as unknown as Api, { chatId: -2, threadId: 7 });
  const transform = use.mock.calls[0]![0];
  const previous = vi.fn();
  await transform(previous, "sendPhoto", { chat_id: -2, photo: "file", message_thread_id: 99 });
  expect(previous).toHaveBeenLastCalledWith(
    "sendPhoto",
    { chat_id: -2, photo: "file", message_thread_id: 7 },
    undefined,
  );
  await transform(previous, "sendMessage", { chat_id: 9, text: "admin confirmation" });
  expect(previous).toHaveBeenLastCalledWith(
    "sendMessage",
    { chat_id: 9, text: "admin confirmation" },
    undefined,
  );
  await transform(previous, "editMessageText", { chat_id: -2, message_id: 3, text: "update" });
  expect(previous).toHaveBeenLastCalledWith(
    "editMessageText",
    { chat_id: -2, message_id: 3, text: "update" },
    undefined,
  );
});

it("persists the effective Agent before execution and does not run when persistence fails", async () => {
  const onAgentResolved = vi.fn().mockRejectedValue(new Error("storage unavailable"));
  await expect(
    executeScheduledTask({
      api: {} as Api,
      plan,
      chatId: -1,
      userId: 9,
      config: config(),
      onAgentResolved,
    }),
  ).rejects.toThrow("storage unavailable");
  expect(onAgentResolved).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "provider",
      modelId: "model",
      maxSteps: expect.any(Number),
      toolNames: expect.any(Array),
    }),
  );
  expect(mocks.generateText).not.toHaveBeenCalled();
  expect(mocks.assemble).not.toHaveBeenCalled();
});

it("runs the bounded summary callback and leaves delivery to the task exactly once", async () => {
  const settings = config();
  settings.summarizeTaskHistory = vi.fn(async () => ({ ok: true, contentRaw: "server summary" }));
  settings.toolsetConfig.summarizeChat = vi.fn();
  mocks.generateText.mockImplementationOnce(async (request) => {
    expect(request.tools.summarize_chat).toBeUndefined();
    expect(await request.tools.summarize_task_history.execute({})).toEqual({
      ok: true,
      contentRaw: "server summary",
    });
    expect(mocks.send).not.toHaveBeenCalled();
    return { text: "Final summary", totalUsage: {} };
  });
  await executeScheduledTask({ api: {} as Api, plan, chatId: -1, userId: 0, config: settings });
  expect(settings.summarizeTaskHistory).toHaveBeenCalledOnce();
  expect(settings.summarizeTaskHistory).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(mocks.assemble.mock.calls[0]![0].config.summarizeChat).toBeUndefined();
  expect(mocks.send).toHaveBeenCalledOnce();
  await executeScheduledTask({
    api: {} as Api,
    plan: { ...plan, agent: { toolNames: ["read_task_history"] } },
    chatId: -1,
    userId: 0,
    config: settings,
  });
  expect(mocks.generateText.mock.calls[1]![0].tools.summarize_task_history).toBeUndefined();
});
