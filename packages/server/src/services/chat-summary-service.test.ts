import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ChatSummaryService } from "./chat-summary-service.js";
import type { SummaryRunner } from "./summary-runner.js";

const configRow = {
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
  cooldownSeconds: 60,
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

function createService(row: typeof configRow | null) {
  let claimed = false;
  const conditions: unknown[] = [];
  const update = vi.fn(() => ({
    set: (values: unknown) => {
      void values;
      return {
        where: (condition: unknown) => {
          conditions.push(condition);
          return {
            returning: async () => {
              if (claimed) return [];
              claimed = true;
              return [{ id: row?.id }];
            },
          };
        },
      };
    },
  }));
  const db = {
    select: () => ({ from: () => ({ where: async () => (row ? [row] : []) }) }),
    update,
  } as unknown as Database;
  const run = vi.fn(async () => ({
    ok: true as const,
    summaryId: 1,
    contentHtml: "summary",
  }));
  const service = new ChatSummaryService(
    db,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
    { run } as unknown as SummaryRunner,
    vi.fn(async () => undefined),
    () => true,
    async () => ({ enabled: true }),
  );
  return { service, run, update, conditions };
}

const manualOptions = {
  botId: "bot-a",
  chatId: -1001,
  userId: 42,
  mode: { kind: "default" as const },
  skipSend: true,
};

describe("ChatSummaryService manual cooldown", () => {
  it("allows at most one concurrent runner through an atomic claim", async () => {
    const { service, run, conditions } = createService({ ...configRow, lastManualAt: null });

    const results = await Promise.all([
      service.triggerManual(manualOptions),
      service.triggerManual(manualOptions),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "cooldown")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      const values = collectPrimitiveValues(condition);
      expect(values).toContain("bot-a");
      expect(values).toContain(-1001);
      expect(values).toContain(7);
    }
  });

  it("keeps the no-config path free of cooldown claims", async () => {
    const { service, run, update } = createService(null);

    const results = await Promise.all([
      service.triggerManual(manualOptions),
      service.triggerManual(manualOptions),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bypass updates the timestamp with bot and chat scope before running", async () => {
    const { service, run, conditions } = createService({ ...configRow, lastManualAt: null });

    await expect(
      service.triggerManual({ ...manualOptions, bypassCooldown: true }),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(run).toHaveBeenCalledTimes(1);
    const values = collectPrimitiveValues(conditions[0]);
    expect(values).toContain("bot-a");
    expect(values).toContain(-1001);
    expect(values).toContain(7);
  });
});
