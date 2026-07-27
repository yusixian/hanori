import type { AiConfigStored, AiGroupOverride } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildChatIdentityMigrationPlan,
  ChatIdentityMigrationService,
  type ChatIdentityMigrationRepository,
  type ChatIdentityMigrationSnapshot,
  type ChatIdentityMigrationTransaction,
} from "./chat-identity-migration-service.js";

const BOT_ID = "00000000-0000-4000-8000-000000000017";
const OTHER_BOT_ID = "0ad0459e-f851-4e3e-b84d-a43d42edbce8";
const OLD_CHAT_ID = -300;
const NEW_CHAT_ID = -1_003_003_003;
const OBSERVED_AT = 1_700_000_100;

function aiConfig(groupOverrides: Record<string, AiGroupOverride>): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "",
    systemPrompt: "",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 0,
    },
    groupOverrides,
  };
}

function snapshot(
  overrides: Partial<ChatIdentityMigrationSnapshot> = {},
): ChatIdentityMigrationSnapshot {
  return {
    lineageApplied: false,
    oldChatGrant: false,
    newChatGrant: false,
    oldSummaryConfig: false,
    newSummaryConfig: false,
    oldModelOverride: false,
    newModelOverride: false,
    oldProviderOverride: false,
    newProviderOverride: false,
    groupOverrides: {},
    rssCollectionIds: [],
    timerIds: [],
    ...overrides,
  };
}

function transactionMock(
  options: {
    config?: AiConfigStored | null;
    snapshots?: ChatIdentityMigrationSnapshot[];
    lineages?: Array<{ migratedToChatId: number | null; leftAt: Date | null }>;
  } = {},
) {
  const snapshots = options.snapshots ?? [snapshot()];
  const lineages = options.lineages ?? [{ migratedToChatId: null, leftAt: null }];
  const tx = {
    lockBot: vi.fn(async () => ({ aiConfig: options.config ?? null })),
    ensureChat: vi.fn(async () => undefined),
    getChatLineage: vi.fn(async () => lineages.shift() ?? null),
    readSnapshot: vi.fn(async () => snapshots.shift() ?? snapshot({ lineageApplied: true })),
    applySingleton: vi.fn(async () => undefined),
    updateGroupOverrides: vi.fn(async () => undefined),
    moveRssCollections: vi.fn(async () => undefined),
    moveTimers: vi.fn(async () => undefined),
    markLineage: vi.fn(async () => undefined),
    writeAudit: vi.fn(async () => undefined),
  } as unknown as ChatIdentityMigrationTransaction;
  const transaction = vi.fn(
    async (operation: (transaction: ChatIdentityMigrationTransaction) => Promise<unknown>) =>
      operation(tx),
  );
  const repository = { transaction } as unknown as ChatIdentityMigrationRepository;
  return { tx, repository, transaction };
}

const migrationInput = {
  botId: BOT_ID,
  oldChatId: OLD_CHAT_ID,
  newChatId: NEW_CHAT_ID,
  observedAt: OBSERVED_AT,
};

