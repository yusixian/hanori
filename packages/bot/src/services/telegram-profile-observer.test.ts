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

  it("removes obsolete avatar versions and temp files after switching persistence", async () => {
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

    await vi.waitFor(async () => {
      const files = await fs.readdir(avatarDir);
      expect(files.filter((file) => file.startsWith("42-"))).toHaveLength(1);
    });
    const files = await fs.readdir(avatarDir);
    expect(files).toContain("420-unrelated.jpg");
    const currentFile = files.find((file) => file.startsWith("42-"));
    expect(await fs.readFile(path.join(avatarDir, currentFile!))).toEqual(Buffer.from([1, 2, 3]));
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

  it("reports avatar cleanup errors that are not missing-file races", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    await fs.writeFile(path.join(dataDir, "avatars"), new Uint8Array([1]));
    const { memory } = createMemory();
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
    const onError = vi.fn();
    const observer = new TelegramProfileObserver({ memory, token: "secret", dataDir, onError });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "ENOTDIR" });
  });
});
