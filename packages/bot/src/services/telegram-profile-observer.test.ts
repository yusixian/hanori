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
    beginProfileAvatarRefresh: vi.fn(async () => 1),
    updateProfileAvatar: vi.fn(async (update: PeopleProfileAvatarUpdate) => {
      avatarUpdates.push(update);
      return { previousAvatarPath: null };
    }),
  } as unknown as MemoryCallbacks;
  return { memory, observations, avatarUpdates };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createControlledApi(kind: "photo" | "none", label: string, gate: Promise<void>) {
  return {
    getUserProfilePhotos: vi.fn(async () => {
      await gate;
      return kind === "photo"
        ? {
            total_count: 1,
            photos: [
              [
                {
                  file_id: `${label}-photo`,
                  file_unique_id: `${label}-avatar`,
                  width: 160,
                  height: 160,
                },
              ],
            ],
          }
        : { total_count: 0, photos: [] };
    }),
    getFile: vi.fn(async () => ({
      file_id: `${label}-photo`,
      file_unique_id: `${label}-avatar`,
      file_path: `photos/${label}.jpg`,
    })),
  };
}

async function runLatestStartRace(options: {
  older: "photo" | "none";
  newer: "photo" | "none";
  completionOrder: "older-first" | "newer-first";
  initialAvatar?: boolean;
}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
  tempDirs.push(dataDir);
  const initialPath = options.initialAvatar ? "avatars/42-initial.jpg" : null;
  if (initialPath) {
    await fs.mkdir(path.join(dataDir, "avatars"), { recursive: true });
    await fs.writeFile(path.join(dataDir, initialPath), new Uint8Array([9]));
  }

  let generation = 0;
  let currentAvatarPath = initialPath;
  let currentAvatarVersion: string | null = options.initialAvatar ? "initial-avatar" : null;
  const touchProfile = vi.fn(async () => ({ created: false, profileId: 1 }));
  const beginProfileAvatarRefresh = vi.fn(async () => ++generation);
  const updateProfileAvatar = vi.fn(async (update: PeopleProfileAvatarUpdate) => {
    const refreshVersion = (update as PeopleProfileAvatarUpdate & { refreshVersion?: number })
      .refreshVersion;
    if (update.profileId !== 1 || refreshVersion !== generation) return null;
    const previousAvatarPath = currentAvatarPath;
    currentAvatarPath = update.avatarPath;
    currentAvatarVersion = update.avatarVersion;
    return { previousAvatarPath };
  });
  const memory = {
    getProfile: vi.fn(),
    upsertProfile: vi.fn(),
    searchProfiles: vi.fn(),
    searchHistory: vi.fn(),
    touchProfile,
    beginProfileAvatarRefresh,
    updateProfileAvatar,
  } as unknown as MemoryCallbacks;
  const olderGate = deferred<void>();
  const newerGate = deferred<void>();
  const olderApi = createControlledApi(options.older, "older", olderGate.promise);
  const newerApi = createControlledApi(options.newer, "newer", newerGate.promise);
  const observer = new TelegramProfileObserver({
    memory,
    token: "secret",
    dataDir,
    refreshMs: 0,
    now: () => 100,
    fetchImpl: async (input) =>
      new Response(new Uint8Array([String(input).includes("newer") ? 2 : 1]), { status: 200 }),
  });

  observer.observe(olderApi as never, user);
  await vi.waitFor(() => expect(beginProfileAvatarRefresh).toHaveBeenCalledTimes(1));
  observer.observe(newerApi as never, user);
  await vi.waitFor(() => expect(beginProfileAvatarRefresh).toHaveBeenCalledTimes(2));

  if (options.completionOrder === "older-first") {
    olderGate.resolve();
    await vi.waitFor(() => expect(updateProfileAvatar).toHaveBeenCalledTimes(1));
    newerGate.resolve();
  } else {
    newerGate.resolve();
    await vi.waitFor(() => expect(updateProfileAvatar).toHaveBeenCalledTimes(1));
    olderGate.resolve();
  }
  await vi.waitFor(() => expect(updateProfileAvatar).toHaveBeenCalledTimes(2));

  return {
    dataDir,
    getCurrentAvatarPath: () => currentAvatarPath,
    getCurrentAvatarVersion: () => currentAvatarVersion,
  };
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

  it("waits for an in-flight avatar refresh before reporting the user idle", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-idle-"));
    tempDirs.push(dataDir);
    const gate = deferred<void>();
    const { memory } = createMemory();
    const api = createControlledApi("none", "idle", gate.promise);
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      refreshMs: 0,
    });

    observer.observe(api as never, user);
    await vi.waitFor(() => expect(memory.beginProfileAvatarRefresh).toHaveBeenCalledOnce());

    let idle = false;
    const waiting = observer.waitForIdle(user.id).then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    gate.resolve();
    await waiting;
    expect(memory.updateProfileAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ telegramId: user.id, avatarPath: null }),
    );
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

  it.each([false, true])(
    "cancels an HTTP error body even when cancellation fails (%s)",
    async (cancelFails) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
      tempDirs.push(dataDir);
      const { memory, avatarUpdates } = createMemory();
      const cancel = vi.fn(() => {
        if (cancelFails) throw new Error("synthetic cancellation failure");
      });
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      const onError = vi.fn();
      const observer = new TelegramProfileObserver({
        memory,
        token: "secret",
        dataDir,
        onError,
        fetchImpl: vi.fn(async () => new Response(body, { status: 503 })),
      });
      observer.observe(createApi() as never, user);
      await observer.waitForIdle(user.id);
      expect(cancel).toHaveBeenCalledOnce();
      expect(pull).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        new Error("Telegram profile photo download failed: 503"),
      );
      expect(avatarUpdates).toHaveLength(0);
      expect(await fs.readdir(dataDir)).toEqual([]);
    },
  );

  it("stops an oversized streamed avatar before consuming the remaining body", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory, avatarUpdates } = createMemory();
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks += 1;
          if (chunks <= 8) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const onError = vi.fn();
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      onError,
      fetchImpl: vi.fn(async () => new Response(body)),
    });
    observer.observe(createApi() as never, user);
    await observer.waitForIdle(user.id);
    expect(onError).toHaveBeenCalledOnce();
    expect(avatarUpdates).toHaveLength(0);
    expect(chunks).toBe(6);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await fs.readdir(dataDir)).toEqual([]);
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

  it("does not let an old photo refresh overwrite a newer photo for the same profile", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let currentAvatarPath: string | null = null;
    let currentAvatarVersion: string | null = "initial-avatar";
    let releaseOldDownload!: (response: Response) => void;
    const oldDownload = new Promise<Response>((resolve) => {
      releaseOldDownload = resolve;
    });
    let currentRefreshVersion = 0;
    const { memory } = createMemory();
    memory.touchProfile = vi.fn(async () => ({
      created: false,
      profileId: 1,
    }));
    memory.beginProfileAvatarRefresh = vi.fn(async () => ++currentRefreshVersion);
    memory.updateProfileAvatar = vi.fn(async (update) => {
      if (update.profileId !== 1 || update.refreshVersion !== currentRefreshVersion) {
        return null;
      }
      const previousAvatarPath = currentAvatarPath;
      currentAvatarPath = update.avatarPath;
      currentAvatarVersion = update.avatarVersion;
      return { previousAvatarPath };
    });
    const oldApi = createApi();
    oldApi.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [[{ file_id: "old-photo", file_unique_id: "old-avatar", width: 160, height: 160 }]],
    });
    oldApi.getFile.mockResolvedValue({
      file_id: "old-photo",
      file_unique_id: "old-avatar",
      file_path: "photos/old.jpg",
    });
    const newerApi = createApi();
    newerApi.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [
        [{ file_id: "newer-photo", file_unique_id: "newer-avatar", width: 160, height: 160 }],
      ],
    });
    newerApi.getFile.mockResolvedValue({
      file_id: "newer-photo",
      file_unique_id: "newer-avatar",
      file_path: "photos/newer.jpg",
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      refreshMs: 0,
      fetchImpl: async (input) =>
        String(input).endsWith("/photos/old.jpg")
          ? oldDownload
          : new Response(new Uint8Array([2]), { status: 200 }),
      now: () => 100,
    });

    observer.observe(oldApi as never, user);
    await vi.waitFor(() => expect(oldApi.getFile).toHaveBeenCalledOnce());
    observer.observe(newerApi as never, user);
    await vi.waitFor(() => expect(currentAvatarVersion).toBe("newer-avatar"));
    const newerAvatarPath = currentAvatarPath!;
    releaseOldDownload(new Response(new Uint8Array([1]), { status: 200 }));

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(2));
    expect(currentAvatarVersion).toBe("newer-avatar");
    expect(currentAvatarPath).toBe(newerAvatarPath);
    await expect(fs.readFile(path.join(dataDir, newerAvatarPath))).resolves.toEqual(
      Buffer.from([2]),
    );
  });

  it.each(["older-first", "newer-first"] as const)(
    "keeps the latest-started photo when the %s refresh finishes first",
    async (completionOrder) => {
      const race = await runLatestStartRace({
        older: "photo",
        newer: "photo",
        completionOrder,
        initialAvatar: true,
      });

      expect(race.getCurrentAvatarVersion()).toBe("newer-avatar");
      await expect(
        fs.readFile(path.join(race.dataDir, race.getCurrentAvatarPath()!)),
      ).resolves.toEqual(Buffer.from([2]));
    },
  );

  it("keeps a latest-started no-photo result over an older photo", async () => {
    const race = await runLatestStartRace({
      older: "photo",
      newer: "none",
      completionOrder: "older-first",
      initialAvatar: true,
    });

    expect(race.getCurrentAvatarVersion()).toBeNull();
    expect(race.getCurrentAvatarPath()).toBeNull();
  });

  it("keeps a latest-started photo over an older no-photo result", async () => {
    const race = await runLatestStartRace({
      older: "none",
      newer: "photo",
      completionOrder: "older-first",
      initialAvatar: true,
    });

    expect(race.getCurrentAvatarVersion()).toBe("newer-avatar");
    await expect(
      fs.readFile(path.join(race.dataDir, race.getCurrentAvatarPath()!)),
    ).resolves.toEqual(Buffer.from([2]));
  });

  it("rejects a stale photo after a latest-started null-to-null refresh", async () => {
    const race = await runLatestStartRace({
      older: "photo",
      newer: "none",
      completionOrder: "newer-first",
    });

    expect(race.getCurrentAvatarVersion()).toBeNull();
    expect(race.getCurrentAvatarPath()).toBeNull();
    await expect(fs.readdir(path.join(race.dataDir, "avatars"))).resolves.toEqual([]);
  });

  it.each([
    { scenario: "a recreated profile", nextProfileId: 2 },
    { scenario: "a new refresh cycle for the same profile", nextProfileId: 1 },
  ])(
    "keeps the refresh window for $scenario when the old refresh fails late",
    async ({ nextProfileId }) => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
      tempDirs.push(dataDir);
      const { memory, avatarUpdates } = createMemory();
      memory.touchProfile = vi
        .fn()
        .mockResolvedValueOnce({ created: false, profileId: 1 })
        .mockResolvedValue({ created: false, profileId: nextProfileId });
      const gate = deferred<void>();
      const error = new Error("Old avatar request failed");
      const oldApi = {
        getUserProfilePhotos: vi.fn(async () => {
          await gate.promise;
          throw error;
        }),
        getFile: vi.fn(),
      };
      const newApi = createControlledApi("none", "new", Promise.resolve());
      const onError = vi.fn();
      let now = 100;
      const observer = new TelegramProfileObserver({
        memory,
        token: "secret",
        dataDir,
        now: () => now,
        onError,
      });
      try {
        observer.observe(oldApi as never, user);
        await vi.waitFor(() => expect(oldApi.getUserProfilePhotos).toHaveBeenCalledOnce());
        now += 24 * 60 * 60 * 1000;
        observer.observe(newApi as never, user);
        await vi.waitFor(() => expect(avatarUpdates).toHaveLength(1));
        gate.resolve();
        await observer.waitForIdle(user.id);
        now += 5 * 60 * 1000;
        observer.observe(newApi as never, user);
        await observer.waitForIdle(user.id);
        expect(newApi.getUserProfilePhotos).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(error);
      } finally {
        gate.resolve();
        await observer.waitForIdle(user.id);
      }
    },
  );

  it("still retries the current failed refresh after five minutes", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory } = createMemory();
    const api = createControlledApi("none", "retry", Promise.resolve());
    api.getUserProfilePhotos.mockRejectedValueOnce(new Error("Current refresh failed"));
    let now = 100;
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      now: () => now,
    });
    observer.observe(api as never, user);
    await observer.waitForIdle(user.id);
    now += 5 * 60 * 1000 - 1;
    observer.observe(api as never, user);
    await observer.waitForIdle(user.id);
    expect(api.getUserProfilePhotos).toHaveBeenCalledOnce();
    now += 1;
    observer.observe(api as never, user);
    await observer.waitForIdle(user.id);
    expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(2);
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

  it("refreshes immediately when a manually recreated profile has a new id", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory, avatarUpdates } = createMemory();
    memory.touchProfile = vi
      .fn()
      .mockResolvedValueOnce({ created: false, profileId: 1 })
      .mockResolvedValueOnce({ created: false, profileId: 2 });
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

    await vi.waitFor(() => expect(memory.touchProfile).toHaveBeenCalledTimes(2));
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

  it("does not let an old no-photo refresh clear a newer photo for the same profile", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    let currentAvatarPath: string | null = null;
    let currentAvatarVersion: string | null = "initial-avatar";
    let releaseOldPhotos!: (photos: { total_count: number; photos: never[] }) => void;
    const oldPhotos = new Promise<{ total_count: number; photos: never[] }>((resolve) => {
      releaseOldPhotos = resolve;
    });
    let currentRefreshVersion = 0;
    const { memory } = createMemory();
    memory.touchProfile = vi.fn(async () => ({
      created: false,
      profileId: 1,
    }));
    memory.beginProfileAvatarRefresh = vi.fn(async () => ++currentRefreshVersion);
    memory.updateProfileAvatar = vi.fn(async (update) => {
      if (update.profileId !== 1 || update.refreshVersion !== currentRefreshVersion) {
        return null;
      }
      const previousAvatarPath = currentAvatarPath;
      currentAvatarPath = update.avatarPath;
      currentAvatarVersion = update.avatarVersion;
      return { previousAvatarPath };
    });
    const oldApi = createApi();
    oldApi.getUserProfilePhotos.mockImplementation(async () => oldPhotos);
    const newerApi = createApi();
    newerApi.getUserProfilePhotos.mockResolvedValue({
      total_count: 1,
      photos: [
        [{ file_id: "newer-photo", file_unique_id: "newer-avatar", width: 160, height: 160 }],
      ],
    });
    newerApi.getFile.mockResolvedValue({
      file_id: "newer-photo",
      file_unique_id: "newer-avatar",
      file_path: "photos/newer.jpg",
    });
    const observer = new TelegramProfileObserver({
      memory,
      token: "secret",
      dataDir,
      refreshMs: 0,
      fetchImpl: async () => new Response(new Uint8Array([2]), { status: 200 }),
      now: () => 100,
    });

    observer.observe(oldApi as never, user);
    await vi.waitFor(() => expect(oldApi.getUserProfilePhotos).toHaveBeenCalledOnce());
    observer.observe(newerApi as never, user);
    await vi.waitFor(() => expect(currentAvatarVersion).toBe("newer-avatar"));
    const newerAvatarPath = currentAvatarPath!;
    releaseOldPhotos({ total_count: 0, photos: [] });

    await vi.waitFor(() => expect(memory.updateProfileAvatar).toHaveBeenCalledTimes(2));
    expect(currentAvatarVersion).toBe("newer-avatar");
    expect(currentAvatarPath).toBe(newerAvatarPath);
    await expect(fs.readFile(path.join(dataDir, newerAvatarPath))).resolves.toEqual(
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
