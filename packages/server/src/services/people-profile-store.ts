import type { Database } from "@cos-tool-bot/database";
import { peopleProfiles } from "@cos-tool-bot/database";
import type {
  PeopleProfile,
  PeopleProfileAvatarRefresh,
  PeopleProfileAvatarUpdate,
  PeopleProfileObservation,
} from "@cos-tool-bot/shared";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";

/** Map a Drizzle profile row to the shared PeopleProfile DTO. */
export function mapProfileToDto(p: {
  telegramId: number;
  username: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
  avatarPath: string | null;
  avatarVersion: string | null;
  notes: string | null;
  traits: string[] | null;
  interests: string[] | null;
  relationship: string | null;
  firstSeen: Date;
  lastSeen: Date;
}): PeopleProfile {
  return {
    telegramId: p.telegramId,
    username: p.username,
    displayName: p.displayName,
    firstName: p.firstName,
    lastName: p.lastName,
    languageCode: p.languageCode,
    isPremium: p.isPremium,
    hasAvatar: !!p.avatarPath,
    avatarVersion: p.avatarVersion,
    notes: p.notes,
    traits: p.traits ?? [],
    interests: p.interests ?? [],
    relationship: p.relationship,
    firstSeen: p.firstSeen.toISOString(),
    lastSeen: p.lastSeen.toISOString(),
  };
}

export class PeopleProfileStore {
  constructor(private db: Database) {}

