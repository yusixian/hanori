import type {
  MemoryCallbacks,
  PeopleProfileAvatarUpdate,
  PeopleProfileObservation,
} from "@cos-tool-bot/shared";
import type { User } from "grammy/types";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramProfileObserver } from "./telegram-profile-observer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createMemory() {
  const observations: PeopleProfileObservation[] = [];
  const avatarUpdates: PeopleProfileAvatarUpdate[] = [];
  const memory = {
    getProfile: vi.fn(),
    upsertProfile: vi.fn(),
    searchProfiles: vi.fn(),
    searchHistory: vi.fn(),
    touchProfile: vi.fn(async (observation: PeopleProfileObservation) => {
      observations.push(observation);
      return { created: false, profileId: 1 };
    }),
    updateProfileAvatar: vi.fn(async (update: PeopleProfileAvatarUpdate) => {
      avatarUpdates.push(update);
      return { previousAvatarPath: null };
    }),
  } as unknown as MemoryCallbacks;
  return { memory, observations, avatarUpdates };
}

function createApi() {
  return {
    getUserProfilePhotos: vi.fn(async () => ({
      total_count: 1,
      photos: [[{ file_id: "photo-1", file_unique_id: "avatar-v1", width: 160, height: 160 }]],
    })),
    getFile: vi.fn(async () => ({
      file_id: "photo-1",
      file_unique_id: "avatar-v1",
      file_path: "photos/avatar.jpg",
    })),
  };
}

const user: User = {
  id: 42,
  is_bot: false,
  first_name: "Ai",
  last_name: "Chan",
  username: "sample",
  language_code: "zh-hans",
  is_premium: true,
};

