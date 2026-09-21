import { readProfileAvatarFile } from "@cos-tool-bot/bot";
import type { PeopleProfileAvatarResult, UserPrivacyMode } from "@cos-tool-bot/shared";
import type { PeopleProfileStore } from "./people-profile-store.js";
import type { UserPrivacyService } from "./user-privacy-service.js";

type ProfileReader = Pick<PeopleProfileStore, "getProfile">;
type PrivacyReader = Pick<UserPrivacyService, "getMode" | "runLibraryExclusiveMany">;

export class PeopleProfileAvatarService {
  constructor(
    private readonly profiles: ProfileReader,
    private readonly privacy: PrivacyReader,
  ) {}

  async getProfileAvatar(
    botId: string,
    dataDir: string,
    telegramId: number,
    requesterTelegramId: number,
  ): Promise<PeopleProfileAvatarResult> {
    if (
      !Number.isSafeInteger(telegramId) ||
      telegramId <= 0 ||
      !Number.isSafeInteger(requesterTelegramId) ||
      requesterTelegramId <= 0
    ) {
      return { status: "forbidden" };
    }

    try {
      return await this.privacy.runLibraryExclusiveMany(
        botId,
        [requesterTelegramId, telegramId],
        async () => {
          const requesterMode = await this.privacy.getMode(botId, requesterTelegramId);
          if (requesterMode === "off") return { status: "forbidden" };

          const targetMode: UserPrivacyMode =
            telegramId === requesterTelegramId
              ? requesterMode
              : await this.privacy.getMode(botId, telegramId);
          if (telegramId !== requesterTelegramId && targetMode !== "normal") {
            return { status: "forbidden" };
          }

          const profile = await this.profiles.getProfile(botId, telegramId);
          if (!profile) return { status: "not_found" };
          if (!profile.avatarPath) return { status: "no_avatar" };

          try {
            const avatar = await readProfileAvatarFile(dataDir, profile.avatarPath, telegramId);
            return {
              status: "available",
              telegramId,
              avatarVersion: profile.avatarVersion,
              ...avatar,
            };
          } catch {
            return { status: "cache_unavailable" };
          }
        },
      );
    } catch {
      // Privacy or persistence failures must never fall back to an unguarded cache read.
      return { status: "unavailable" };
    }
  }
}
