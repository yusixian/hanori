import type { Database } from "@cos-tool-bot/database";
import { imageGenerations, pixaiGenerations } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { GenerationCleaner } from "./generation-cleaner.js";

describe("GenerationCleaner", () => {
  it("purges expired binaries while retaining both metadata records", async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const selectResults = [
      [{ id: 7, botId: "bot-a", localFiles: [] }],
      [{ id: "generation-a", botId: "bot-a", localFiles: [] }],
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => selectResults.shift() ?? []),
        })),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            updates.push({ table, values });
          }),
        })),
      })),
      delete: vi.fn(() => {
        throw new Error("Cleaner must not delete generation metadata");
      }),
    } as unknown as Database;
    const logger = { info: vi.fn(), error: vi.fn() };
    const cleaner = new GenerationCleaner({
      db,
      logger: logger as never,
      retentionDays: 30,
      intervalHours: 24,
    });

    await cleaner.cleanup();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ table: pixaiGenerations, values: { localFiles: null } });
    expect(updates[1]).toMatchObject({ table: imageGenerations, values: { localFiles: [] } });
    expect(updates.every((update) => update.values.filesPurgedAt instanceof Date)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { recordsPurged: 2, filesDeleted: 0 },
      "Generation cleanup completed",
    );
  });
});
