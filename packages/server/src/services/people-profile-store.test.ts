import { peopleProfiles, type Database } from "@cos-tool-bot/database";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { PeopleProfileStore } from "./people-profile-store.js";

interface QueryChunk {
  value?: unknown;
  queryChunks?: QueryChunk[];
}

function queryValues(chunks: QueryChunk[]): unknown[] {
  return chunks.flatMap((chunk) => [
    ...(chunk.value === undefined ? [] : [chunk.value]),
    ...(chunk.queryChunks ? queryValues(chunk.queryChunks) : []),
  ]);
}

function createConcurrentDb(
  initialRows: Array<Record<string, unknown>> = [],
  options: { pauseFirstInsert?: boolean } = {},
) {
  const rows = initialRows.map((row) => ({ ...row }));
  let lockTail = Promise.resolve();
  let insertedCount = 0;
  let markFirstInsertStarted!: () => void;
  let releaseFirstInsert!: () => void;
  const firstInsertStarted = new Promise<void>((resolve) => {
    markFirstInsertStarted = resolve;
  });
  const firstInsertRelease = new Promise<void>((resolve) => {
    releaseFirstInsert = resolve;
  });

  function createAdapter() {
    return {
      execute: async () => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        return release;
      },
      select: () => {
        const query = {
          from: () => query,
          where: () =>
            Object.assign(Promise.resolve(rows.map((row) => ({ ...row }))), {
              orderBy: () => ({
                limit: async () => rows.map((row) => ({ ...row })),
              }),
            }),
        };
        return query;
      },
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          const insertion = (async () => {
            const insertionNumber = ++insertedCount;
            if (options.pauseFirstInsert && insertionNumber === 1) {
              markFirstInsertStarted();
              await firstInsertRelease;
            }
            if (
              rows.some((row) => row.botId === value.botId && row.telegramId === value.telegramId)
            ) {
              throw Object.assign(new Error("duplicate profile"), { code: "23505" });
            }
            const inserted = { id: rows.length + 1, ...value };
            rows.push(inserted);
            return inserted;
          })();
          return Object.assign(insertion, {
            returning: async () => [await insertion],
          });
        },
      }),
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: () => {
            Object.assign(rows[0]!, updates);
            return {
              returning: async () => (rows[0] ? [{ id: rows[0].id }] : []),
            };
          },
        }),
      }),
    };
  }

  const adapter = createAdapter();
  const db = {
    ...adapter,
    transaction: async (callback: (tx: ReturnType<typeof createAdapter>) => Promise<unknown>) => {
      let release: (() => void) | undefined;
      const tx = createAdapter();
      const execute = tx.execute;
      tx.execute = async () => {
        release = await execute();
        return release;
      };
      try {
        return await callback(tx);
      } finally {
        release?.();
      }
    },
  } as unknown as Database;

  return { db, firstInsertStarted, releaseFirstInsert };
}

