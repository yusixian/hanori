import type { Database } from "@cos-tool-bot/database";
import {
  conversationMessages,
  memoryConsolidationState,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import type { UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidator } from "./memory-consolidator.js";

const botId = "11111111-1111-4111-8111-111111111111";
const old = new Date("2026-01-01T00:00:00.000Z");

function source(id: number, userId: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    botId,
    chatId: -100,
    role: "user",
    userId,
    userAuthoredContent: `Message ${id}`,
    sourceKey: `telegram:${id}:user`,
    meta: { turnState: "complete" },
    createdAt: old,
    ...overrides,
  };
}

function previewWithWindows(
  windows: Record<number, unknown>[][],
  privacy: Record<string, unknown>[],
) {
  let windowIndex = 0;
  const insert = vi.fn();
  const update = vi.fn();
  const transaction = vi.fn();
  const refreshEmbeddings = vi.fn();
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === memoryConsolidationState)
          return { where: async () => [{ cursorMessageId: 0 }] };
        if (table === userPrivacySettings) return { where: async () => privacy };
        if (table === conversationMessages)
          return {
            where: () => ({
              orderBy: () => ({ limit: async () => windows[windowIndex++] ?? [] }),
            }),
          };
        throw new Error("Unexpected table read");
      },
    }),
    insert,
    update,
    transaction,
  } as unknown as Database;
  return {
    service: new MemoryConsolidator(db, {} as Logger, "unused", {} as UsageGovernancePort, {
      refreshEmbeddings,
    }),
    insert,
    update,
    transaction,
    refreshEmbeddings,
  };
}

describe("historical consolidation preview", () => {
  it("returns a raw scan cursor even when the first window contains no eligible messages", async () => {
    const skipped = Array.from({ length: 12 }, (_, index) =>
      source(index + 1, 41, { role: "assistant" }),
    );
    const { service, insert, update, transaction, refreshEmbeddings } = previewWithWindows(
      [[...skipped, source(13, 42)], [source(13, 42)]],
      [],
    );

    expect(await service.previewHistoricalBatches(botId, { limit: 1 })).toEqual({
      data: [],
      nextAfterMessageId: 12,
    });
    expect(await service.previewHistoricalBatches(botId, { afterMessageId: 12, limit: 1 })).toEqual(
      {
        data: [
          expect.objectContaining({
            messageIds: [13],
            participantIds: [42],
            excerpts: ["Message 13"],
          }),
        ],
        nextAfterMessageId: null,
      },
    );
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(refreshEmbeddings).not.toHaveBeenCalled();
  });

  it("skips a raw group batch when one eligible participant has opted out", async () => {
    const { service } = previewWithWindows(
      [[source(1, 41), source(2, 42), source(3, 41), source(4, 43, { chatId: -200 })]],
      [{ userId: 42, mode: "off" }],
    );

    expect(await service.previewHistoricalBatches(botId, { limit: 1 })).toEqual({
      data: [
        expect.objectContaining({
          chatId: -200,
          messageIds: [4],
          participantIds: [43],
          excerpts: ["Message 4"],
        }),
      ],
      nextAfterMessageId: null,
    });
  });

  it("does not join one chat across an ineligible row from another chat", async () => {
    const middle = source(2, 42, { chatId: -200, role: "assistant" });
    const { service } = previewWithWindows(
      [
        [source(1, 41), middle, source(3, 41)],
        [middle, source(3, 41)],
      ],
      [],
    );

    expect(await service.previewHistoricalBatches(botId, { limit: 1 })).toEqual({
      data: [expect.objectContaining({ chatId: -100, messageIds: [1] })],
      nextAfterMessageId: 1,
    });
    expect(await service.previewHistoricalBatches(botId, { afterMessageId: 1, limit: 1 })).toEqual({
      data: [expect.objectContaining({ chatId: -100, messageIds: [3] })],
      nextAfterMessageId: null,
    });
  });
  it("ends pagination when the raw window is exactly full and has no next row", async () => {
    const skipped = Array.from({ length: 12 }, (_, index) =>
      source(index + 1, 41, { role: "assistant" }),
    );
    const { service } = previewWithWindows([skipped], []);

    expect(await service.previewHistoricalBatches(botId, { limit: 1 })).toEqual({
      data: [],
      nextAfterMessageId: null,
    });
  });

  it("keeps later chat batches reachable when one scan window contains more than the limit", async () => {
    const { service } = previewWithWindows(
      [[source(1, 41, { chatId: -100 }), source(2, 42, { chatId: -200 })]],
      [],
    );

    expect(await service.previewHistoricalBatches(botId, { limit: 1 })).toEqual({
      data: [expect.objectContaining({ chatId: -100, messageIds: [1] })],
      nextAfterMessageId: 1,
    });
  });
});