describe("buildChatIdentityMigrationPlan", () => {
  it("keeps every target singleton and reports the discarded old rows as conflicts", () => {
    const oldOverride = { chatId: OLD_CHAT_ID, whitelisted: true, systemPrompt: "old" };
    const targetOverride = { chatId: NEW_CHAT_ID, whitelisted: false, systemPrompt: "target" };
    const plan = buildChatIdentityMigrationPlan(
      OLD_CHAT_ID,
      NEW_CHAT_ID,
      snapshot({
        oldChatGrant: true,
        newChatGrant: true,
        oldSummaryConfig: true,
        newSummaryConfig: true,
        oldModelOverride: true,
        newModelOverride: true,
        oldProviderOverride: true,
        newProviderOverride: true,
        groupOverrides: {
          [String(OLD_CHAT_ID)]: oldOverride,
          [String(NEW_CHAT_ID)]: targetOverride,
        },
      }),
    );

    expect(plan).toMatchObject({
      chatGrant: "drop-old",
      groupOverride: "drop-old",
      summaryConfig: "drop-old",
      modelOverride: "drop-old",
      providerOverride: "drop-old",
      conflicts: {
        chat_grant: 1,
        group_override: 1,
        summary_config: 1,
        model_override: 1,
        provider_override: 1,
      },
    });
    expect(plan.nextGroupOverrides).toEqual({ [String(NEW_CHAT_ID)]: targetOverride });
  });

  it("moves the complete JSON group override to the new key and rewrites its embedded chat ID", () => {
    const oldOverride: AiGroupOverride = {
      chatId: OLD_CHAT_ID,
      chatTitle: "legacy group",
      enabled: false,
      whitelisted: true,
      systemPrompt: "preserve me",
      triggerConfig: { mentionBot: false },
      conversationEnabled: true,
      maxContextMessages: 88,
      groupHistoryMaxTokens: 4096,
      imageGenerationEnabled: true,
    };
    const unrelated = { chatId: -999, whitelisted: false };
    const plan = buildChatIdentityMigrationPlan(
      OLD_CHAT_ID,
      NEW_CHAT_ID,
      snapshot({
        lineageApplied: true,
        groupOverrides: { [String(OLD_CHAT_ID)]: oldOverride, "-999": unrelated },
      }),
    );

    expect(plan.groupOverride).toBe("move");
    expect(plan.nextGroupOverrides).toEqual({
      [String(NEW_CHAT_ID)]: { ...oldOverride, chatId: NEW_CHAT_ID },
      "-999": unrelated,
    });
    expect(plan.nextGroupOverrides).not.toHaveProperty(String(OLD_CHAT_ID));
  });
});

