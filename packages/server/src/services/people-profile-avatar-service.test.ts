import type { PeopleProfileAvatarResult, UserPrivacyMode } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleProfileAvatarService } from "./people-profile-avatar-service.js";
import { UserPrivacyService } from "./user-privacy-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createAvatarCache(telegramId = 42) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cos-tool-bot-profile-avatar-"));
  tempRoots.push(root);
  const relativePath = `avatars/${telegramId}-current.png`;
  await mkdir(path.join(root, "avatars"));
  const data = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(root, relativePath), data);
  return { root, relativePath, data };
}

function setup(options: {
  requesterMode?: UserPrivacyMode;
  targetMode?: UserPrivacyMode;
  profile?: { avatarPath: string | null; avatarVersion: string | null } | null;
  lockError?: Error;
}) {
  const modes = new Map<number, UserPrivacyMode>([
    [7, options.requesterMode ?? "normal"],
    [42, options.targetMode ?? "normal"],
  ]);
  const getProfile = vi.fn(async () => options.profile ?? null);
  const getMode = vi.fn(async (_botId: string, telegramId: number) => modes.get(telegramId)!);
  const runLibraryExclusiveMany = vi.fn(
    async (_botId: string, _userIds: readonly number[], operation: () => Promise<unknown>) => {
      if (options.lockError) throw options.lockError;
      return operation();
    },
  );
  const service = new PeopleProfileAvatarService(
    { getProfile } as never,
    { getMode, runLibraryExclusiveMany } as never,
  );
  return { service, getProfile, getMode, runLibraryExclusiveMany };
}

describe("PeopleProfileAvatarService", () => {
  it("returns a current Bot profile avatar under both users' privacy lock", async () => {
    const cache = await createAvatarCache();
    const test = setup({
      profile: { avatarPath: cache.relativePath, avatarVersion: "avatar-v1" },
    });

    const result = await test.service.getProfileAvatar("bot-1", cache.root, 42, 7);

    expect(result).toEqual({
      status: "available",
      telegramId: 42,
      avatarVersion: "avatar-v1",
      mediaType: "image/png",
      data: new Uint8Array(cache.data),
    });
    expect(test.runLibraryExclusiveMany).toHaveBeenCalledWith(
      "bot-1",
      [7, 42],
      expect.any(Function),
    );
    expect(test.getProfile).toHaveBeenCalledWith("bot-1", 42);
  });

  it("allows an isolated requester to read self and normal-mode Bot profiles", async () => {
    const selfCache = await createAvatarCache(7);
    const self = setup({
      requesterMode: "isolated",
      profile: { avatarPath: selfCache.relativePath, avatarVersion: null },
    });
    await expect(
      self.service.getProfileAvatar("bot-1", selfCache.root, 7, 7),
    ).resolves.toMatchObject({ status: "available", telegramId: 7 });

    const otherCache = await createAvatarCache(42);
    const other = setup({
      requesterMode: "isolated",
      targetMode: "normal",
      profile: { avatarPath: otherCache.relativePath, avatarVersion: null },
    });
    await expect(other.service.getProfileAvatar("bot-1", otherCache.root, 42, 7)).resolves.toEqual({
      status: "available",
      telegramId: 42,
      avatarVersion: null,
      mediaType: "image/png",
      data: new Uint8Array(otherCache.data),
    });
  });

  it.each(["isolated", "off"] as const)(
    "forbids reading another user's %s profile",
    async (targetMode) => {
      const test = setup({
        targetMode,
        profile: { avatarPath: "avatars/42-current.jpg", avatarVersion: null },
      });

      await expect(test.service.getProfileAvatar("bot-1", "/unused", 42, 7)).resolves.toEqual({
        status: "forbidden",
      });
      expect(test.getProfile).not.toHaveBeenCalled();
    },
  );

  it("forbids an off requester before revealing whether the target exists", async () => {
    const test = setup({
      requesterMode: "off",
      profile: { avatarPath: "avatars/42-current.jpg", avatarVersion: null },
    });

    await expect(test.service.getProfileAvatar("bot-1", "/unused", 42, 7)).resolves.toEqual({
      status: "forbidden",
    });
    expect(test.getProfile).not.toHaveBeenCalled();
    expect(test.getMode).toHaveBeenCalledTimes(1);
  });

  it.each([
    [null, "not_found"],
    [{ avatarPath: null, avatarVersion: null }, "no_avatar"],
    [{ avatarPath: "avatars/42-missing.jpg", avatarVersion: "v1" }, "cache_unavailable"],
  ] as const)("maps unavailable profile cache state to %s", async (profile, status) => {
    const test = setup({ profile });
    await expect(test.service.getProfileAvatar("bot-1", "/unused", 42, 7)).resolves.toEqual({
      status,
    });
  });

  it("fails closed when the privacy lock cannot be acquired", async () => {
    const test = setup({
      profile: { avatarPath: "avatars/42-current.jpg", avatarVersion: null },
      lockError: new Error("This user's library is busy"),
    });

    await expect(test.service.getProfileAvatar("bot-1", "/unused", 42, 7)).resolves.toEqual({
      status: "unavailable",
    });
    expect(test.getMode).not.toHaveBeenCalled();
    expect(test.getProfile).not.toHaveBeenCalled();
  });

  it("maps an inverse cross-user privacy lock to unavailable without waiting", async () => {
    const privacy = new UserPrivacyService({} as Database);
    let releaseTarget!: () => void;
    let targetStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      targetStarted = resolve;
    });
    const target = privacy.runExclusive(
      "bot-1",
      42,
      () =>
        new Promise<void>((resolve) => {
          releaseTarget = resolve;
          targetStarted();
        }),
    );
    await started;
    const service = new PeopleProfileAvatarService({ getProfile: vi.fn() } as never, privacy);

    await expect(
      privacy.runExclusive("bot-1", 43, () => service.getProfileAvatar("bot-1", "/unused", 42, 43)),
    ).resolves.toEqual({ status: "unavailable" });

    releaseTarget();
    await target;
  });

  it("rejects invalid Telegram IDs without entering the privacy boundary", async () => {
    const test = setup({ profile: null });
    const invalidResults: PeopleProfileAvatarResult[] = await Promise.all([
      test.service.getProfileAvatar("bot-1", "/unused", 0, 7),
      test.service.getProfileAvatar("bot-1", "/unused", 42, Number.NaN),
    ]);

    expect(invalidResults).toEqual([{ status: "forbidden" }, { status: "forbidden" }]);
    expect(test.runLibraryExclusiveMany).not.toHaveBeenCalled();
  });
});
