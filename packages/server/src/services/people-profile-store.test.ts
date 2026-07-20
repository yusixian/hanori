import type { Database } from "@cos-tool-bot/database";
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

function createConcurrentDb(initialRows: Array<Record<string, unknown>> = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  let lockTail = Promise.resolve();

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
        values: async (value: Record<string, unknown>) => {
          rows.push({ id: rows.length + 1, ...value });
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

  return db;
}

describe("PeopleProfileStore", () => {
  it("returns the deleted avatar path while scoping deletion to the bot", async () => {
    const where = vi.fn((_condition: unknown) => ({
      returning: async () => [{ avatarPath: "avatars/42-current.jpg" }],
    }));
    const db = {
      delete: () => ({ where }),
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
    const db = createConcurrentDb();
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
    const db = createConcurrentDb([{ id: 1, telegramId: 42, avatarPath: "avatars/42-old.jpg" }]);
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
});
