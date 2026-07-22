import { describe, expect, it } from "vitest";
import {
  buildGitHubCodingModelConfig,
  createAiReplyHandler,
  resolveGitHubCodingModelConfig,
  type AiProviderRuntime,
  type AiReplyConfig,
} from "./ai-reply.js";

describe("buildGitHubCodingModelConfig", () => {
  it("uses the selected provider and per-chat model entry", () => {
    const provider: AiProviderRuntime = {
      id: "override-provider",
      label: "Override",
      apiKey: "override-secret",
      baseURL: "https://override.example/v1",
      providerFormat: "gemini",
      defaultModel: "default-model",
      models: [
        {
          id: "chat-model",
          capabilities: ["tool_calling", "code", "long_context"],
          maxTokens: 24_000,
          thinking: "disabled",
        },
      ],
    };

    expect(buildGitHubCodingModelConfig(provider, "chat-model")).toEqual({
      apiKey: "override-secret",
      baseURL: "https://override.example/v1",
      id: "chat-model",
      providerFormat: "gemini",
      maxTokens: 24_000,
      capabilities: ["tool_calling", "code", "long_context"],
      thinking: "disabled",
    });
  });

  it("infers capabilities for a selected model absent from the provider catalog", () => {
    const provider: AiProviderRuntime = {
      id: "provider",
      label: "Provider",
      apiKey: "secret",
      baseURL: "https://provider.example/v1",
      providerFormat: "openai",
      defaultModel: "fallback",
    };

    const result = buildGitHubCodingModelConfig(provider, "gpt-4o");
    expect(result.id).toBe("gpt-4o");
    expect(result.capabilities).toContain("vision");
  });
});

describe("resolveGitHubCodingModelConfig", () => {
  const chatProvider: AiProviderRuntime = {
    id: "chat-provider",
    label: "Chat",
    apiKey: "chat-secret",
    baseURL: "https://chat.example/v1",
    providerFormat: "openai",
    defaultModel: "chat-default",
    models: [{ id: "chat-override" }],
  };
  const codingProvider: AiProviderRuntime = {
    id: "coding-provider",
    label: "Coding",
    apiKey: "coding-secret",
    baseURL: "https://coding.example/v1",
    providerFormat: "gemini",
    defaultModel: "coding-default",
    models: [{ id: "coding-model", maxTokens: 16_000 }],
  };

  it("uses a separately selected coding provider and model", () => {
    expect(
      resolveGitHubCodingModelConfig(
        { codingProviderId: "coding-provider", codingModelId: "coding-model" },
        [chatProvider, codingProvider],
        chatProvider,
        "chat-override",
      ),
    ).toMatchObject({
      apiKey: "coding-secret",
      baseURL: "https://coding.example/v1",
      providerFormat: "gemini",
      id: "coding-model",
      maxTokens: 16_000,
    });
  });

  it("keeps backward-compatible fallback to the current chat provider and model", () => {
    expect(
      resolveGitHubCodingModelConfig(
        {},
        [chatProvider, codingProvider],
        chatProvider,
        "chat-override",
      ),
    ).toMatchObject({ apiKey: "chat-secret", id: "chat-override" });
  });

  it("rejects stale provider and model selections at runtime", () => {
    expect(
      resolveGitHubCodingModelConfig(
        { codingProviderId: "missing" },
        [chatProvider],
        chatProvider,
        "chat-default",
      ),
    ).toBeUndefined();
    expect(
      resolveGitHubCodingModelConfig(
        { codingProviderId: "chat-provider", codingModelId: "missing" },
        [chatProvider],
        chatProvider,
        "chat-default",
      ),
    ).toBeUndefined();
  });
});

describe("AI reply runtime lifecycle", () => {
  it("clears both pending-action registries when destroyed", () => {
    const config: AiReplyConfig = {
      botId: "bot-1",
      apiKey: "secret",
      baseURL: "https://provider.example/v1",
      model: "model",
      systemPrompt: "Be helpful.",
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: [],
        randomReplyPercent: 0,
        randomReplyCooldown: 60,
      },
      groupOverrides: {},
      adminChatIds: [1],
      token: "123:test",
    };
    const runtime = createAiReplyHandler(config);
    const actions = runtime.state.getPendingActions();
    actions.registerChoice("choice-1", 1, 1, "Choose", ["A"]);
    const githubActions = runtime.state.getPendingGitHubActions();
    const githubAction = githubActions.register({
      chatId: 1,
      userId: 1,
      description: "Push",
      execute: async () => ({ summary: "done" }),
    });

    runtime.destroy();
    runtime.destroy();

    expect(actions.getChoice("choice-1")).toBeUndefined();
    expect(githubActions.get(githubAction.id)).toBeUndefined();
  });
});
