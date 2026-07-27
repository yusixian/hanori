import type { Database } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  GroupConfigService,
  mergeGroupOverride,
  projectGroupConfig,
} from "./group-config-service.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function transactionResult(
  revision: string,
  options: { runtimeRelevant: boolean; enabled: boolean },
) {
  return {
    override: { chatId: -1001, whitelisted: true, enabled: options.enabled },
    runtimeRelevant: options.runtimeRelevant,
    group: {
      chatId: -1001,
      type: "supergroup" as const,
      title: "Build Room",
      username: null,
      botMembershipStatus: "administrator",
      membershipObservedAt: null,
      lastObservedAt: "2026-07-27T00:00:00.000Z",
      archived: false,
      config: {
        revision,
        aiConfigured: true,
        group: {
          enabled: options.enabled,
          whitelisted: true,
          trigger: {
            replyToBot: true,
            mentionBot: true,
            triggerWords: [],
            randomReplyPercent: 0,
            randomReplyCooldown: 0,
          },
          conversation: {
            enabled: true,
            maxContextMessages: 20,
            groupHistoryMaxTokens: 12_000,
          },
        },
        summary: {
          enabled: false,
          scheduleHour: null,
          scheduleMinute: null,
          timezone: "UTC",
          windowHours: 24,
          maxMessages: 2_000,
          cooldownSeconds: 300,
        },
      },
      applyState: "applied" as const,
    },
  };
}

function serialBotLock() {
  let tail = Promise.resolve();
  return async <T>(_botId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

describe("mergeGroupOverride", () => {
  it("patches allowed fields while preserving prompt, tools, and unrelated concurrent fields", () => {
    const merged = mergeGroupOverride(
      {
        chatId: -1001,
        chatTitle: "Build Room",
        enabled: true,
        whitelisted: false,
        systemPrompt: "private prompt",
        imageGenerationEnabled: true,
        triggerConfig: { mentionBot: true, replyToBot: true },
        maxContextMessages: 20,
      },
      -1001,
      {
        enabled: false,
        trigger: { mentionBot: false },
        conversation: { maxContextMessages: 40 },
      },
    );

    expect(merged).toEqual({
      chatId: -1001,
      chatTitle: "Build Room",
      enabled: false,
      whitelisted: false,
      systemPrompt: "private prompt",
      imageGenerationEnabled: true,
      triggerConfig: { mentionBot: false, replyToBot: true },
      maxContextMessages: 40,
    });
  });
});

describe("projectGroupConfig", () => {
  it("returns only editable safe fields and reports whether AI is configured", () => {
    const aiConfig: AiConfigStored = {
      enabled: true,
      encryptedApiKey: "encrypted-secret",
      baseURL: "https://private-provider.example",
      model: "private-model",
      systemPrompt: "private global prompt",
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: ["hi"],
        randomReplyPercent: 5,
        randomReplyCooldown: 60,
      },
      groupOverrides: {
        "-1001": {
          chatId: -1001,
          whitelisted: true,
          systemPrompt: "private group prompt",
          imageGenerationEnabled: true,
        },
      },
    };

    const projected = projectGroupConfig(
      { aiConfig, updatedAt: new Date("2026-07-27T00:00:00.000Z") },
      -1001,
      undefined,
    );

    expect(projected).toMatchObject({
      aiConfigured: true,
      group: { whitelisted: true },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /encrypted-secret|private-provider|private-model|private global prompt|private group prompt|imageGenerationEnabled/,
    );
    expect(
      projectGroupConfig({ aiConfig: null, updatedAt: null }, -1001, undefined).aiConfigured,
    ).toBe(false);
  });
});

describe("GroupConfigService persistence boundary", () => {
  it("never publishes runtime state when the database transaction fails", async () => {
    const dbError = new Error("database unavailable");
    const transaction = vi.fn(async () => {
      throw dbError;
    });
    const applyGroupOverride = vi.fn(async () => {});
    const lockCalls: string[] = [];
    const withBotLock = async <T>(botId: string, operation: () => Promise<T>): Promise<T> => {
      lockCalls.push(botId);
      return operation();
    };
    const service = new GroupConfigService(
      { transaction } as unknown as Database,
      { applyGroupOverride },
      withBotLock,
    );

    await expect(
      service.patch({
        botId: BOT_ID,
        chatId: -1001,
        actorTelegramUserId: 42,
        actorRole: "operator",
        expectedRevision: "rev-1",
        patch: { group: { enabled: false } },
      }),
    ).rejects.toBe(dbError);
    expect(lockCalls).toEqual([BOT_ID]);
    expect(applyGroupOverride).not.toHaveBeenCalled();
  });

  it("serializes commit and runtime apply so an older request cannot overwrite a newer one", async () => {
    const results = [
      transactionResult("rev-1", { runtimeRelevant: true, enabled: false }),
      transactionResult("rev-2", { runtimeRelevant: true, enabled: true }),
    ];
    const transaction = vi.fn(async () => results.shift()!);
    let releaseFirstApply = () => {};
    const firstApplyBlocked = new Promise<void>((resolve) => {
      releaseFirstApply = resolve;
    });
    const applied: boolean[] = [];
    const applyGroupOverride = vi.fn(async ({ override }: { override: { enabled?: boolean } }) => {
      applied.push(override.enabled ?? true);
      if (applied.length === 1) await firstApplyBlocked;
    });
    const service = new GroupConfigService(
      { transaction } as unknown as Database,
      { applyGroupOverride } as never,
      serialBotLock(),
    );
    const input = {
      botId: BOT_ID,
      chatId: -1001,
      actorTelegramUserId: 42,
      actorRole: "operator" as const,
      expectedRevision: "rev-0",
    };

    const first = service.patch({ ...input, patch: { group: { enabled: false } } });
    await vi.waitFor(() => expect(applyGroupOverride).toHaveBeenCalledTimes(1));
    const second = service.patch({ ...input, patch: { group: { enabled: true } } });
    await Promise.resolve();
    expect(transaction).toHaveBeenCalledTimes(1);

    releaseFirstApply();
    await Promise.all([first, second]);
    expect(applied).toEqual([false, true]);
  });

  it("keeps a failed group apply pending across a later summary-only save", async () => {
    const results = [
      transactionResult("rev-1", { runtimeRelevant: true, enabled: false }),
      transactionResult("rev-2", { runtimeRelevant: false, enabled: false }),
    ];
    const transaction = vi.fn(async () => results.shift()!);
    const service = new GroupConfigService(
      { transaction } as unknown as Database,
      { applyGroupOverride: vi.fn(async () => Promise.reject(new Error("runtime offline"))) },
      serialBotLock(),
    );
    const input = {
      botId: BOT_ID,
      chatId: -1001,
      actorTelegramUserId: 42,
      actorRole: "operator" as const,
      expectedRevision: "rev-0",
    };

    await expect(
      service.patch({ ...input, patch: { group: { enabled: false } } }),
    ).resolves.toMatchObject({ applied: false, group: { applyState: "pending" } });
    await expect(
      service.patch({ ...input, patch: { summary: { enabled: true } } }),
    ).resolves.toMatchObject({ applied: true, group: { applyState: "pending" } });
  });
});
