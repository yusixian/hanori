import type { MemoryCallbacks, PeopleProfileObservation } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { User } from "grammy/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_REFRESH_MS = 5 * 60 * 1000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface ProfilePhotoApi {
  getUserProfilePhotos: Api["getUserProfilePhotos"];
  getFile: Api["getFile"];
}

export interface TelegramProfileObserverOptions {
  memory: MemoryCallbacks;
  token: string;
  dataDir?: string;
  refreshMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
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

export class TelegramProfileObserver {
  private readonly nextRefreshAt = new Map<number, number>();
  private readonly refreshMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TelegramProfileObserverOptions) {
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  observe(api: ProfilePhotoApi, user: User): void {
    const observation = observationFromUser(user);
    const basicTouch = this.options.memory.touchProfile(observation);
    void basicTouch.catch(() => {});

    if (!this.options.dataDir) return;
    const now = this.now();
    if ((this.nextRefreshAt.get(user.id) ?? 0) > now) return;
    this.nextRefreshAt.set(user.id, now + this.refreshMs);

    void basicTouch
      .then(() => this.refreshAvatar(api, observation))
      .catch(() => {
        this.nextRefreshAt.set(user.id, this.now() + RETRY_REFRESH_MS);
      });
  }

  private async refreshAvatar(api: ProfilePhotoApi, observation: PeopleProfileObservation) {
    const photos = await api.getUserProfilePhotos(observation.telegramId, { limit: 1 });
    const sizes = photos.photos[0];
    const photo = sizes?.[sizes.length - 1];
    if (!photo) {
      const avatarPath = path.join(
        this.options.dataDir!,
        path.posix.join("avatars", `${observation.telegramId}.jpg`),
      );
      await fs.unlink(avatarPath).catch(() => {});
      await this.options.memory.touchProfile({
        ...observation,
        avatarPath: null,
        avatarVersion: null,
      });
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

    const relativePath = path.posix.join("avatars", `${observation.telegramId}.jpg`);
    const absolutePath = path.join(this.options.dataDir!, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);
    await this.options.memory.touchProfile({
      ...observation,
      avatarPath: relativePath,
      avatarVersion: photo.file_unique_id,
    });
  }
}
