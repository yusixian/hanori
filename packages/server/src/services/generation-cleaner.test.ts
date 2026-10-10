import type { Database } from "@cos-tool-bot/database";
import { imageGenerations, pixaiGenerations } from "@cos-tool-bot/database";
import { unlink } from "node:fs/promises";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationCleaner } from "./generation-cleaner.js";

vi.mock("node:fs/promises", () => ({ unlink: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("GenerationCleaner", () => {
  it.each([
    { name: "legacy", table: pixaiGenerations, retryId: 7, healthyId: 8 },
    { name: "current", table: imageGenerations, retryId: "retry", healthyId: "healthy" },
  ])(
    "retries $name deletion failures without discarding references or blocking other records",
    async ({ table, retryId, healthyId }) => {
      const failed = { id: retryId, botId: "bot-a", localFiles: ["first.png", "second.png"] };
      const healthy = { id: healthyId, botId: "bot-a", localFiles: ["healthy.png"] };
      let selected = [failed, healthy];
      const updates: unknown[] = [];
      const db = {
        select: () => ({
          from: (source: unknown) => ({
            where: async () => (source === table ? selected : []),
          }),
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: async (condition: SQL) => {
              updates.push({ values, ids: new PgDialect().sqlToQuery(condition).params });
            },
          }),
        }),
      } as unknown as Database;
      const logger = { info: vi.fn(), error: vi.fn() };
      const cleaner = new GenerationCleaner({
        db,
        logger: logger as never,
        retentionDays: 30,
        intervalHours: 24,
      });
      vi.mocked(unlink)
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }))
        .mockResolvedValueOnce();
      await cleaner.cleanup();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ ids: [healthyId] });
      expect(logger.error).toHaveBeenCalled();
      expect(logger.info).toHaveBeenLastCalledWith(
        { recordsPurged: 1, filesDeleted: 2 },
        "Generation cleanup completed",
      );

      selected = [failed];
      vi.mocked(unlink)
        .mockRejectedValueOnce(Object.assign(new Error("already removed"), { code: "ENOENT" }))
        .mockResolvedValueOnce();
      await cleaner.cleanup();
      expect(updates).toHaveLength(2);
      expect(updates[1]).toMatchObject({ ids: [retryId] });
      expect(logger.info).toHaveBeenLastCalledWith(
        { recordsPurged: 1, filesDeleted: 1 },
        "Generation cleanup completed",
      );
    },
  );

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

it.each(["select", "update"])(
  "close waits for a sibling %s query after Promise.all rejects",
  async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("database unavailable");
    const query = vi.fn(async (table: unknown) => {
      if (table === pixaiGenerations) throw failure;
      await pending;
      return [];
    });
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            stage === "select"
              ? query(table)
              : Promise.resolve([
                  { id: table === pixaiGenerations ? 7 : "image", botId: "bot-a", localFiles: [] },
                ]),
        }),
      }),
      update: (table: unknown) => ({ set: () => ({ where: () => query(table) }) }),
    } as unknown as Database;
    const logger = { info: vi.fn(), error: vi.fn() };
    const cleaner = new GenerationCleaner({
      db,
      logger: logger as never,
      retentionDays: 30,
      intervalHours: 24,
    });
    await cleaner.cleanup();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(failure, "Generation cleanup failed");
    expect(query).toHaveBeenCalledTimes(2);
    const closing = cleaner.close();
    const closed = vi.fn();
    void closing.then(closed);
    expect(cleaner.close()).toBe(closing);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    release();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
    cleaner.start();
    await cleaner.cleanup();
    expect(cleaner.getHandle()).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  },
);

it("close waits for file removal and the following purge marker write", async () => {
  let releaseFile!: () => void;
  let releaseWrite!: () => void;
  const file = new Promise<void>((resolve) => {
    releaseFile = resolve;
  });
  const write = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.mocked(unlink).mockReturnValueOnce(file);
  const update = vi.fn(() => write);
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === imageGenerations
            ? [{ id: "image", botId: "bot-a", localFiles: ["image.png"] }]
            : [],
      }),
    }),
    update: () => ({ set: () => ({ where: update }) }),
  } as unknown as Database;
  const cleaner = new GenerationCleaner({
    db,
    logger: { info: vi.fn(), error: vi.fn() } as never,
    retentionDays: 30,
    intervalHours: 24,
  });
  cleaner.start();
  await vi.waitFor(() => expect(unlink).toHaveBeenCalledOnce());
  const closing = cleaner.close();
  const closed = vi.fn();
  void closing.then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  releaseFile();
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(closed).not.toHaveBeenCalled();
  releaseWrite();
  await closing;
  expect(closed).toHaveBeenCalledOnce();
  expect(cleaner.getHandle()).toBeNull();
});
