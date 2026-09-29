import type { BotAiSelectionRuntime, BotTimerHandlers, HarnessBotPort } from "@cos-tool-bot/bot";
import type { BotMemory } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessService } from "../../harness/service.js";
import type { BackupService } from "../backup.js";
import {
  ChatAiSelectionRuntimeRegistry,
  type ChatAiSelectionRuntimeSnapshot,
} from "../chat-ai-selection-runtime-registry.js";
import type { DbLogger } from "../db-logger.js";
import type { McpClientManager } from "../mcp-client-manager.js";
import { assembleBotRuntime, type BotRuntimeServices, type ChatAiSelectionPort } from "./index.js";
import {
  BOT_ID,
  aiConfig,
  chatProvider,
  embeddingConfig,
  runtimeHost,
  runtimeInput,
  runtimeServices,
} from "./test-fakes.js";

const embedders = vi.hoisted(() => ({
  created: [] as Array<{
    generateEmbedding: ReturnType<typeof vi.fn>;
    generateEmbeddings: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../embedding-service.js")>()),
  createBotEmbeddingService: (runtime: { embeddingApiKey?: string } | null) => {
    if (!runtime?.embeddingApiKey) return undefined;
    const ordinal = embedders.created.length;
    const embedder = {
      generateEmbedding: vi.fn(async (text: string) => [text.length, ordinal]),
      generateEmbeddings: vi.fn(async (texts: string[]) =>
        texts.map((text) => [text.length, ordinal]),
      ),
    };
    embedders.created.push(embedder);
    return embedder;
  },
}));

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function dbLogger(): DbLogger {
  return {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
  } as unknown as DbLogger;
}

function assemble(
  options: Parameters<typeof runtimeInput>[1] & {
    services?: Partial<BotRuntimeServices>;
    host?: ReturnType<typeof runtimeHost>;
  } = {},
) {
  return assembleBotRuntime(
    runtimeInput(dbLogger(), options),
    runtimeServices({}, logger(), options.services),
    options.host ?? runtimeHost(),
  );
}

function memory(content: string, id: number): BotMemory {
  return {
    id,
    botId: BOT_ID,
    telegramId: 42,
    content,
    category: null,
    kind: "preference",
    scopeChatId: null,
    origin: "agent",
    sourceChatId: null,
    sourceMessageId: null,
    sourceUserId: null,
    expiresAt: null,
    factValidAt: null,
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  embedders.created.length = 0;
});

describe("assembleBotRuntime", () => {
  it.each([
    ["no AI config", null],
    ["a disabled AI config", aiConfig({ enabled: false })],
    [
      "no decryptable Provider key",
      aiConfig({ providers: [chatProvider({ encryptedApiKey: null })] }),
    ],
  ])("leaves AI replies, conversation and selection off with %s", async (_case, stored) => {
    const runtime = await assemble({ aiConfig: stored });

    expect(runtime.config.aiReply).toBeUndefined();
    expect(runtime.config.conversation).toBeUndefined();
    expect(runtime.config.aiSelectionCallbacks).toBeUndefined();
    expect(runtime.embeddingService).toBeUndefined();
    expect(runtime.runInitialHistoryGovernance).toBeUndefined();
    expect(runtime.config.privacy).toBeDefined();
    expect(runtime.config.timerCallbacks).toBeDefined();
    expect(runtime.managerOptions.onGenerationTrack).toBeTypeOf("function");
  });

  it("assembles AI replies from the active Provider around one conversation", async () => {
    const host = runtimeHost({ isDelegatedGroupAdmin: vi.fn(async () => true) });
    const runtime = await assemble({ aiConfig: aiConfig(), host });
    const aiReply = runtime.config.aiReply;

    expect(aiReply).toMatchObject({
      botId: BOT_ID,
      apiKey: "chat-key",
      baseURL: "https://chat.example/v1",
      model: "chat-model",
      activeProviderId: "chat-provider",
    });
    expect(runtime.config.conversation).toBeDefined();
    expect(aiReply?.conversation).toBe(runtime.config.conversation);
    expect(runtime.runInitialHistoryGovernance).toBeTypeOf("function");
    await expect(aiReply?.isDelegatedGroupAdmin?.(-1001, 42)).resolves.toBe(true);
    expect(host.isDelegatedGroupAdmin).toHaveBeenCalledWith(BOT_ID, -1001, 42);
  });

  it("wires the MCP command and tools only when an MCP manager is attached", async () => {
    const mcpClientManager = {
      getStatus: vi.fn(() => []),
      getToolsForServers: vi.fn(() => []),
      callTool: vi.fn(async () => "ok"),
    } as unknown as McpClientManager;
    const stored = aiConfig({ mcpServerIds: [3] });

    const attached = await assemble({ aiConfig: stored, services: { mcpClientManager } });
    const detached = await assemble({ aiConfig: stored });

    expect(attached.config.mcpCallbacks).toBeDefined();
    attached.config.aiReply?.mcpTools?.getTools();
    await attached.config.aiReply?.mcpTools?.callTool(3, "search", { q: "tea" });
    expect(mcpClientManager.getToolsForServers).toHaveBeenCalledWith([3]);
    expect(mcpClientManager.callTool).toHaveBeenCalledWith(3, "search", { q: "tea" });
    expect(detached.config.mcpCallbacks).toBeUndefined();
    expect(detached.config.aiReply?.mcpTools).toBeUndefined();
  });

  it("claims the Harness port for this Bot only when a Harness service is attached", async () => {
    const port = { isHarnessChat: vi.fn(() => false) } as unknown as HarnessBotPort;
    const claimBot = vi.fn(() => port);
    const harnessService = { claimBot } as unknown as HarnessService;

    const claimed = await assemble({
      miniAppUrl: `https://example.test/mini-app/${BOT_ID}/help`,
      services: { harnessService },
    });
    const unclaimed = await assemble();

    expect(claimed.config.harness).toBe(port);
    expect(claimBot).toHaveBeenCalledExactlyOnceWith({
      id: BOT_ID,
      name: "Runtime Bot",
      miniApp: true,
    });
    expect(unclaimed.config.harness).toBeUndefined();
  });

  it("leaves the Harness unclaimed when assembly fails", async () => {
    const claimBot = vi.fn();
    const chatAiSelectionService = {
      loadRuntimeSnapshot: vi.fn(async () => {
        throw new Error("selection store unavailable");
      }),
    } as unknown as ChatAiSelectionPort;

    await expect(
      assemble({
        aiConfig: aiConfig(),
        services: {
          harnessService: { claimBot } as unknown as HarnessService,
          chatAiSelectionService,
        },
      }),
    ).rejects.toThrow("selection store unavailable");
    expect(claimBot).not.toHaveBeenCalled();
  });

  it("pins agent memory writes to the embedder created for this start", async () => {
    const services = runtimeServices({}, logger());
    const store = services.botMemoryStore;
    vi.spyOn(store, "findSimilar").mockResolvedValue([]);
    const saveMemory = vi
      .spyOn(store, "saveMemory")
      .mockImplementation(async (_botId, data) => memory(data.content, 8));
    const stored = aiConfig({
      botMemoryConfig: { enabled: true, maxMemories: 20, autoInjectMemories: true },
      embeddingConfig: embeddingConfig(),
    });

    const first = await assemble({ aiConfig: stored, services });
    const restarted = await assemble({ aiConfig: stored, services });
    await first.config.aiReply?.botMemory?.saveMemory({ content: "Likes tea", telegramId: 42 });

    expect(embedders.created).toHaveLength(2);
    expect(first.embeddingService).toBe(embedders.created[0]);
    expect(restarted.embeddingService).toBe(embedders.created[1]);
    expect(embedders.created[0]!.generateEmbedding).toHaveBeenCalledWith(
      "Likes tea",
      expect.any(AbortSignal),
    );
    expect(embedders.created[1]!.generateEmbedding).not.toHaveBeenCalled();
    expect(saveMemory).toHaveBeenCalledWith(BOT_ID, {
      content: "Likes tea",
      telegramId: 42,
      embedding: [9, 0],
    });
  });

  it("reaches BotPool only through the host port", async () => {
    const host = runtimeHost({
      restartBot: vi.fn(async () => {}),
      getActiveTimersForBot: vi.fn(() => []),
      cancelTimerForBot: vi.fn(async () => true),
      attachTimerHandlers: vi.fn(),
      replaceAiSelectionRuntime: vi.fn((_botId: string, register: () => () => void) => {
        register();
      }),
    });
    const snapshot: ChatAiSelectionRuntimeSnapshot = {
      revision: "r1",
      global: { providerId: "chat-provider", modelId: null },
      chats: new Map([[-1001, { providerId: "chat-provider", modelId: "chat-model" }]]),
    };
    const registry = new ChatAiSelectionRuntimeRegistry();
    const chatAiSelectionService = {
      loadRuntimeSnapshot: vi.fn(async () => snapshot),
    } as unknown as ChatAiSelectionPort;
    const runtime = await assemble({
      aiConfig: aiConfig(),
      services: { chatAiSelectionService, chatAiSelectionRuntimeRegistry: registry },
      host,
    });
    const handlers: BotTimerHandlers = {
      fireTimer: vi.fn(async () => true),
      cancelPendingTimer: vi.fn(),
    };
    const botSelection: BotAiSelectionRuntime = { applyAiSelectionSnapshot: vi.fn() };
    const projected = {
      global: { activeProviderId: "chat-provider", activeModelId: null },
      chats: { "-1001": { providerId: "chat-provider", modelId: "chat-model" } },
    };

    await runtime.config.onRestart?.();
    runtime.config.timerCallbacks?.onBotReady?.(handlers);
    runtime.config.timerCallbacks?.onGetTimers?.();
    await runtime.config.timerCallbacks?.onCancelTimer?.("timer-1");
    runtime.config.aiSelectionCallbacks?.onBotReady?.(botSelection);
    await registry.publish(BOT_ID, snapshot);

    expect(host.restartBot).toHaveBeenCalledWith(BOT_ID);
    expect(host.attachTimerHandlers).toHaveBeenCalledWith(BOT_ID, handlers);
    expect(host.getActiveTimersForBot).toHaveBeenCalledWith(BOT_ID);
    expect(host.cancelTimerForBot).toHaveBeenCalledWith(BOT_ID, "timer-1");
    expect(host.replaceAiSelectionRuntime).toHaveBeenCalledWith(BOT_ID, expect.any(Function));
    expect(runtime.config.aiReply?.aiSelectionSnapshot).toEqual(projected);
    expect(botSelection.applyAiSelectionSnapshot).toHaveBeenCalledWith(projected);
  });

  it("passes the image receipt config to BotManager even with AI replies off", async () => {
    const imageGenerationReceiptConfig = { promptPreviewLength: 80, albumNoticeEnabled: false };

    const runtime = await assemble({
      aiConfig: aiConfig({ enabled: false, imageGenerationReceiptConfig }),
    });

    expect(runtime.config.aiReply).toBeUndefined();
    expect(runtime.managerOptions.imageGenerationReceiptConfig).toEqual(
      imageGenerationReceiptConfig,
    );
  });

  it("maps backup outcomes for /backup and leaves it unset without a backup service", async () => {
    const createBackup = vi
      .fn()
      .mockResolvedValueOnce({ filename: "backup-1.sql.gz" })
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce("storage offline");
    const runtime = await assemble({
      services: { backupService: { createBackup } as unknown as BackupService },
    });

    await expect(runtime.config.onBackup?.()).resolves.toEqual({
      ok: true,
      filename: "backup-1.sql.gz",
    });
    await expect(runtime.config.onBackup?.()).resolves.toEqual({ ok: false, error: "disk full" });
    await expect(runtime.config.onBackup?.()).resolves.toEqual({
      ok: false,
      error: "storage offline",
    });
    expect((await assemble()).config.onBackup).toBeUndefined();
  });

  it("records token usage for this Bot and only logs a failed write", async () => {
    const values = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("database unavailable"));
    const log = logger();
    const runtime = await assembleBotRuntime(
      runtimeInput(dbLogger()),
      runtimeServices({ insert: vi.fn(() => ({ values })) }, log),
      runtimeHost(),
    );
    const entry = {
      chatId: -1001,
      model: "chat-model",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };

    await runtime.config.onTokenUsage?.(entry);
    await expect(runtime.config.onTokenUsage?.(entry)).resolves.toBeUndefined();

    expect(values).toHaveBeenNthCalledWith(1, { botId: BOT_ID, ...entry });
    expect(values).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      expect.any(Error),
      "Failed to write token usage",
    );
  });
});
