import type { RuntimeDiagnosticsPort } from "@cos-tool-bot/shared";
import type { BotContext } from "../context.js";
import { describe, expect, it, vi } from "vitest";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

function config(port: RuntimeDiagnosticsPort): AiReplyConfig {
  return {
    botId: "bot",
    apiKey: "secret",
    baseURL: "https://example.com",
    model: "model",
    systemPrompt: "private prompt",
    token: "token",
    adminChatIds: [7],
    privateChatAccess: "admin",
    groupOverrides: {},
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    runtimeDiagnostics: port,
    getDiagnosticTraceId: () => "incoming",
  };
}
function context(): BotContext {
  return {
    message: { message_id: 9, text: "secret text", entities: [] },
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "User" },
    me: { id: 99, username: "bot" },
    api: {},
  } as unknown as BotContext;
}
describe("AI reply diagnostic scope", () => {
  it("records access rejection using the ingress trace without recording message content", async () => {
    const port: RuntimeDiagnosticsPort = {
      startTrace: vi.fn(() => "new"),
      record: vi.fn(),
      bindRuntime: vi.fn(),
      query: vi.fn(),
    };
    const runtime = createAiReplyHandler(config(port));
    await runtime.handler(context(), vi.fn());
    expect(port.startTrace).not.toHaveBeenCalled();
    expect(port.record).toHaveBeenCalledWith("incoming", {
      stage: "complete",
      outcome: "skipped",
      code: "denied",
    });
    expect(JSON.stringify(vi.mocked(port.record).mock.calls)).not.toContain("secret");
    const readers = vi.mocked(port.bindRuntime).mock.calls[0]![0];
    expect(readers.effectiveConfig(42)).toEqual(
      expect.objectContaining({
        providerId: expect.any(String),
        modelId: "model",
        source: "runtime",
      }),
    );
    expect(readers.scheduler(42)).toEqual({ active: 0, queued: 0, asyncTasks: 0 });
    runtime.destroy();
  });
});