  async getProfile(botId: string, telegramId: number) {
    const [profile] = await this.db
      .select()
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, telegramId)));
    return profile ?? null;
  }

  async getProfileById(botId: string, profileId: number) {
    const [profile] = await this.db
      .select()
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)));
    return profile ?? null;
  }

  async upsertProfile(
    botId: string,
    data: {
      telegramId: number;
      username?: string;
      displayName?: string;
      notes?: string;
      traits?: string[];
      interests?: string[];
      relationship?: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const lockKey = `${botId}:${data.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(peopleProfiles)
        .where(
          and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, data.telegramId)),
        );

      if (existing) {
        const updates: Partial<typeof peopleProfiles.$inferInsert> = {};
        if (data.username !== undefined) updates.username = data.username;
        if (data.displayName !== undefined) updates.displayName = data.displayName;
        if (data.relationship !== undefined) updates.relationship = data.relationship;

        // Notes: append instead of overwrite
        if (data.notes !== undefined) {
          updates.notes = existing.notes ? `${existing.notes}\n${data.notes}` : data.notes;
        }

        // Traits/interests: merge and deduplicate
        if (data.traits !== undefined) {
          const merged = [...new Set([...(existing.traits ?? []), ...data.traits])];
          updates.traits = merged;
        }
        if (data.interests !== undefined) {
          const merged = [...new Set([...(existing.interests ?? []), ...data.interests])];
          updates.interests = merged;
        }

        updates.lastSeen = new Date();

        const [updated] = await tx
          .update(peopleProfiles)
          .set(updates)
          .where(eq(peopleProfiles.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await tx
        .insert(peopleProfiles)
        .values({
          botId,
          telegramId: data.telegramId,
          username: data.username,
          displayName: data.displayName,
          notes: data.notes,
          traits: data.traits ?? [],
          interests: data.interests ?? [],
          relationship: data.relationship,
        })
        .returning();
      return created!;
    });
  }

  async touchProfile(botId: string, observation: PeopleProfileObservation) {
    return this.db.transaction(async (tx) => {
      const lockKey = `${botId}:${observation.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(peopleProfiles)
        .where(
          and(
            eq(peopleProfiles.botId, botId),
            eq(peopleProfiles.telegramId, observation.telegramId),
          ),
        );
      if (existing) {
        await tx
          .update(peopleProfiles)
          .set({
            lastSeen: new Date(),
            displayName: observation.displayName,
            firstName: observation.firstName,
            lastName: observation.lastName,
            languageCode: observation.languageCode,
            isPremium: observation.isPremium,
            username: observation.username,
          })
          .where(eq(peopleProfiles.id, existing.id));
        return {
          created: false,
          profileId: existing.id,
        };
      }
      const [created] = await tx
        .insert(peopleProfiles)
        .values({
          botId,
          telegramId: observation.telegramId,
          displayName: observation.displayName,
          username: observation.username,
          firstName: observation.firstName,
          lastName: observation.lastName,
          languageCode: observation.languageCode,
          isPremium: observation.isPremium,
          traits: [],
          interests: [],
        })
        .returning({ id: peopleProfiles.id });
      return { created: true, profileId: created!.id };
    });
  }

  async beginProfileAvatarRefresh(botId: string, refresh: PeopleProfileAvatarRefresh) {
    return this.db.transaction(async (tx) => {
      const lockKey = `${botId}:${refresh.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [updated] = await tx
        .update(peopleProfiles)
        .set({ avatarRefreshVersion: sql`${peopleProfiles.avatarRefreshVersion} + 1` })
        .where(
          and(
            eq(peopleProfiles.botId, botId),
            eq(peopleProfiles.telegramId, refresh.telegramId),
            eq(peopleProfiles.id, refresh.profileId),
          ),
        )
        .returning({ refreshVersion: peopleProfiles.avatarRefreshVersion });
      return updated?.refreshVersion ?? null;
    });
  }

  async updateProfileAvatar(botId: string, update: PeopleProfileAvatarUpdate) {
    return this.db.transaction(async (tx) => {
      const lockKey = `${botId}:${update.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(peopleProfiles)
        .where(
          and(
            eq(peopleProfiles.botId, botId),
            eq(peopleProfiles.telegramId, update.telegramId),
            eq(peopleProfiles.id, update.profileId),
          ),
        );
      if (!existing) return null;
      if (existing.avatarRefreshVersion !== update.refreshVersion) return null;
      const [updated] = await tx
        .update(peopleProfiles)
        .set({ avatarPath: update.avatarPath, avatarVersion: update.avatarVersion })
        .where(
          and(
            eq(peopleProfiles.botId, botId),
            eq(peopleProfiles.telegramId, update.telegramId),
            eq(peopleProfiles.id, update.profileId),
            eq(peopleProfiles.avatarRefreshVersion, update.refreshVersion),
          ),
        )
        .returning({ id: peopleProfiles.id });
      return updated ? { previousAvatarPath: existing.avatarPath } : null;
    });
  }

  async searchProfiles(botId: string, query: string) {
    const pattern = `%${query}%`;
    const results = await this.db
      .select()
      .from(peopleProfiles)
      .where(
        and(
          eq(peopleProfiles.botId, botId),
          or(
            ilike(peopleProfiles.displayName, pattern),
            ilike(peopleProfiles.username, pattern),
            ilike(peopleProfiles.notes, pattern),
            sql`${peopleProfiles.traits}::text ILIKE ${pattern}`,
            sql`${peopleProfiles.interests}::text ILIKE ${pattern}`,
          ),
        ),
      )
      .orderBy(desc(peopleProfiles.lastSeen))
      .limit(10);
    return results;
  }

  async listProfiles(botId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [profiles, [totalResult]] = await Promise.all([
      this.db
        .select()
        .from(peopleProfiles)
        .where(eq(peopleProfiles.botId, botId))
        .orderBy(desc(peopleProfiles.lastSeen))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(peopleProfiles)
        .where(eq(peopleProfiles.botId, botId)),
    ]);
    return {
      data: profiles.map((p) => ({ id: p.id, ...mapProfileToDto(p) })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async deleteProfile(
    botId: string,
    profileId: number,
    beforeDelete?: (profile: typeof peopleProfiles.$inferSelect) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(peopleProfiles)
        .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)));
      if (!candidate) return null;

      const lockKey = `${botId}:${candidate.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [profile] = await tx
        .select()
        .from(peopleProfiles)
        .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)));
      if (!profile) return null;

      await beforeDelete?.(profile);
      const [deleted] = await tx
        .delete(peopleProfiles)
        .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)))
        .returning({ avatarPath: peopleProfiles.avatarPath });
      return deleted ?? null;
    });
  }

  async updateProfile(
    botId: string,
    profileId: number,
    data: {
      displayName?: string | null;
      username?: string | null;
      notes?: string | null;
      traits?: string[] | null;
      interests?: string[] | null;
      relationship?: string | null;
    },
  ) {
    const updates: Partial<typeof peopleProfiles.$inferInsert> = {};
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.username !== undefined) updates.username = data.username;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.relationship !== undefined) updates.relationship = data.relationship;
    if (data.traits !== undefined) updates.traits = data.traits ?? [];
    if (data.interests !== undefined) updates.interests = data.interests ?? [];

    const [updated] = await this.db
      .update(peopleProfiles)
      .set(updates)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)))
      .returning();
    return updated ?? null;
  }

  async createProfile(
    botId: string,
    data: {
      telegramId: number;
      displayName?: string | null;
      username?: string | null;
      notes?: string | null;
      traits?: string[];
      interests?: string[];
      relationship?: string | null;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const lockKey = `${botId}:${data.telegramId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(peopleProfiles)
        .where(
          and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, data.telegramId)),
        );
      if (existing) return { created: false as const, profile: existing };

      const [created] = await tx
        .insert(peopleProfiles)
        .values({
          botId,
          telegramId: data.telegramId,
          displayName: data.displayName,
          username: data.username,
          notes: data.notes,
          traits: data.traits ?? [],
          interests: data.interests ?? [],
          relationship: data.relationship,
        })
        .returning();
      return { created: true as const, profile: created! };
    });
  }
}
