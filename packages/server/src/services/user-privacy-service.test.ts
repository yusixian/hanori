import {
  botMemories,
  conversationCompactionState,
  conversationMessages,
  engagementSamples,
  generationCharacters,
  peopleProfiles,
  type Database,
} from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { UserPrivacyService } from "./user-privacy-service.js";

describe("UserPrivacyService.runExclusive", () => {
  it("lets a foreground library operation reuse its AI turn lock", async () => {
    const service = new UserPrivacyService({} as Database);
    await expect(
      service.runExclusive("bot", 42, () =>
        service.runLibraryExclusiveMany("bot", [42], async () => "saved"),
      ),
    ).resolves.toBe("saved");
  });

  it("rejects inverse nested cross-user acquisition instead of deadlocking", async () => {
    const service = new UserPrivacyService({} as Database);
    let release!: () => void;
    const other = service.runExclusive(
      "bot",
      42,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      service.runExclusive("bot", 43, () =>
        service.runLibraryExclusiveMany("bot", [42, 43], async () => "saved"),
      ),
    ).rejects.toThrow("busy");
    release();
    await other;
    await expect(
      service.runExclusive("bot", 43, () =>
        service.runLibraryExclusiveMany("bot", [42, 43], async () => "saved"),
      ),
    ).resolves.toBe("saved");
  });

  it("does not reuse an expired lock inherited by detached work", async () => {
    const service = new UserPrivacyService({} as Database);
    let resumeDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      resumeDetached = resolve;
    });
    const operation = vi.fn().mockResolvedValue("saved");
    let detached!: Promise<string>;
    await service.runExclusive("bot", 42, async () => {
      detached = detachedGate.then(() => service.runLibraryExclusiveMany("bot", [42], operation));
    });
    let releaseOwner!: () => void;
    let ownerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      ownerStarted = resolve;
    });
    const owner = service.runExclusive("bot", 42, () => {
      ownerStarted();
      return new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await started;
    resumeDetached();
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
    await expect(detached).resolves.toBe("saved");
  });
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

  it("acquires overlapping user sets in canonical order", async () => {
    const service = new UserPrivacyService({} as Database);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = service.runExclusiveMany("bot-1", [43, 42], () => {
      markFirstStarted();
      return new Promise<void>((resolve) => (releaseFirst = resolve));
    });
    const secondOperation = vi.fn().mockResolvedValue("second");
    const second = service.runExclusiveMany("bot-1", [42, 43], secondOperation);

    await firstStarted;
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
  });

  it("deletes directly attributable data including the whole private transcript", async () => {
    const deletedTables: unknown[] = [];
    const updatedTables: unknown[] = [];
    const engagementUpdate = vi.fn().mockResolvedValue(undefined);
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
      update: (table: unknown) => {
        updatedTables.push(table);
        return {
          set: () => ({ where: engagementUpdate }),
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
        generationCharacters,
        botMemories,
      ]),
    );
    expect(updatedTables).toContain(engagementSamples);
    expect(engagementUpdate).toHaveBeenCalledOnce();
    expect(service.getContextResetAt("bot-1", 42)).toEqual(expect.any(Number));
  });

  it("keeps the latest off boundary after a user opts back in", async () => {
    let now = 100;
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate }) }),
    } as unknown as Database;
    const service = new UserPrivacyService(db, () => now);

    await service.setMode("bot-1", 42, "off");
    now = 200;
    await service.setMode("bot-1", 42, "normal");

    expect(service.getContextResetAt("bot-1", 42)).toBe(100);
  });

  it("drops delayed pre-forget engagement text after the user opts back in", async () => {
    let now = 100;
    let mode = "normal";
    const zeroDelete = () => ({
      where: () => ({ returning: async () => [] }),
    });
    const tx = {
      insert: () => ({
        values: (value: { mode: string }) => ({
          onConflictDoUpdate: async () => {
            mode = value.mode;
          },
        }),
      }),
      selectDistinct: () => ({ from: () => ({ where: async () => [] }) }),
      delete: zeroDelete,
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const db = {
      transaction: (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
      insert: () => ({
        values: (value: { mode: string }) => ({
          onConflictDoUpdate: async () => {
            mode = value.mode;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ mode }] }),
        }),
      }),
    } as unknown as Database;
    const service = new UserPrivacyService(db, () => now);

    await service.forget("bot-1", 42);
    now = 200;
    await service.setMode("bot-1", 42, "normal");
    const persist = vi.fn(async () => undefined);
    await service.runWithEngagementContextPrivacy(
      "bot-1",
      [
        {
          messageId: 1,
          userId: 42,
          text: "must stay forgotten",
          timestamp: 201,
          privacyCapturedAt: 99,
          privacyUserIds: [42],
        },
      ],
      persist,
    );

    expect(persist).toHaveBeenCalledWith([]);
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
