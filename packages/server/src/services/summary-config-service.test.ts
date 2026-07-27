import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { SummaryConfigService } from "./summary-config-service.js";

const row = {
  id: 7,
  botId: "bot-a",
  chatId: -1001,
  isActive: true,
  scheduleHour: null,
  scheduleMinute: null,
  windowHours: 24,
  customPrompt: null,
  providerId: null,
  modelId: null,
  maxMessages: null,
  cooldownSeconds: null,
  accessMode: "all",
  lastScheduledAt: null,
  lastManualAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function collectPrimitiveValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => collectPrimitiveValues(entry, seen));
}

describe("SummaryConfigService bot scoping", () => {
  it("scopes get by bot and config ID in one query", async () => {
    const where = vi.fn(async (condition: unknown) => {
      void condition;
      return [row];
    });
    const db = { select: () => ({ from: () => ({ where }) }) } as unknown as Database;

    await expect(new SummaryConfigService(db).get("bot-a", 7)).resolves.toMatchObject({
      botId: "bot-a",
      id: 7,
    });

    const values = collectPrimitiveValues(where.mock.calls[0]![0]);
    expect(values).toContain("bot-a");
    expect(values).toContain(7);
  });

  it("scopes update and delete by bot and config ID in their mutation queries", async () => {
    const updateWhere = vi.fn((condition: unknown) => {
      void condition;
      return { returning: async () => [row] };
    });
    const deleteWhere = vi.fn((condition: unknown) => {
      void condition;
      return { returning: async () => [{ id: row.id }] };
    });
    const db = {
      update: () => ({ set: () => ({ where: updateWhere }) }),
      delete: () => ({ where: deleteWhere }),
    } as unknown as Database;
    const service = new SummaryConfigService(db);

    await expect(service.update("bot-a", 7, { isActive: false })).resolves.toMatchObject({ id: 7 });
    await expect(service.delete("bot-a", 7)).resolves.toBe(true);

    for (const condition of [updateWhere.mock.calls[0]![0], deleteWhere.mock.calls[0]![0]]) {
      const values = collectPrimitiveValues(condition);
      expect(values).toContain("bot-a");
      expect(values).toContain(7);
    }
  });
});
