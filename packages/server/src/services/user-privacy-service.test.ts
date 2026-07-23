import {
  botMemories,
  conversationCompactionState,
  conversationMessages,
  peopleProfiles,
  type Database,
} from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { UserPrivacyService } from "./user-privacy-service.js";

describe("UserPrivacyService.runExclusive", () => {
  it("serializes the same bot user across otherwise independent chats", async () => {
    const service = new UserPrivacyService({} as Database);
    let releaseFirst!: () => void;
    const first = service.runExclusive(
      "bot-1",
      42,
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const secondOperation = vi.fn().mockResolvedValue("second");
    const second = service.runExclusive("bot-1", 42, secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
  });

  it("does not serialize different users", async () => {
    const service = new UserPrivacyService({} as Database);
    let releaseFirst!: () => void;
    const first = service.runExclusive(
      "bot-1",
      42,
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );

    await expect(service.runExclusive("bot-1", 43, async () => "other")).resolves.toBe("other");
    releaseFirst();
    await first;
  });

  it("deletes directly attributable data including the whole private transcript", async () => {
    const deletedTables: unknown[] = [];
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      selectDistinct: () => ({
        from: () => ({
          where: vi.fn().mockResolvedValue([{ chatId: -100 }, { chatId: 42 }]),
        }),
      }),
      delete: (table: unknown) => {
        deletedTables.push(table);
        return {
          where: () => {
            if (table === conversationCompactionState) return Promise.resolve();
            return {
              returning: async () => {
                if (table === conversationMessages) {
                  return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
                }
                if (table === peopleProfiles) {
                  return [{ id: 5, avatarPath: "avatars/42.jpg" }];
                }
                if (table === botMemories) return [{ id: 6 }];
                return [];
              },
            };
          },
        };
      },
    };
    const db = {
      transaction: (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as Database;
    const service = new UserPrivacyService(db);

    await expect(service.forget("bot-1", 42)).resolves.toEqual({
      conversationMessages: 4,
      profiles: 1,
      personalMemories: 1,
    });
    expect(deletedTables).toEqual(
      expect.arrayContaining([
        conversationMessages,
        conversationCompactionState,
        peopleProfiles,
        botMemories,
      ]),
    );
  });

  it("loads avatar paths before deleting profile rows", async () => {
    const where = vi
      .fn()
      .mockResolvedValue([{ avatarPath: "avatars/42.jpg" }, { avatarPath: null }]);
    const db = {
      select: () => ({
        from: () => ({ where }),
      }),
    } as unknown as Database;
    const service = new UserPrivacyService(db);

    await expect(service.getAvatarPaths("bot-1", 42)).resolves.toEqual(["avatars/42.jpg"]);
  });
});
