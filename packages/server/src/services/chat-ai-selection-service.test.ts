import type { Database } from "@cos-tool-bot/database";
import { bots, chatAiSelections, miniAppAuditEvents, telegramChats } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import {
  ChatAiSelectionError,
  ChatAiSelectionService,
  listUsableAiSelectionOptions,
  validateAiSelectionPair,
} from "./chat-ai-selection-service.js";
import { ChatAiSelectionRuntimeRegistry } from "./chat-ai-selection-runtime-registry.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_BOT_ID = "00000000-0000-4000-8000-000000000002";
const KEY = "test-encryption-key";

function config(): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "a-default",
    providers: [
      {
        id: "provider-a",
        label: "Provider A",
        encryptedApiKey: encrypt("secret-a", KEY),
        baseURL: "https://a.invalid",
        providerFormat: "openai",
        defaultModel: "a-default",
        models: [{ id: "a-fast", label: "A Fast" }],
      },
      {
        id: "provider-b",
        label: "Provider B",
        encryptedApiKey: encrypt("secret-b", KEY),
        baseURL: "https://b.invalid",
        providerFormat: "openai",
        defaultModel: "b-default",
        models: [{ id: "b-fast" }],
      },
      {
        id: "broken",
        label: "Broken",
        encryptedApiKey: "not-ciphertext",
        baseURL: "https://broken.invalid",
        providerFormat: "openai",
        defaultModel: "broken-default",
      },
    ],
    activeProviderId: "provider-a",
    activeModelId: "a-fast",
    systemPrompt: "system",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 0,
    },
    groupOverrides: {},
  };
}

function collectPrimitiveValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Date) return [value];
  return Object.values(value).flatMap((entry) => collectPrimitiveValues(entry, seen));
}

