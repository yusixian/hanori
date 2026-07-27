import type { Database } from "@cos-tool-bot/database";
import { miniAppAuditEvents, miniAppOperatorGrants, peopleProfiles } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { MiniAppAccessError, MiniAppAccessService } from "./mini-app-access-service.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function queryReturning<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const builder = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
  };
  return builder;
}

function queryReturningAtWhere<T>(rows: T[]) {
  const where = vi.fn(async () => rows);
  return { from: vi.fn(() => ({ where })) };
}

describe("MiniAppAccessService", () => {
  it("searches and returns only the safe people profile projection", async () => {
    const query = queryReturning([
      {
        telegramUserId: 42,
        username: "ada",
        displayName: "Ada",
        lastSeen: new Date("2026-07-27T00:00:00.000Z"),
      },
    ]);
    const select = vi.fn((_selection: Record<string, unknown>) => query);
    const service = new MiniAppAccessService({ select } as unknown as Database, {
      getBotMembership: vi.fn(),
    });

    await expect(service.searchPeople(BOT_ID, " @ada ")).resolves.toEqual([
      {
        telegramUserId: 42,
        username: "ada",
        displayName: "Ada",
        lastSeen: "2026-07-27T00:00:00.000Z",
      },
    ]);
    expect(Object.keys(select.mock.calls[0]![0] as object).sort()).toEqual([
      "displayName",
      "lastSeen",
      "telegramUserId",
      "username",
    ]);
  });

  it("fails closed before creating a chat grant when the Bot is not an administrator", async () => {
    const select = vi.fn(() => queryReturningAtWhere([{ chatId: -1001 }]));
    const transaction = vi.fn();
    const getBotMembership = vi.fn(async () => "member" as const);
    const service = new MiniAppAccessService({ select, transaction } as unknown as Database, {
      getBotMembership,
    });

    await expect(
      service.grantChat({
        botId: BOT_ID,
        actorTelegramUserId: 42,
        chatId: -1001,
        note: null,
      }),
    ).rejects.toMatchObject({ code: "bot_admin_required" } satisfies Partial<MiniAppAccessError>);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates an operator grant and its redacted audit inside one transaction", async () => {
    const grantValues = vi.fn();
    const auditValues = vi.fn(async () => []);
    const tx = {
      insert: vi.fn((table: unknown) => {
        if (table === miniAppOperatorGrants) {
          return {
            values: (value: unknown) => {
              grantValues(value);
              return {
                onConflictDoNothing: () => ({
                  returning: async () => [{ telegramUserId: 73 }],
                }),
              };
            },
          };
        }
        if (table === miniAppAuditEvents) return { values: auditValues };
        throw new Error("Unexpected insert table");
      }),
      select: vi.fn((selection: unknown) => {
        expect(selection).toEqual({ telegramUserId: peopleProfiles.telegramId });
        return queryReturningAtWhere([{ telegramUserId: 73 }]);
      }),
    };
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<void>) =>
      callback(tx),
    );
    const now = new Date("2026-07-27T01:00:00.000Z");
    const service = new MiniAppAccessService(
      { transaction } as unknown as Database,
      { getBotMembership: vi.fn() },
      () => now,
    );

    await service.grantOperator({
      botId: BOT_ID,
      actorTelegramUserId: 42,
      telegramUserId: 73,
      note: "trusted helper",
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(grantValues).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID, telegramUserId: 73, note: "trusted helper" }),
    );
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "access.operator-grant.created",
        capability: "access.manage",
        resourceId: "73",
        nextSummary: { profileVerified: true, hasNote: true },
      }),
    );
    expect(JSON.stringify(auditValues.mock.calls)).not.toContain("trusted helper");
  });
});
