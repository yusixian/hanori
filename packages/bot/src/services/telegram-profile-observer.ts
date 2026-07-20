import type { MemoryCallbacks, PeopleProfileObservation } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { PhotoSize, User } from "grammy/types";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanupProfileAvatarFiles, removeProfileAvatarFile } from "./profile-avatar-files.js";

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_REFRESH_MS = 5 * 60 * 1000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface ProfilePhotoApi {
  getUserProfilePhotos: Api["getUserProfilePhotos"];
  getFile: Api["getFile"];
}

interface PendingTouchState {
  latest: PeopleProfileObservation | null;
}

export interface TelegramProfileObserverOptions {
  memory: MemoryCallbacks;
  token: string;
  dataDir?: string;
  refreshMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (error: unknown) => void | Promise<void>;
}

function observationFromUser(user: User): PeopleProfileObservation {
  return {
    telegramId: user.id,
    username: user.username ?? null,
    displayName:
      user.first_name && user.last_name
        ? `${user.first_name} ${user.last_name}`
        : user.first_name || user.username || "Unknown",
    firstName: user.first_name,
    lastName: user.last_name ?? null,
    languageCode: user.language_code ?? null,
    isPremium: user.is_premium === true,
  };
}

function largestPhoto(sizes: PhotoSize[] | undefined): PhotoSize | undefined {
  return sizes
    ?.filter(({ width, height }) => width > 0 && height > 0)
    .reduce<PhotoSize | undefined>((largest, candidate) => {
      if (!largest) return candidate;
      const areaDifference = candidate.width * candidate.height - largest.width * largest.height;
      if (areaDifference !== 0) return areaDifference > 0 ? candidate : largest;
      const sizeDifference = (candidate.file_size ?? 0) - (largest.file_size ?? 0);
      if (sizeDifference !== 0) return sizeDifference > 0 ? candidate : largest;
      if (candidate.width !== largest.width)
        return candidate.width > largest.width ? candidate : largest;
      if (candidate.height !== largest.height)
        return candidate.height > largest.height ? candidate : largest;
      return candidate.file_unique_id.localeCompare(largest.file_unique_id) > 0
        ? candidate
        : largest;
    }, undefined);
}

export class TelegramProfileObserver {
  private readonly nextRefreshAt = new Map<number, number>();
  private readonly pendingTouches = new Map<number, PendingTouchState>();
  private readonly refreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TelegramProfileObserverOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private reportError(error: unknown) {
    try {
      void Promise.resolve(this.options.onError?.(error)).catch(() => {});
    } catch {
      // Error reporting must not create another unhandled rejection.
    }
  }

  private enqueueTouch(observation: PeopleProfileObservation): Promise<void> | null {
    const existing = this.pendingTouches.get(observation.telegramId);
    if (existing) {
      existing.latest = observation;
      return null;
    }

    const firstTouch = Promise.resolve().then(() => this.options.memory.touchProfile(observation));
    const state: PendingTouchState = { latest: null };
    void (async () => {
      await firstTouch.catch(() => {});
      while (state.latest) {
        const latest = state.latest;
        state.latest = null;
        await this.options.memory.touchProfile(latest).catch(() => {});
      }
      if (this.pendingTouches.get(observation.telegramId) === state) {
        this.pendingTouches.delete(observation.telegramId);
      }
    })();
    this.pendingTouches.set(observation.telegramId, state);
    return firstTouch;
  }

  observe(api: ProfilePhotoApi, user: User): void {
    const observation = observationFromUser(user);
    const firstTouch = this.enqueueTouch(observation);

    if (!firstTouch || !this.options.dataDir) return;
    const now = this.now();
    if ((this.nextRefreshAt.get(user.id) ?? 0) > now) return;
    this.nextRefreshAt.set(user.id, now + this.refreshMs);

    void firstTouch
      .then(() => this.refreshAvatar(api, observation))
      .catch((error) => {
        this.nextRefreshAt.set(user.id, this.now() + RETRY_REFRESH_MS);
        this.reportError(error);
      });
  }

  private async refreshAvatar(api: ProfilePhotoApi, observation: PeopleProfileObservation) {
    const photos = await api.getUserProfilePhotos(observation.telegramId, { limit: 1 });
    const sizes = photos.photos[0];
    const photo = largestPhoto(sizes);
    if (!photo) {
      await this.options.memory.updateProfileAvatar({
        telegramId: observation.telegramId,
        avatarPath: null,
        avatarVersion: null,
      });
      await cleanupProfileAvatarFiles(this.options.dataDir!, observation.telegramId);
      return;
    }

    const file = await api.getFile(photo.file_id);
    if (!file.file_path) throw new Error("Telegram profile photo has no file path");
    const response = await this.fetchImpl(
      `https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`Telegram profile photo download failed: ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_AVATAR_BYTES) throw new Error("Telegram profile photo is too large");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_AVATAR_BYTES)
      throw new Error("Telegram profile photo is too large");

    const version = Buffer.from(photo.file_unique_id).toString("base64url");
    const relativePath = path.posix.join(
      "avatars",
      `${observation.telegramId}-${version}-${randomUUID()}.jpg`,
    );
    const absolutePath = path.join(this.options.dataDir!, relativePath);
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      try {
        await removeProfileAvatarFile(this.options.dataDir!, temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Avatar write and cleanup failed");
      }
      throw error;
    }

    let result;
    try {
      result = await this.options.memory.updateProfileAvatar({
        telegramId: observation.telegramId,
        avatarPath: relativePath,
        avatarVersion: photo.file_unique_id,
      });
    } catch (error) {
      try {
        await removeProfileAvatarFile(this.options.dataDir!, absolutePath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Avatar update and cleanup failed");
      }
      throw error;
    }
    if (!result) {
      await cleanupProfileAvatarFiles(this.options.dataDir!, observation.telegramId);
      return;
    }
    await cleanupProfileAvatarFiles(this.options.dataDir!, observation.telegramId, relativePath);
  }
}