function createSelectionDatabase() {
  const updatedAt = new Date("2026-07-28T00:00:00.000Z");
  const botRows = new Map([
    [BOT_ID, { aiConfig: config(), updatedAt }],
    [OTHER_BOT_ID, { aiConfig: config(), updatedAt }],
  ]);
  const selectionRows = new Map<
    string,
    {
      botId: string;
      chatId: number;
      providerId: string;
      modelId: string | null;
      revision: number;
      updatedByKind: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >([
    [
      `${OTHER_BOT_ID}:42`,
      {
        botId: OTHER_BOT_ID,
        chatId: 42,
        providerId: "provider-a",
        modelId: "a-fast",
        revision: 7,
        updatedByKind: null,
        updatedById: null,
        createdAt: updatedAt,
        updatedAt,
      },
    ],
  ]);
  let telegramChatReads = 0;

  function rowsFor(table: unknown, condition: unknown) {
    const values = collectPrimitiveValues(condition);
    const botId = [...botRows.keys()].find((candidate) => values.includes(candidate));
    if (table === bots) return botId ? [botRows.get(botId)!] : [];
    if (table === telegramChats) {
      telegramChatReads += 1;
      return [];
    }
    if (table === chatAiSelections) {
      const rows = [...selectionRows.values()].filter((row) => row.botId === botId);
      return values.includes(42) ? rows.filter((row) => row.chatId === 42) : rows;
    }
    throw new Error("Unexpected select table");
  }

  function queryResult(rows: unknown[]) {
    return Object.assign(Promise.resolve(rows), { for: async () => rows });
  }

  const database = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => queryResult(rowsFor(table, condition)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (input: Record<string, unknown>) => {
        if (table === miniAppAuditEvents) return Promise.resolve([]);
        if (table !== chatAiSelections) throw new Error("Unexpected insert table");
        return {
          onConflictDoUpdate: async () => {
            const key = `${String(input.botId)}:${String(input.chatId)}`;
            const previous = selectionRows.get(key);
            selectionRows.set(key, {
              botId: input.botId as string,
              chatId: input.chatId as number,
              providerId: input.providerId as string,
              modelId: input.modelId as string | null,
              revision: input.revision as number,
              updatedByKind: input.updatedByKind as string,
              updatedById: input.updatedById as string,
              createdAt: previous?.createdAt ?? updatedAt,
              updatedAt: input.updatedAt as Date,
            });
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        if (table !== chatAiSelections) throw new Error("Unexpected delete table");
        const values = collectPrimitiveValues(condition);
        const botId = [...botRows.keys()].find((candidate) => values.includes(candidate));
        if (botId && values.includes(42)) selectionRows.delete(`${botId}:42`);
      },
    }),
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
  };

  return {
    db: database as unknown as Database,
    selectionRows,
    telegramChatReads: () => telegramChatReads,
  };
}

describe("AI selection validation", () => {
  it("returns only credential-usable providers and safe catalog metadata", () => {
    const serialized = JSON.stringify(listUsableAiSelectionOptions(config(), KEY));
    expect(serialized).toContain("Provider A");
    expect(serialized).toContain("a-default");
    expect(serialized).not.toMatch(/secret-a|https:\/\/a\.invalid|not-ciphertext|Broken/);
  });

  it("rejects a model from another Provider", () => {
    const options = listUsableAiSelectionOptions(config(), KEY);
    expect(() =>
      validateAiSelectionPair(options, { providerId: "provider-a", modelId: "b-fast" }),
    ).toThrowError(
      expect.objectContaining<Partial<ChatAiSelectionError>>({ code: "model_unavailable" }),
    );
  });

  it("accepts null as the selected Provider default without inventing an arbitrary model", () => {
    const options = listUsableAiSelectionOptions(config(), KEY);
    expect(validateAiSelectionPair(options, { providerId: "provider-b", modelId: null })).toEqual({
      providerId: "provider-b",
      modelId: null,
    });
  });
});

describe("ChatAiSelectionService persistence boundary", () => {
  it("never publishes when the database transaction fails", async () => {
    const failure = new Error("database unavailable");
    const db = { transaction: vi.fn(async () => Promise.reject(failure)) } as unknown as Database;
    const runtime = new ChatAiSelectionRuntimeRegistry();
    const publish = vi.spyOn(runtime, "publish");
    const service = new ChatAiSelectionService(db, KEY, runtime, async (_botId, operation) =>
      operation(),
    );

    await expect(
      service.setChat({
        botId: BOT_ID,
        chatId: -1001,
        expectedRevision: "rev",
        pair: { providerId: "provider-a", modelId: "a-fast" },
        actor: { kind: "telegram_user", id: "42" },
      }),
    ).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
  });

  it("resolves, writes, and resets private selections without entering the group directory", async () => {
    const { db, selectionRows, telegramChatReads } = createSelectionDatabase();
    const service = new ChatAiSelectionService(
      db,
      KEY,
      new ChatAiSelectionRuntimeRegistry(),
      async (_botId, operation) => operation(),
      () => new Date("2026-07-28T01:00:00.000Z"),
    );

    await expect(service.readChat(BOT_ID, 42, true)).rejects.toMatchObject({ code: "not_found" });

    await service.setProviderFromTelegram(BOT_ID, 42, "provider-b", 42);
    expect(selectionRows.get(`${BOT_ID}:42`)).toMatchObject({
      providerId: "provider-b",
      modelId: null,
    });

    await service.setModelFromTelegram(BOT_ID, 42, "b-fast", 42);
    expect(selectionRows.get(`${BOT_ID}:42`)).toMatchObject({
      providerId: "provider-b",
      modelId: "b-fast",
    });

    await service.resetModelFromTelegram(BOT_ID, 42, 42);
    expect(selectionRows.get(`${BOT_ID}:42`)).toMatchObject({
      providerId: "provider-b",
      modelId: null,
    });
    expect(selectionRows.get(`${OTHER_BOT_ID}:42`)).toMatchObject({
      providerId: "provider-a",
      modelId: "a-fast",
      revision: 7,
    });

    await service.resetProviderFromTelegram(BOT_ID, 42, 42);
    expect(selectionRows.has(`${BOT_ID}:42`)).toBe(false);
    expect(selectionRows.has(`${OTHER_BOT_ID}:42`)).toBe(true);
    expect(telegramChatReads()).toBe(0);
  });
});