describe("ChatIdentityMigrationService", () => {
  it("rejects non-group, unsafe, equal, or non-date migration inputs before a transaction", async () => {
    const { repository, transaction } = transactionMock();
    const service = new ChatIdentityMigrationService(repository);

    for (const invalid of [
      { ...migrationInput, botId: "not-a-uuid" },
      { ...migrationInput, oldChatId: 300 },
      { ...migrationInput, newChatId: Number.MIN_SAFE_INTEGER - 1 },
      { ...migrationInput, newChatId: OLD_CHAT_ID },
      { ...migrationInput, observedAt: Number.MAX_SAFE_INTEGER },
    ]) {
      await expect(service.migrate(invalid)).rejects.toMatchObject({
        name: "ChatIdentityMigrationError",
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("ensures the target first, applies target-wins, and audits only safe counts and IDs", async () => {
    const targetOverride = { chatId: NEW_CHAT_ID, whitelisted: false };
    const config = aiConfig({
      [String(OLD_CHAT_ID)]: { chatId: OLD_CHAT_ID, whitelisted: true },
      [String(NEW_CHAT_ID)]: targetOverride,
    });
    const { tx, repository } = transactionMock({
      config,
      snapshots: [
        snapshot({
          oldChatGrant: true,
          newChatGrant: true,
          oldSummaryConfig: true,
          newSummaryConfig: true,
          oldModelOverride: true,
          newModelOverride: true,
          oldProviderOverride: true,
          newProviderOverride: true,
          groupOverrides: config.groupOverrides,
          rssCollectionIds: [11, 12],
          timerIds: ["timer-a"],
        }),
      ],
    });

    const result = await new ChatIdentityMigrationService(repository).migrate(migrationInput);

    expect(result.changed).toBe(true);
    expect(tx.ensureChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ botId: BOT_ID, chatId: NEW_CHAT_ID, type: "supergroup" }),
    );
    expect(tx.ensureChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: BOT_ID, chatId: OLD_CHAT_ID, type: "group" }),
    );
    for (const kind of ["chat_grant", "summary_config", "model_override", "provider_override"]) {
      expect(tx.applySingleton).toHaveBeenCalledWith(kind, expect.anything(), "drop-old");
    }
    expect(tx.updateGroupOverrides).toHaveBeenCalledWith(BOT_ID, config, {
      [String(NEW_CHAT_ID)]: targetOverride,
    });
    const audit = vi.mocked(tx.writeAudit).mock.calls[0]![0];
    expect(Object.keys(audit).sort()).toEqual([
      "botId",
      "conflicts",
      "moved",
      "newChatId",
      "oldChatId",
      "resourceKinds",
      "rssCollectionIds",
      "timerIds",
    ]);
    expect(audit).toMatchObject({
      botId: BOT_ID,
      oldChatId: OLD_CHAT_ID,
      newChatId: NEW_CHAT_ID,
      moved: { chat_lineage: 1, rss_collection: 2, timer: 1 },
      rssCollectionIds: [11, 12],
      timerIds: ["timer-a"],
      conflicts: {
        chat_grant: 1,
        group_override: 1,
        summary_config: 1,
        model_override: 1,
        provider_override: 1,
      },
    });
    expect(vi.mocked(tx.markLineage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(tx.writeAudit).mock.invocationCallOrder[0]!,
    );
  });

  it("scopes every read and mutation to the selected Bot", async () => {
    const { tx, repository } = transactionMock({
      config: aiConfig({ [String(OLD_CHAT_ID)]: { chatId: OLD_CHAT_ID, whitelisted: true } }),
      snapshots: [
        snapshot({
          oldChatGrant: true,
          oldSummaryConfig: true,
          oldModelOverride: true,
          oldProviderOverride: true,
          groupOverrides: {
            [String(OLD_CHAT_ID)]: { chatId: OLD_CHAT_ID, whitelisted: true },
          },
          rssCollectionIds: [1],
          timerIds: ["timer-a"],
        }),
      ],
    });

    await new ChatIdentityMigrationService(repository).migrate(migrationInput);

    expect(tx.lockBot).toHaveBeenCalledWith(BOT_ID);
    expect(tx.getChatLineage).toHaveBeenCalledWith(BOT_ID, OLD_CHAT_ID);
    for (const call of vi.mocked(tx.ensureChat).mock.calls) expect(call[0].botId).toBe(BOT_ID);
    for (const call of vi.mocked(tx.applySingleton).mock.calls) {
      expect(call[1]).toMatchObject({ botId: BOT_ID });
      expect(call[1].botId).not.toBe(OTHER_BOT_ID);
    }
    expect(tx.readSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID }),
      expect.anything(),
    );
    expect(tx.moveRssCollections).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_ID }));
    expect(tx.moveTimers).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_ID }));
    expect(tx.markLineage).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_ID }));
    expect(tx.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_ID }));
  });

  it("is idempotent on replay and does not write a second audit", async () => {
    const { tx, repository, transaction } = transactionMock({
      snapshots: [snapshot(), snapshot({ lineageApplied: true })],
      lineages: [
        { migratedToChatId: null, leftAt: null },
        { migratedToChatId: NEW_CHAT_ID, leftAt: new Date(OBSERVED_AT * 1000) },
      ],
    });
    const service = new ChatIdentityMigrationService(repository);

    await expect(service.migrate(migrationInput)).resolves.toMatchObject({ changed: true });
    await expect(service.migrate(migrationInput)).resolves.toEqual({
      changed: false,
      moved: {},
      conflicts: {},
      resourceKinds: [],
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.markLineage).toHaveBeenCalledTimes(1);
    expect(tx.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("keeps the audit in the same transaction and never reaches it after a failed mutation", async () => {
    const { tx, repository, transaction } = transactionMock({
      snapshots: [snapshot({ timerIds: ["timer-a"] })],
    });
    vi.mocked(tx.moveTimers).mockRejectedValueOnce(new Error("write failed"));

    await expect(
      new ChatIdentityMigrationService(repository).migrate(migrationInput),
    ).rejects.toThrow("write failed");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.writeAudit).not.toHaveBeenCalled();
  });
});
