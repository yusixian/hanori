import type { Database } from "@cos-tool-bot/database";
import { peopleProfiles } from "@cos-tool-bot/database";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";

export class PeopleProfileStore {
  constructor(private db: Database) {}

  async getProfile(botId: string, telegramId: number) {
    const [profile] = await this.db
      .select()
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, telegramId)));
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
    const existing = await this.getProfile(botId, data.telegramId);

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

      const [updated] = await this.db
        .update(peopleProfiles)
        .set(updates)
        .where(eq(peopleProfiles.id, existing.id))
        .returning();
      return updated!;
    }

    const [created] = await this.db
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
  }

  async touchProfile(botId: string, telegramId: number, displayName: string, username?: string) {
    const existing = await this.getProfile(botId, telegramId);
    if (existing) {
      await this.db
        .update(peopleProfiles)
        .set({ lastSeen: new Date(), displayName, username: username ?? existing.username })
        .where(eq(peopleProfiles.id, existing.id));
    } else {
      await this.db.insert(peopleProfiles).values({
        botId,
        telegramId,
        displayName,
        username,
        traits: [],
        interests: [],
      });
    }
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
      data: profiles.map((p) => ({
        id: p.id,
        telegramId: p.telegramId,
        username: p.username,
        displayName: p.displayName,
        notes: p.notes,
        traits: p.traits,
        interests: p.interests,
        relationship: p.relationship,
        firstSeen: p.firstSeen.toISOString(),
        lastSeen: p.lastSeen.toISOString(),
      })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async deleteProfile(botId: string, profileId: number) {
    await this.db
      .delete(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.id, profileId)));
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
    const [created] = await this.db
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
    return created!;
  }
}
