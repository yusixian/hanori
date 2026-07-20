import type { MemoryCallbacks, PeopleProfileObservation } from "@cos-tool-bot/shared";
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
  const memory = {
    getProfile: vi.fn(),
    upsertProfile: vi.fn(),
    searchProfiles: vi.fn(),
    searchHistory: vi.fn(),
    touchProfile: vi.fn(async (observation: PeopleProfileObservation) => {
      observations.push(observation);
    }),
  } as unknown as MemoryCallbacks;
  return { memory, observations };
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

  it("downloads the largest avatar and persists a cache-busting version", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-observer-"));
    tempDirs.push(dataDir);
    const { memory, observations } = createMemory();
    const api = createApi();
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

    await vi.waitFor(() => expect(observations).toHaveLength(2));
    expect(observations[1]).toMatchObject({
      telegramId: 42,
      avatarPath: "avatars/42.jpg",
      avatarVersion: "avatar-v1",
    });
    expect(await fs.readFile(path.join(dataDir, "avatars", "42.jpg"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/botsecret/photos/avatar.jpg");
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
    const { memory, observations } = createMemory();
    const api = createApi();
    api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
    const observer = new TelegramProfileObserver({ memory, token: "secret", dataDir });

    observer.observe(api as never, user);

    await vi.waitFor(() => expect(observations).toHaveLength(2));
    expect(observations[1]).toMatchObject({ avatarPath: null, avatarVersion: null });
    expect(api.getFile).not.toHaveBeenCalled();
  });
});