describe("PeopleProfileStore", () => {
  it("enforces one profile per bot and Telegram user in the database", () => {
    const profileIndex = getTableConfig(peopleProfiles).indexes.find(
      ({ config }) => config.name === "people_bot_telegram_idx",
    );

    expect(profileIndex?.config.unique).toBe(true);
  });

  it("merges existing duplicate profile data before creating the unique index", async () => {
    const migration = await readFile(
      new URL("../../../database/drizzle/0031_first_terror.sql", import.meta.url),
      "utf8",
    );

    const mergePosition = migration.indexOf('UPDATE "people_profiles" AS "survivor"');
    const deletePosition = migration.indexOf('DELETE FROM "people_profiles" AS "duplicate"');
    const uniquePosition = migration.indexOf('CREATE UNIQUE INDEX "people_bot_telegram_idx"');
    expect(mergePosition).toBeGreaterThan(-1);
    expect(deletePosition).toBeGreaterThan(mergePosition);
    expect(uniquePosition).toBeGreaterThan(deletePosition);
    expect(migration).toContain('MIN("first_seen")');
    expect(migration).toContain('MAX("last_seen")');
    expect(migration).toContain("string_agg");
    expect(migration).toContain("json_array_elements_text");
    expect(migration).toContain('"relationship" = "merged"."relationship"');
  });

  it("keeps the profile when avatar cleanup fails before deletion", async () => {
    const profile = { id: 7, telegramId: 42, avatarPath: "avatars/42-current.jpg" };
    const deleteRows = vi.fn(async () => [{ avatarPath: "avatars/42-current.jpg" }]);
    const where = vi.fn(() => ({ returning: deleteRows }));
    const tx = {
      select: () => ({ from: () => ({ where: async () => [profile] }) }),
      execute: vi.fn(),
      delete: () => ({ where }),
    };
    const db = {
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Database;
    const store = new PeopleProfileStore(db);

    await expect(
      store.deleteProfile("00000000-0000-4000-8000-000000000017", 7, async () => {
        throw new Error("cleanup failed");
      }),
    ).rejects.toThrow("cleanup failed");
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it("returns the deleted avatar path while scoping deletion to the bot", async () => {
    const profile = { id: 7, telegramId: 42, avatarPath: "avatars/42-current.jpg" };
    const where = vi.fn((_condition: unknown) => ({
      returning: async () => [{ avatarPath: "avatars/42-current.jpg" }],
    }));
    const tx = {
      select: () => ({ from: () => ({ where: async () => [profile] }) }),
      execute: vi.fn(),
      delete: () => ({ where }),
    };
    const db = {
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Database;
    const store = new PeopleProfileStore(db);

    await expect(store.deleteProfile("00000000-0000-4000-8000-000000000017", 7)).resolves.toEqual({
      avatarPath: "avatars/42-current.jpg",
    });

    const condition = where.mock.calls[0]![0] as { queryChunks: QueryChunk[] };
    expect(queryValues(condition.queryChunks)).toEqual(
      expect.arrayContaining(["00000000-0000-4000-8000-000000000017", 7]),
    );
  });

  it("creates one profile when two store instances first observe the same person concurrently", async () => {
    const { db } = createConcurrentDb();
    const firstStore = new PeopleProfileStore(db);
    const secondStore = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";
    const observation = {
      telegramId: 42,
      username: "sample",
      displayName: "Ai Chan",
      firstName: "Ai",
      lastName: "Chan",
      languageCode: "zh-hans",
      isPremium: true,
    };

    await Promise.all([
      firstStore.touchProfile(botId, observation),
      secondStore.touchProfile(botId, observation),
    ]);

    await expect(firstStore.searchProfiles(botId, "Ai")).resolves.toHaveLength(1);
  });

  it("reports whether an observation created the profile", async () => {
    const { db } = createConcurrentDb();
    const store = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";
    const observation = {
      telegramId: 42,
      username: "sample",
      displayName: "Ai Chan",
      firstName: "Ai",
      lastName: "Chan",
      languageCode: "zh-hans",
      isPremium: true,
    };

    await expect(store.touchProfile(botId, observation)).resolves.toEqual({ created: true });
    await expect(store.touchProfile(botId, observation)).resolves.toEqual({ created: false });
  });

  it("does not report an avatar switch when the profile is deleted concurrently", async () => {
    const profile = { id: 1, telegramId: 42, avatarPath: "avatars/42-old.jpg" };
    const tx = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: async () => [profile],
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    };
    const db = {
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Database;
    const store = new PeopleProfileStore(db);

    await expect(
      store.updateProfileAvatar("00000000-0000-4000-8000-000000000017", {
        telegramId: 42,
        avatarPath: "avatars/42-new.jpg",
        avatarVersion: "new",
      }),
    ).resolves.toBeNull();
  });

  it("returns each replaced avatar path when two store instances update concurrently", async () => {
    const { db } = createConcurrentDb([
      { id: 1, telegramId: 42, avatarPath: "avatars/42-old.jpg" },
    ]);
    const firstStore = new PeopleProfileStore(db);
    const secondStore = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";

    const results = await Promise.all([
      firstStore.updateProfileAvatar(botId, {
        telegramId: 42,
        avatarPath: "avatars/42-first.jpg",
        avatarVersion: "first",
      }),
      secondStore.updateProfileAvatar(botId, {
        telegramId: 42,
        avatarPath: "avatars/42-second.jpg",
        avatarVersion: "second",
      }),
    ]);

    expect(results).toEqual([
      { previousAvatarPath: "avatars/42-old.jpg" },
      { previousAvatarPath: "avatars/42-first.jpg" },
    ]);
  });

  it("keeps one profile when an AI upsert races the first Telegram observation", async () => {
    const { db, firstInsertStarted, releaseFirstInsert } = createConcurrentDb([], {
      pauseFirstInsert: true,
    });
    const firstStore = new PeopleProfileStore(db);
    const secondStore = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";

    const upsert = firstStore.upsertProfile(botId, {
      telegramId: 42,
      notes: "likes cats",
      traits: ["kind"],
    });
    await firstInsertStarted;
    const touch = secondStore.touchProfile(botId, {
      telegramId: 42,
      username: "sample",
      displayName: "Ai Chan",
      firstName: "Ai",
      lastName: "Chan",
      languageCode: "zh-hans",
      isPremium: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseFirstInsert();

    await Promise.all([upsert, touch]);
    await expect(firstStore.searchProfiles(botId, "Ai")).resolves.toHaveLength(1);
    await expect(firstStore.getProfile(botId, 42)).resolves.toMatchObject({
      displayName: "Ai Chan",
      notes: "likes cats",
      traits: ["kind"],
    });
  });

  it("serializes concurrent AI upserts without losing merge semantics", async () => {
    const { db } = createConcurrentDb();
    const firstStore = new PeopleProfileStore(db);
    const secondStore = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";

    await Promise.all([
      firstStore.upsertProfile(botId, {
        telegramId: 42,
        notes: "first note",
        traits: ["kind"],
        interests: ["cats"],
      }),
      secondStore.upsertProfile(botId, {
        telegramId: 42,
        notes: "second note",
        traits: ["kind", "curious"],
        interests: ["dogs"],
      }),
    ]);

    await expect(firstStore.getProfile(botId, 42)).resolves.toMatchObject({
      notes: "first note\nsecond note",
      traits: ["kind", "curious"],
      interests: ["cats", "dogs"],
    });
  });

  it("distinguishes a repeated manual create without overwriting the existing profile", async () => {
    const { db } = createConcurrentDb();
    const store = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";

    const first = await store.createProfile(botId, {
      telegramId: 42,
      displayName: "Original",
      notes: "keep me",
    });
    const repeated = await store.createProfile(botId, {
      telegramId: 42,
      displayName: "Replacement",
      notes: "do not overwrite",
    });

    expect(first).toMatchObject({ created: true, profile: { displayName: "Original" } });
    expect(repeated).toMatchObject({
      created: false,
      profile: { id: first.profile.id, displayName: "Original" },
    });
    await expect(store.getProfile(botId, 42)).resolves.toMatchObject({
      displayName: "Original",
      notes: "keep me",
    });
  });

  it("keeps one profile when manual creation races the first Telegram observation", async () => {
    const { db, firstInsertStarted, releaseFirstInsert } = createConcurrentDb([], {
      pauseFirstInsert: true,
    });
    const firstStore = new PeopleProfileStore(db);
    const secondStore = new PeopleProfileStore(db);
    const botId = "00000000-0000-4000-8000-000000000017";

    const create = firstStore.createProfile(botId, {
      telegramId: 42,
      notes: "manual note",
    });
    await firstInsertStarted;
    const touch = secondStore.touchProfile(botId, {
      telegramId: 42,
      username: "sample",
      displayName: "Ai Chan",
      firstName: "Ai",
      lastName: "Chan",
      languageCode: "zh-hans",
      isPremium: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseFirstInsert();

    await Promise.all([create, touch]);
    await expect(firstStore.searchProfiles(botId, "Ai")).resolves.toHaveLength(1);
    await expect(firstStore.getProfile(botId, 42)).resolves.toMatchObject({
      displayName: "Ai Chan",
      notes: "manual note",
    });
  });
});