describe("TelegramProfileObserver", () => {
  it("records observed Telegram fields without requiring an avatar workspace", async () => {
    const { memory, observations } = createMemory();
    const api = createApi();
    const observer = new TelegramProfileObserver({ memory, token: "secret" });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toEqual({
      telegramId: 42,
      username: "sample",
      displayName: "Ai Chan",
      firstName: "Ai",
      lastName: "Chan",
      languageCode: "zh-hans",
      isPremium: true,
    });
    expect(api.getUserProfilePhotos).not.toHaveBeenCalled();
  });

  it("records observations for the same person in arrival order", async () => {
    let releaseFirst!: () => void;
    const firstTouch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { memory } = createMemory();
    const touchProfile = vi.fn(async (_observation: PeopleProfileObservation) => {
      if (touchProfile.mock.calls.length === 1) await firstTouch;
      return { created: false, profileId: 1 };
    });
    memory.touchProfile = touchProfile;
    const observer = new TelegramProfileObserver({ memory, token: "secret" });

    observer.observe(createApi() as never, user);
    observer.observe(createApi() as never, { ...user, first_name: "Latest" });

    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(1));
    releaseFirst();
    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(2));
    expect(touchProfile.mock.calls.map(([observation]) => observation.displayName)).toEqual([
      "Ai Chan",
      "Latest Chan",
    ]);
  });

  it("coalesces blocked observations to the latest identity", async () => {
    let releaseFirst!: () => void;
    const firstTouch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { memory } = createMemory();
    const touchProfile = vi.fn(async (_observation: PeopleProfileObservation) => {
      if (touchProfile.mock.calls.length === 1) await firstTouch;
      return { created: false, profileId: 1 };
    });
    memory.touchProfile = touchProfile;
    const observer = new TelegramProfileObserver({ memory, token: "secret" });

    observer.observe(createApi() as never, user);
    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(1));
    observer.observe(createApi() as never, { ...user, first_name: "Stale One" });
    observer.observe(createApi() as never, { ...user, first_name: "Stale Two" });
    observer.observe(createApi() as never, { ...user, first_name: "Latest" });
    releaseFirst();

    await vi.waitFor(() =>
      expect(
        touchProfile.mock.calls.some(([observation]) => observation.displayName === "Latest Chan"),
      ).toBe(true),
    );
    expect(touchProfile.mock.calls.map(([observation]) => observation.displayName)).toEqual([
      "Ai Chan",
      "Latest Chan",
    ]);
  });

  it("reports a failed identity touch once without an avatar workspace", async () => {
    const { memory } = createMemory();
    const error = new Error("touch failed");
    memory.touchProfile = vi.fn(async () => Promise.reject(error));
    const onError = vi.fn();
    const api = createApi();
    const observer = new TelegramProfileObserver({ memory, token: "secret", onError });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
    expect(api.getUserProfilePhotos).not.toHaveBeenCalled();
  });

  it("attempts and reports a latest touch failure while avatar refresh is throttled", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const latestError = new Error("latest touch failed");
    const touchProfile = vi
      .fn()
      .mockResolvedValueOnce({ created: false, profileId: 1 })
      .mockImplementationOnce(async () => {
        await blocked;
        return { created: false, profileId: 1 };
      })
      .mockRejectedValueOnce(latestError);
    const { memory, avatarUpdates } = createMemory();
    memory.touchProfile = touchProfile;
    const onError = vi.fn();
    const api = createApi();
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
      now: () => 100,
      onError,
    });

    observer.observe(api as never, user);
    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
    observer.observe(api as never, { ...user, first_name: "Blocked" });
    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(2));
    observer.observe(api as never, { ...user, first_name: "Latest" });
    releaseBlocked();

    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(latestError);
    expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a newer identity after an avatar download", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let releaseDownload!: (response: Response) => void;
    const download = new Promise<Response>((resolve) => {
      releaseDownload = resolve;
    });
    const { memory, observations, avatarUpdates } = createMemory();
    const fetchImpl = vi.fn(async () => download);
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl,
    });

    observer.observe(createApi() as never, user);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    observer.observe(createApi() as never, { ...user, first_name: "Latest" });
    await vi.waitFor(() => expect(observations).toHaveLength(2));
    releaseDownload(new Response(new Uint8Array([1]), { status: 200 }));

    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
    expect(observations.map(({ displayName }) => displayName)).toEqual(["Ai Chan", "Latest Chan"]);
    expect(avatarUpdates[0]).toMatchObject({
      telegramId: 42,
      avatarVersion: "avatar-v1",
    });
  });

  it("downloads the largest avatar and persists a cache-busting version", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory, avatarUpdates } = createMemory();
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [
        [
          { file_id: "medium", file_unique_id: "avatar-medium", width: 640, height: 640 },
          { file_id: "largest", file_unique_id: "avatar-largest", width: 900, height: 700 },
          { file_id: "last", file_unique_id: "avatar-last", width: 1280, height: 320 },
        ],
      ],
    });
    api.getFile.mockResolvedValue({
      file_id: "largest",
      file_unique_id: "avatar-largest",
      file_path: "photos/largest.jpg",
    });
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "3", "content-type": "image/jpeg" },
        }),
    );
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl,
    });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
    expect(avatarUpdates[0]).toMatchObject({
      telegramId: 42,
      avatarVersion: "avatar-largest",
    });
    expect(avatarUpdates[0]!.avatarPath).toMatch(/^avatars\/42-[^/]+\.jpg$/);
    expect(await fs.readFile(path.join(dataDir, avatarUpdates[0]!.avatarPath!))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(api.getFile).toHaveBeenCalledWith("largest");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/botsecret/photos/largest.jpg");
  });

  it("keeps the previous avatar and removes the downloaded file when persistence fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const avatarDir = path.join(dataDir, "avatars");
    const previousPath = path.join(avatarDir, "42-old.jpg");
    await fs.mkdir(avatarDir, { recursive: true });
    await fs.writeFile(previousPath, new Uint8Array([9]));
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });

    observer.observe(createApi() as never, user);

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect((await fs.readdir(avatarDir)).sort()).toEqual(["42-old.jpg"]),
    );
    expect(await fs.readFile(previousPath)).toEqual(Buffer.from([9]));
  });

  it("removes a downloaded avatar when its profile was deleted in flight", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const avatarDir = path.join(dataDir, "avatars");
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async () => null);
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });

    observer.observe(createApi() as never, user);

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await fs.readdir(avatarDir)).toEqual([]));
  });

  it("removes only the replaced avatar after switching persistence", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const avatarDir = path.join(dataDir, "avatars");
    const previousRelativePath = "avatars/42-old.jpg";
    const previousPath = path.join(dataDir, previousRelativePath);
    await fs.mkdir(avatarDir, { recursive: true });
    await fs.writeFile(previousPath, new Uint8Array([9]));
    await fs.writeFile(path.join(avatarDir, "42-stale.jpg"), new Uint8Array([8]));
    await fs.writeFile(path.join(avatarDir, "42-stale.jpg.abcd.tmp"), new Uint8Array([7]));
    await fs.writeFile(path.join(avatarDir, "420-unrelated.jpg"), new Uint8Array([6]));
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async () => {
      expect(await fs.readFile(previousPath)).toEqual(Buffer.from([9]));
      return { previousAvatarPath: previousRelativePath };
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });

    observer.observe(createApi() as never, user);

    await vi.waitFor(() => expect(fs.stat(previousPath)).rejects.toMatchObject({ code: "ENOENT" }));
    const files = await fs.readdir(avatarDir);
    expect(files).toContain("420-unrelated.jpg");
    expect(files).toContain("42-stale.jpg");
    expect(files).toContain("42-stale.jpg.abcd.tmp");
    const currentFile = files.find(
      (file) => file.startsWith("42-") && !file.startsWith("42-stale"),
    );
    expect(await fs.readFile(path.join(avatarDir, currentFile!))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("does not delete a newer avatar when an older photo refresh finishes cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const avatarDir = path.join(dataDir, "avatars");
    const previousRelativePath = "avatars/42-old.jpg";
    const newerRelativePath = "avatars/42-newer.jpg";
    await fs.mkdir(avatarDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, previousRelativePath), new Uint8Array([9]));
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async (update) => {
      await fs.writeFile(path.join(dataDir, newerRelativePath), new Uint8Array([2]));
      await fs.unlink(path.join(dataDir, update.avatarPath!));
      return { previousAvatarPath: previousRelativePath };
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
    });

    observer.observe(createApi() as never, user);

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await expect(fs.readFile(path.join(dataDir, newerRelativePath))).resolves.toEqual(
      Buffer.from([2]),
    );
  });

  it("does not let an old photo refresh overwrite a recreated profile", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let activeProfileId = 1;
    let currentAvatarPath: string | null = null;
    let releaseOldDownload!: (response: Response) => void;
    const oldDownload = new Promise<Response>((resolve) => {
      releaseOldDownload = resolve;
    });
    const { memory } = createMemory();
    memory.touchProfile = vi
      .fn()
      .mockResolvedValueOnce({ created: false, profileId: 1 })
      .mockImplementationOnce(async () => {
        activeProfileId = 2;
        currentAvatarPath = null;
        return { created: true, profileId: 2 };
      });
    memory.updateProfileAvatar = vi.fn(async (update) => {
      if (update.profileId !== activeProfileId) return null;
      const previousAvatarPath = currentAvatarPath;
      currentAvatarPath = update.avatarPath;
      return { previousAvatarPath };
    });
    const oldApi = createApi();
    oldApi.getFile.mockResolvedValue({
      file_id: "old-photo",
      file_unique_id: "old-avatar",
      file_path: "photos/old.jpg",
    });
    const currentApi = createApi();
    currentApi.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [
        [{ file_id: "current-photo", file_unique_id: "current-avatar", width: 160, height: 160 }],
      ],
    });
    currentApi.getFile.mockResolvedValue({
      file_id: "current-photo",
      file_unique_id: "current-avatar",
      file_path: "photos/current.jpg",
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async (input) =>
        String(input).endsWith("/photos/old.jpg")
          ? oldDownload
          : new Response(new Uint8Array([2]), { status: 200 }),
    });

    observer.observe(oldApi as never, user);
    await vi.waitFor(() => expect(oldApi.getFile).toHaveBeenCalledOnce());
    observer.observe(currentApi as never, user);
    await vi.waitFor(() => expect(currentAvatarPath).not.toBeNull());
    const recreatedAvatarPath = currentAvatarPath!;
    releaseOldDownload(new Response(new Uint8Array([1]), { status: 200 }));

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(2));
    await expect(fs.readFile(path.join(dataDir, recreatedAvatarPath))).resolves.toEqual(
      Buffer.from([2]),
    );
    expect(currentAvatarPath).toBe(recreatedAvatarPath);
  });

  it("refreshes an avatar at most once per cache window", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory } = createMemory();
    const api = createApi();
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
      now: () => 100,
    });

    observer.observe(api as never, user);
    observer.observe(api as never, user);

    await vi.waitFor(() => expect(api.getFile).toHaveBeenCalledTimes(1));
    expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately when an observation recreates a deleted profile", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory, avatarUpdates } = createMemory();
    const touchProfile = vi
      .fn()
      .mockResolvedValueOnce({ created: false, profileId: 1 })
      .mockResolvedValueOnce({ created: true, profileId: 2 });
    memory.touchProfile = touchProfile;
    const api = createApi();
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200 }),
      now: () => 100,
    });

    observer.observe(api as never, user);
    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
    observer.observe(api as never, user);

    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(2));
  });

  it("clears a stale avatar after Telegram reports no profile photo", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const previousRelativePath = "avatars/42-old.jpg";
    const previousPath = path.join(dataDir, previousRelativePath);
    await fs.mkdir(path.dirname(previousPath), { recursive: true });
    await fs.writeFile(previousPath, new Uint8Array([9]));
    const { memory, avatarUpdates } = createMemory();
    memory.updateProfileAvatar = vi.fn(async (update) => {
      avatarUpdates.push(update);
      expect(await fs.readFile(previousPath)).toEqual(Buffer.from([9]));
      return { previousAvatarPath: previousRelativePath };
    });
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
    const observer = new TelegramProfileObserver({ memory, token: "secret", dataDir });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
    expect(avatarUpdates[0]).toMatchObject({ avatarPath: null, avatarVersion: null });
    await vi.waitFor(() => expect(fs.stat(previousPath)).rejects.toMatchObject({ code: "ENOENT" }));
    expect(api.getFile).not.toHaveBeenCalled();
  });

  it("does not delete a newer avatar when an older no-photo refresh finishes cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const previousRelativePath = "avatars/42-old.jpg";
    const newerRelativePath = "avatars/42-newer.jpg";
    await fs.mkdir(path.join(dataDir, "avatars"), { recursive: true });
    await fs.writeFile(path.join(dataDir, previousRelativePath), new Uint8Array([9]));
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async () => {
      await fs.writeFile(path.join(dataDir, newerRelativePath), new Uint8Array([2]));
      return { previousAvatarPath: previousRelativePath };
    });
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
    const observer = new TelegramProfileObserver({ memory, token: "secret", dataDir });

    observer.observe(api as never, user);

    await vi.waitFor(() =>
      expect(fs.stat(path.join(dataDir, previousRelativePath))).rejects.toMatchObject({
        code: "ENOENT",
      }),
    );
    await expect(fs.readFile(path.join(dataDir, newerRelativePath))).resolves.toEqual(
      Buffer.from([2]),
    );
  });

  it("does not let an old no-photo refresh clear a recreated profile", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let activeProfileId = 1;
    let currentAvatarPath: string | null = null;
    let releaseOldPhotos!: (photos: { total_count: number; photos: never[] }) => void;
    const oldPhotos = new Promise<{ total_count: number; photos: never[] }>((resolve) => {
      releaseOldPhotos = resolve;
    });
    const { memory } = createMemory();
    memory.touchProfile = vi
      .fn()
      .mockResolvedValueOnce({ created: false, profileId: 1 })
      .mockImplementationOnce(async () => {
        activeProfileId = 2;
        currentAvatarPath = null;
        return { created: true, profileId: 2 };
      });
    memory.updateProfileAvatar = vi.fn(async (update) => {
      if (update.profileId !== activeProfileId) return null;
      const previousAvatarPath = currentAvatarPath;
      currentAvatarPath = update.avatarPath;
      return { previousAvatarPath };
    });
    const oldApi = createApi();
    oldApi.getUserProfilePhotos.mockImplementation(async () => oldPhotos);
    const currentApi = createApi();
    currentApi.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [
        [{ file_id: "current-photo", file_unique_id: "current-avatar", width: 160, height: 160 }],
      ],
    });
    currentApi.getFile.mockResolvedValue({
      file_id: "current-photo",
      file_unique_id: "current-avatar",
      file_path: "photos/current.jpg",
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      fetchImpl: async () => new Response(new Uint8Array([2]), { status: 200 }),
    });

    observer.observe(oldApi as never, user);
    await vi.waitFor(() => expect(oldApi.getUserProfilePhotos).toHaveBeenCalledOnce());
    observer.observe(currentApi as never, user);
    await vi.waitFor(() => expect(currentAvatarPath).not.toBeNull());
    const recreatedAvatarPath = currentAvatarPath!;
    releaseOldPhotos({ total_count: 0, photos: [] });

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(2));
    expect(currentAvatarPath).toBe(recreatedAvatarPath);
    await expect(fs.readFile(path.join(dataDir, recreatedAvatarPath))).resolves.toEqual(
      Buffer.from([2]),
    );
  });

  it("reports avatar cleanup errors that are not missing-file races", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    await fs.writeFile(path.join(dataDir, "avatars"), new Uint8Array([1]));
    const { memory } = createMemory();
    memory.updateProfileAvatar = vi.fn(async () => ({
      previousAvatarPath: "avatars/42-old.jpg",
    }));
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
    const onError = vi.fn();
    const observer = new TelegramProfileObserver({ memory, token: "secret", dataDir, onError });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTDIR" });
  });
});
