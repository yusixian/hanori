import type { Database } from "@cos-tool-bot/database";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { BotSettingsError, BotSettingsService } from "./bot-settings-service.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const UPDATED_AT = new Date("2026-07-28T00:00:00.000Z");

function config(): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "model-a",
    systemPrompt: "before",
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

function database(options: { failTransaction?: Error } = {}) {
  const row: { aiConfig: AiConfigStored; updatedAt: Date } = {
    aiConfig: config(),
    updatedAt: UPDATED_AT,
  };
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: async () => [row] }),
      }),
    }),
    update: () => ({
      set: (values: Partial<typeof row>) => ({
        where: async () => Object.assign(row, values),
      }),
    }),
    insert: () => ({ values: async (values: Record<string, unknown>) => audits.push(values) }),
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) => {
      if (options.failTransaction) throw options.failTransaction;
      return operation(tx);
    },
  } as unknown as Database;
  return { db, row, audits };
}

describe("BotSettingsService", () => {
  it("commits safe settings and releases the AI lock before restarting", async () => {
    const events: string[] = [];
    const { db, row, audits } = database();
    const lifecycle = {
      read: vi.fn(async () => ({
        desiredActive: true,
        runtimeStatus: "running" as const,
        reconciled: true,
      })),
      restart: vi.fn(async () => {
        events.push("restart");
        return {
          desiredActive: true,
          runtimeStatus: "running" as const,
          reconciled: true,
          persisted: true as const,
          applied: true,
        };
      }),
    };
    const service = new BotSettingsService(
      db,
      lifecycle,
      async (_botId, operation) => {
        events.push("lock:begin");
        const result = await operation();
        events.push("lock:end");
        return result;
      },
      () => UPDATED_AT,
    );

    const result = await service.patch({
      botId: BOT_ID,
      expectedRevision: UPDATED_AT.toISOString(),
      patch: { enabled: false, systemPrompt: "after" },
      actor: { kind: "telegram_user", id: "42" },
    });

    expect(result).toMatchObject({ persisted: true, applied: true, applyState: "applied" });
    expect(events).toEqual(["lock:begin", "lock:end", "restart"]);
    expect(row.aiConfig).toMatchObject({ enabled: false, systemPrompt: "after" });
    expect(audits[0]).toMatchObject({
      capability: "bot.settings.write",
      nextSummary: { aiEnabled: false, systemPromptChanged: true },
    });
    expect(JSON.stringify(audits[0])).not.toContain("after");
  });

  it("does not restart when persistence fails", async () => {
    const { db } = database({ failTransaction: new Error("secret database detail") });
    const restart = vi.fn();
    const service = new BotSettingsService(
      db,
      { read: vi.fn(), restart },
      async (_botId, operation) => operation(),
    );

    const operation = service.patch({
      botId: BOT_ID,
      expectedRevision: UPDATED_AT.toISOString(),
      patch: { enabled: false },
      actor: { kind: "telegram_user", id: "42" },
    });
    await expect(operation).rejects.toMatchObject({
      code: "persistence_failed",
    } satisfies Partial<BotSettingsError>);
    await expect(operation).rejects.not.toThrow("secret database detail");
    expect(restart).not.toHaveBeenCalled();
  });

  it("keeps persisted settings pending when runtime restart fails", async () => {
    const { db } = database();
    const service = new BotSettingsService(
      db,
      {
        read: vi.fn(async () => ({
          desiredActive: true,
          runtimeStatus: "running" as const,
          reconciled: true,
        })),
        restart: vi.fn(async () => Promise.reject(new Error("runtime secret"))),
      },
      async (_botId, operation) => operation(),
    );

    await expect(
      service.patch({
        botId: BOT_ID,
        expectedRevision: UPDATED_AT.toISOString(),
        patch: { systemPrompt: "after" },
        actor: { kind: "telegram_user", id: "42" },
      }),
    ).resolves.toMatchObject({
      persisted: true,
      applied: false,
      applyState: "pending",
      errorCode: "restart_failed",
    });
  });
});
