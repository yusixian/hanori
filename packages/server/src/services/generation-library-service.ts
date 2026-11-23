import type { Database } from "@cos-tool-bot/database";
import {
  generationCharacters,
  generationLibraryConfigs,
  peopleCharacterBindings,
  peopleProfiles,
  promptAssets,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import {
  DEFAULT_GENERATION_LIBRARY_SETTINGS,
  GenerationLibraryError,
  type GenerationLibraryErrorCode,
  type CharacterBinding,
  type CharacterInput,
  type DanbooruCharacterResult,
  type GenerationLibraryActor,
  type GenerationLibraryPort,
  type GenerationLibrarySettings,
  type GenerationMaterialSelection,
  type GenerationMaterialSnapshot,
  type LibraryCharacter,
  type LibraryListQuery,
  type LibraryPage,
  type PromptAsset,
  type PromptAssetInput,
} from "@cos-tool-bot/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import type { UserPrivacyService } from "./user-privacy-service.js";

const TELEGRAM_ID_MAX = 9_007_199_254_740_991;
const MAX_SELECTIONS = 20;
const MAX_PROMPT_LENGTH = 8_000;

const telegramIdSchema = z.number().int().positive().max(TELEGRAM_ID_MAX);
const idSchema = z.number().int().positive();
const characterInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    aliases: z.array(z.string().trim().min(1).max(160)).max(100),
    appearance: z.string().trim().max(4_000),
    defaultOutfit: z.string().trim().max(2_000),
    notes: z.string().trim().max(4_000),
    copyright: z.string().trim().max(200).optional(),
    ownerTelegramId: telegramIdSchema.optional(),
  })
  .strict();
const assetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(["artist_string", "style", "outfit", "trait", "composition"]),
    content: z.string().trim().min(1).max(8_000),
    notes: z.string().trim().max(4_000),
    safety: z.enum(["safe", "nsfw"]),
    pinned: z.boolean(),
  })
  .strict();
const settingsSchema = z
  .object({
    charactersEnabled: z.boolean(),
    assetsEnabled: z.boolean(),
    injectionEnabled: z.boolean(),
    nsfwEnabled: z.boolean(),
  })
  .strict();
const listQuerySchema = z
  .object({
    search: z.string().trim().max(160).optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    source: z.enum(["danbooru", "original"]).optional(),
    type: z.enum(["artist_string", "style", "outfit", "trait", "composition"]).optional(),
    safety: z.enum(["safe", "nsfw"]).optional(),
    sort: z.enum(["frequency", "recent"]).optional(),
  })
  .strict();
const materialSelectionSchema = z
  .object({
    characterIds: z.array(idSchema).max(MAX_SELECTIONS).optional(),
    personTelegramId: telegramIdSchema.optional(),
    assetIds: z.array(idSchema).max(MAX_SELECTIONS).optional(),
    excludedAssetIds: z.array(idSchema).max(100).optional(),
    skipPinned: z.boolean().optional(),
    skipDefaultOutfit: z.boolean().optional(),
    safetyMode: z.enum(["safe", "nsfw"]).optional(),
    skipLibrary: z.boolean().optional(),
  })
  .strict();
const bindingInputSchema = z
  .object({
    characterId: idSchema,
    relation: z.enum(["representation", "favorite"]),
    isDefault: z.boolean(),
  })
  .strict();

export { GenerationLibraryError, type GenerationLibraryErrorCode } from "@cos-tool-bot/shared";

type CharacterRow = typeof generationCharacters.$inferSelect & { bindingCount?: number };
type AssetRow = typeof promptAssets.$inferSelect;

export class GenerationLibraryService implements GenerationLibraryPort {
  constructor(
    private readonly db: Database,
    private readonly privacyService: UserPrivacyService,
  ) {}

  async getSettings(actor: GenerationLibraryActor): Promise<GenerationLibrarySettings> {
    this.assertActor(actor);
    const [row] = await this.db
      .select({ settings: generationLibraryConfigs.settings })
      .from(generationLibraryConfigs)
      .where(eq(generationLibraryConfigs.botId, actor.botId))
      .limit(1);
    return settingsSchema.parse(row?.settings ?? DEFAULT_GENERATION_LIBRARY_SETTINGS);
  }

  async updateSettings(
    actor: GenerationLibraryActor,
    input: GenerationLibrarySettings,
  ): Promise<GenerationLibrarySettings> {
    this.assertAdmin(actor);
    const settings = this.parse(settingsSchema, input);
    await this.db
      .insert(generationLibraryConfigs)
      .values({ botId: actor.botId, settings })
      .onConflictDoUpdate({
        target: generationLibraryConfigs.botId,
        set: { settings },
      });
    return settings;
  }

  async listCharacters(
    actor: GenerationLibraryActor,
    input: LibraryListQuery = {},
    countQuery = false,
  ): Promise<LibraryPage<LibraryCharacter>> {
    this.assertActor(actor);
    if (actor.source === "telegram" && !(await this.getSettings(actor)).charactersEnabled) {
      throw this.error("characters_disabled", "Character library is disabled");
    }
    const query = this.parse(listQuerySchema, input);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.characterWhere(actor, query);
    const bindingCount = sql<number>`(
      select count(*)::int from ${peopleCharacterBindings}
      where ${peopleCharacterBindings.botId} = ${generationCharacters.botId}
        and ${peopleCharacterBindings.characterId} = ${generationCharacters.id}
    )`;
    const order =
      query.sort === "frequency"
        ? [desc(generationCharacters.queryCount), asc(generationCharacters.id)]
        : [desc(generationCharacters.updatedAt), asc(generationCharacters.id)];

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({ ...this.characterColumns(), bindingCount })
        .from(generationCharacters)
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ value: count() }).from(generationCharacters).where(where),
    ]);

    if (countQuery && rows.length > 0) {
      const ids = rows.map((row) => row.id);
      const queriedAt = new Date();
      await this.db
        .update(generationCharacters)
        .set({
          queryCount: sql`${generationCharacters.queryCount} + 1`,
          firstQueriedAt: sql`coalesce(${generationCharacters.firstQueriedAt}, ${queriedAt.toISOString()}::timestamp)`,
          lastQueriedAt: queriedAt,
        })
        .where(
          and(eq(generationCharacters.botId, actor.botId), inArray(generationCharacters.id, ids)),
        );
      for (const row of rows) {
        row.queryCount += 1;
        row.firstQueriedAt ??= queriedAt;
        row.lastQueriedAt = queriedAt;
      }
    }

    return { data: rows.map(toCharacter), total: totalRows[0]?.value ?? 0 };
  }

  async saveCharacter(
    actor: GenerationLibraryActor,
    rawInput: CharacterInput,
    rawId?: number,
  ): Promise<LibraryCharacter> {
    this.assertActor(actor);
    const input = normalizeCharacterInput(this.parse(characterInputSchema, rawInput));
    const id = rawId === undefined ? undefined : this.parse(idSchema, rawId);
    if (actor.source === "panel" && !actor.isAdmin) this.forbidden();
    if (actor.source === "telegram" && !actor.telegramUserId) this.forbidden();

    const current = id === undefined ? undefined : await this.getRawCharacter(actor.botId, id);
    if (id !== undefined && !current) throw this.error("not_found", "Character not found");
    if (current?.source === "danbooru") {
      this.assertAdmin(actor);
      // Curated annotations are independent of source fields; a refresh never overwrites them.
      const [saved] = await this.db
        .update(generationCharacters)
        .set({
          appearance: input.appearance,
          defaultOutfit: input.defaultOutfit,
          notes: input.notes,
          copyright: input.copyright || null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(generationCharacters.botId, actor.botId),
            eq(generationCharacters.id, current.id),
            eq(generationCharacters.source, "danbooru"),
          ),
        )
        .returning();
      if (!saved) throw this.error("not_found", "Character not found");
      return toCharacter({
        ...saved,
        bindingCount: await this.getBindingCount(actor.botId, saved.id),
      });
    }

    const telegramActorId = actor.source === "telegram" ? actor.telegramUserId! : undefined;
    if (
      current &&
      input.ownerTelegramId !== undefined &&
      input.ownerTelegramId !== current.ownerTelegramId
    ) {
      throw this.error("invalid_input", "An original character's creator cannot be reassigned");
    }
    if (!actor.isAdmin && current && current.ownerTelegramId !== telegramActorId) this.forbidden();
    if (
      !actor.isAdmin &&
      input.ownerTelegramId !== undefined &&
      input.ownerTelegramId !== telegramActorId
    ) {
      this.forbidden("Cannot assign an original character to another user");
    }
    const ownerTelegramId = actor.isAdmin
      ? id === undefined
        ? (input.ownerTelegramId ?? telegramActorId ?? null)
        : (input.ownerTelegramId ?? current?.ownerTelegramId ?? null)
      : (current?.ownerTelegramId ?? telegramActorId!);
    const lockIds = [current?.ownerTelegramId, ownerTelegramId].filter(
      (value): value is number => value !== null && value !== undefined,
    );

    return this.privacyService.runLibraryExclusiveMany(actor.botId, lockIds, async () => {
      const lockedCurrent =
        id === undefined ? undefined : await this.getRawCharacter(actor.botId, id);
      if (id !== undefined && !lockedCurrent) throw this.error("not_found", "Character not found");
      if (lockedCurrent?.source === "danbooru") {
        this.forbidden("Danbooru source records are read-only");
      }
      if (!actor.isAdmin && lockedCurrent && lockedCurrent.ownerTelegramId !== telegramActorId) {
        this.forbidden();
      }
      const effectiveOwnerTelegramId =
        actor.isAdmin && id !== undefined && input.ownerTelegramId === undefined
          ? (lockedCurrent?.ownerTelegramId ?? null)
          : ownerTelegramId;
      if (effectiveOwnerTelegramId !== null) {
        await this.assertAssignableOwner(actor, effectiveOwnerTelegramId);
      }
      if (lockedCurrent?.ownerTelegramId && !actor.isAdmin) {
        await this.assertPrivacyWritable(actor.botId, lockedCurrent.ownerTelegramId);
      }
      const values = {
        name: input.name,
        aliases: input.aliases,
        appearance: input.appearance,
        defaultOutfit: input.defaultOutfit,
        notes: input.notes,
        copyright: input.copyright || null,
        ownerTelegramId: effectiveOwnerTelegramId,
        updatedAt: new Date(),
      };
      const [saved] =
        id === undefined
          ? await this.db
              .insert(generationCharacters)
              .values({ botId: actor.botId, source: "original", canonicalTag: null, ...values })
              .returning()
          : await this.db
              .update(generationCharacters)
              .set(values)
              .where(
                and(
                  eq(generationCharacters.botId, actor.botId),
                  eq(generationCharacters.id, id),
                  eq(generationCharacters.source, "original"),
                  actor.isAdmin
                    ? undefined
                    : eq(generationCharacters.ownerTelegramId, telegramActorId!),
                ),
              )
              .returning();
      if (!saved) throw this.error("not_found", "Character not found");
      return toCharacter({
        ...saved,
        bindingCount: await this.getBindingCount(actor.botId, saved.id),
      });
    });
  }

  async deleteCharacter(actor: GenerationLibraryActor, rawId: number): Promise<void> {
    this.assertActor(actor);
    const id = this.parse(idSchema, rawId);
    if (actor.source === "panel" && !actor.isAdmin) this.forbidden();
    const current = await this.getRawCharacter(actor.botId, id);
    if (!current) throw this.error("not_found", "Character not found");
    if (
      !actor.isAdmin &&
      (actor.source !== "telegram" ||
        current.source !== "original" ||
        current.ownerTelegramId !== actor.telegramUserId)
    ) {
      this.forbidden();
    }
    const owner = current.ownerTelegramId;
    const operation = async () => {
      const lockedCurrent = await this.getRawCharacter(actor.botId, id);
      if (!lockedCurrent) throw this.error("not_found", "Character not found");
      if (
        !actor.isAdmin &&
        (lockedCurrent.source !== "original" ||
          lockedCurrent.ownerTelegramId !== actor.telegramUserId)
      ) {
        this.forbidden();
      }
      if (lockedCurrent.ownerTelegramId !== null && !actor.isAdmin) {
        await this.assertPrivacyWritable(actor.botId, lockedCurrent.ownerTelegramId);
      }
      const deleted = await this.db
        .delete(generationCharacters)
        .where(
          and(
            eq(generationCharacters.botId, actor.botId),
            eq(generationCharacters.id, id),
            actor.isAdmin
              ? undefined
              : and(
                  eq(generationCharacters.source, "original"),
                  eq(generationCharacters.ownerTelegramId, actor.telegramUserId!),
                ),
          ),
        )
        .returning({ id: generationCharacters.id });
      if (deleted.length === 0) throw this.error("not_found", "Character not found");
    };
    if (owner === null) return operation();
    return this.privacyService.runLibraryExclusiveMany(actor.botId, [owner], operation);
  }

  async recordDanbooru(
    actor: GenerationLibraryActor,
    rawResults: DanbooruCharacterResult[],
    fetchedAt: Date,
  ): Promise<void> {
    this.assertActor(actor);
    if (actor.source === "telegram" && !(await this.getSettings(actor)).charactersEnabled) {
      throw this.error("characters_disabled", "Character library is disabled");
    }
    if (!(fetchedAt instanceof Date) || Number.isNaN(fetchedAt.getTime())) {
      throw this.error("invalid_input", "Invalid source fetch time");
    }
    const results = dedupeDanbooruResults(rawResults).sort((left, right) =>
      left.tag.localeCompare(right.tag),
    );
    if (results.length === 0) return;
    const queriedAt = new Date();
    await this.db.transaction(async (tx) => {
      for (const result of results) {
        const aliases = uniqueStrings([
          ...result.otherNames,
          ...(result.matchedAlias ? [result.matchedAlias] : []),
        ]).filter((alias) => alias !== result.tag);
        const [stored] = await tx
          .insert(generationCharacters)
          .values({
            botId: actor.botId,
            source: "danbooru",
            canonicalTag: result.tag,
            name: result.label,
            aliases,
            appearance: "",
            defaultOutfit: "",
            notes: "",
            postCount: result.postCount ?? null,
            wikiSummary: result.wikiSummary ?? null,
            sourceUrl: result.postsUrl,
            sourceFetchedAt: fetchedAt,
            queryCount: 1,
            firstQueriedAt: queriedAt,
            lastQueriedAt: queriedAt,
          })
          .onConflictDoUpdate({
            target: [
              generationCharacters.botId,
              generationCharacters.source,
              generationCharacters.canonicalTag,
            ],
            set: {
              queryCount: sql`${generationCharacters.queryCount} + 1`,
              firstQueriedAt: sql`coalesce(${generationCharacters.firstQueriedAt}, ${queriedAt.toISOString()}::timestamp)`,
              lastQueriedAt: queriedAt,
              updatedAt: queriedAt,
            },
          })
          .returning({ aliases: generationCharacters.aliases });
        const mergedAliases = uniqueStrings([...(stored?.aliases ?? []), ...aliases]);
        await tx
          .update(generationCharacters)
          .set({
            name: result.label,
            aliases: mergedAliases,
            ...(result.postCount === undefined ? {} : { postCount: result.postCount }),
            ...(result.wikiSummary === undefined ? {} : { wikiSummary: result.wikiSummary }),
            sourceUrl: result.postsUrl,
            sourceFetchedAt: fetchedAt,
          })
          .where(
            and(
              eq(generationCharacters.botId, actor.botId),
              eq(generationCharacters.source, "danbooru"),
              eq(generationCharacters.canonicalTag, result.tag),
              or(
                isNull(generationCharacters.sourceFetchedAt),
                lte(generationCharacters.sourceFetchedAt, fetchedAt),
              ),
            ),
          );
      }
    });
  }

  async getBindings(
    actor: GenerationLibraryActor,
    rawTelegramId: number,
  ): Promise<CharacterBinding[]> {
    this.assertActor(actor);
    if (actor.source === "telegram" && !(await this.getSettings(actor)).charactersEnabled) {
      throw this.error("characters_disabled", "Character library is disabled");
    }
    const telegramId = this.parse(telegramIdSchema, rawTelegramId);
    return this.withBindingPrivacy(actor, telegramId, false, async () => {
      const profile = await this.getProfile(actor.botId, telegramId);
      if (!profile) return [];
      const visibility = this.characterVisibility(actor);
      const rows = await this.db
        .select({
          characterId: peopleCharacterBindings.characterId,
          relation: peopleCharacterBindings.relation,
          isDefault: peopleCharacterBindings.isDefault,
          ...this.characterColumns(),
          bindingCount: sql<number>`(
            select count(*)::int from ${peopleCharacterBindings} as binding_count
            where binding_count.bot_id = ${generationCharacters.botId}
              and binding_count.character_id = ${generationCharacters.id}
          )`,
        })
        .from(peopleCharacterBindings)
        .innerJoin(
          generationCharacters,
          and(
            eq(generationCharacters.botId, peopleCharacterBindings.botId),
            eq(generationCharacters.id, peopleCharacterBindings.characterId),
          ),
        )
        .where(
          and(
            eq(peopleCharacterBindings.botId, actor.botId),
            eq(peopleCharacterBindings.profileId, profile.id),
            visibility,
          ),
        )
        .orderBy(desc(peopleCharacterBindings.isDefault), asc(generationCharacters.id));
      return rows.map((row) => ({
        characterId: row.characterId,
        relation: row.relation,
        isDefault: row.isDefault,
        character: toCharacter(row),
      }));
    });
  }

  async setBinding(
    actor: GenerationLibraryActor,
    rawTelegramId: number,
    rawInput: { characterId: number; relation: "representation" | "favorite"; isDefault: boolean },
  ): Promise<void> {
    this.assertActor(actor);
    const telegramId = this.parse(telegramIdSchema, rawTelegramId);
    const input = this.parse(bindingInputSchema, rawInput);
    if (input.isDefault && input.relation !== "representation") {
      throw this.error("invalid_input", "Only a representation can be the default character");
    }
    await this.withBindingPrivacy(actor, telegramId, true, async () => {
      const character = await this.getVisibleCharacter(actor, input.characterId);
      if (!character) throw this.error("not_found", "Character not found");
      const profile = await this.getOrCreateBindingProfile(actor, telegramId);
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${actor.botId}), ${profile.id})`,
        );
        if (input.isDefault) {
          await tx
            .update(peopleCharacterBindings)
            .set({ isDefault: false })
            .where(
              and(
                eq(peopleCharacterBindings.botId, actor.botId),
                eq(peopleCharacterBindings.profileId, profile.id),
                eq(peopleCharacterBindings.isDefault, true),
              ),
            );
        }
        await tx
          .insert(peopleCharacterBindings)
          .values({ botId: actor.botId, profileId: profile.id, ...input })
          .onConflictDoUpdate({
            target: [
              peopleCharacterBindings.botId,
              peopleCharacterBindings.profileId,
              peopleCharacterBindings.characterId,
              peopleCharacterBindings.relation,
            ],
            set: { isDefault: input.isDefault },
          });
      });
    });
  }

  async removeBinding(
    actor: GenerationLibraryActor,
    rawTelegramId: number,
    rawCharacterId: number,
    rawRelation: "representation" | "favorite",
  ): Promise<void> {
    this.assertActor(actor);
    const telegramId = this.parse(telegramIdSchema, rawTelegramId);
    const characterId = this.parse(idSchema, rawCharacterId);
    const relation = this.parse(z.enum(["representation", "favorite"]), rawRelation);
    await this.withBindingPrivacy(actor, telegramId, true, async () => {
      const profile = await this.getProfile(actor.botId, telegramId);
      if (!profile) return;
      await this.db
        .delete(peopleCharacterBindings)
        .where(
          and(
            eq(peopleCharacterBindings.botId, actor.botId),
            eq(peopleCharacterBindings.profileId, profile.id),
            eq(peopleCharacterBindings.characterId, characterId),
            eq(peopleCharacterBindings.relation, relation),
          ),
        );
    });
  }

  async listAssets(
    actor: GenerationLibraryActor,
    input: LibraryListQuery = {},
  ): Promise<LibraryPage<PromptAsset>> {
    this.assertActor(actor);
    const query = this.parse(listQuerySchema, input);
    if (actor.source === "telegram") {
      const settings = await this.getSettings(actor);
      if (!settings.assetsEnabled) {
        throw this.error("assets_disabled", "Prompt asset library is disabled");
      }
      if (query.safety === "nsfw" && !settings.nsfwEnabled) {
        throw this.error("nsfw_disabled", "NSFW generation-library materials are disabled");
      }
      query.safety ??= "safe";
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const conditions: SQL[] = [eq(promptAssets.botId, actor.botId)];
    if (query.type) conditions.push(eq(promptAssets.type, query.type));
    if (query.safety) conditions.push(eq(promptAssets.safety, query.safety));
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(
        or(
          ilike(promptAssets.name, pattern),
          ilike(promptAssets.content, pattern),
          ilike(promptAssets.notes, pattern),
        )!,
      );
    }
    const where = and(...conditions)!;
    const order =
      query.sort === "frequency"
        ? [desc(promptAssets.useCount), asc(promptAssets.id)]
        : [desc(promptAssets.updatedAt), asc(promptAssets.id)];
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(promptAssets)
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ value: count() }).from(promptAssets).where(where),
    ]);
    return { data: rows.map(toAsset), total: totalRows[0]?.value ?? 0 };
  }

  async saveAsset(
    actor: GenerationLibraryActor,
    rawInput: PromptAssetInput,
    rawId?: number,
  ): Promise<PromptAsset> {
    this.assertAdmin(actor);
    const input = this.parse(assetInputSchema, rawInput);
    const id = rawId === undefined ? undefined : this.parse(idSchema, rawId);
    const values = { ...input, updatedAt: new Date() };
    const [saved] =
      id === undefined
        ? await this.db
            .insert(promptAssets)
            .values({ botId: actor.botId, ...values })
            .returning()
        : await this.db
            .update(promptAssets)
            .set(values)
            .where(and(eq(promptAssets.botId, actor.botId), eq(promptAssets.id, id)))
            .returning();
    if (!saved) throw this.error("not_found", "Prompt asset not found");
    return toAsset(saved);
  }

  async deleteAsset(actor: GenerationLibraryActor, rawId: number): Promise<void> {
    this.assertAdmin(actor);
    const id = this.parse(idSchema, rawId);
    const deleted = await this.db
      .delete(promptAssets)
      .where(and(eq(promptAssets.botId, actor.botId), eq(promptAssets.id, id)))
      .returning({ id: promptAssets.id });
    if (deleted.length === 0) throw this.error("not_found", "Prompt asset not found");
  }

  async resolveMaterials(
    actor: GenerationLibraryActor,
    rawPrompt: string,
    rawSelection: GenerationMaterialSelection,
  ): Promise<{ prompt: string; snapshot: GenerationMaterialSnapshot }> {
    this.assertActor(actor);
    const prompt = this.parse(z.string().trim().min(1).max(MAX_PROMPT_LENGTH), rawPrompt);
    const selection = this.parse(materialSelectionSchema, rawSelection);
    const safetyMode = selection.safetyMode ?? "safe";
    if (selection.skipLibrary) return { prompt, snapshot: emptySnapshot(prompt, safetyMode) };

    const settings = await this.getSettings(actor);
    if (safetyMode === "nsfw" && !settings.nsfwEnabled) {
      throw this.error("nsfw_disabled", "NSFW generation-library materials are disabled");
    }
    const explicitCharacterIds = uniqueNumbers(selection.characterIds ?? []);
    const explicitAssetIds = uniqueNumbers(selection.assetIds ?? []);
    if (explicitCharacterIds.length + explicitAssetIds.length > MAX_SELECTIONS) {
      throw this.error("too_many_selections", `Select at most ${MAX_SELECTIONS} library items`);
    }
    if (
      (explicitCharacterIds.length > 0 || selection.personTelegramId !== undefined) &&
      !settings.charactersEnabled
    ) {
      throw this.error("characters_disabled", "Character library is disabled");
    }
    if (explicitAssetIds.length > 0 && !settings.assetsEnabled) {
      throw this.error("assets_disabled", "Prompt asset library is disabled");
    }

    let characterIds = explicitCharacterIds;
    if (characterIds.length === 0 && selection.personTelegramId !== undefined) {
      const bindings = await this.getBindings(actor, selection.personTelegramId);
      const selected = bindings.find(
        (binding) => binding.relation === "representation" && binding.isDefault,
      );
      if (!selected) {
        throw this.error(
          "no_default_character",
          "This person has no default representation character",
        );
      }
      characterIds = [selected.characterId];
    }
    const characters = await this.getVisibleCharacters(actor, characterIds);
    if (characters.length !== characterIds.length) {
      throw this.error("not_found", "One or more selected characters are unavailable");
    }

    const explicitAssets = await this.getAssetsByIds(actor.botId, explicitAssetIds);
    if (explicitAssets.length !== explicitAssetIds.length) {
      throw this.error("not_found", "One or more selected prompt assets are unavailable");
    }
    if (explicitAssets.some((asset) => asset.safety === "nsfw") && safetyMode !== "nsfw") {
      throw this.error("forbidden", "NSFW prompt assets require NSFW mode");
    }

    let assets = explicitAssets;
    if (settings.assetsEnabled && settings.injectionEnabled && !selection.skipPinned) {
      const excluded = new Set(selection.excludedAssetIds ?? []);
      const explicit = new Set(explicitAssetIds);
      const pinned = await this.db
        .select()
        .from(promptAssets)
        .where(
          and(
            eq(promptAssets.botId, actor.botId),
            eq(promptAssets.pinned, true),
            safetyMode === "safe" ? eq(promptAssets.safety, "safe") : undefined,
          ),
        )
        .orderBy(asc(promptAssets.id));
      assets = [
        ...explicitAssets,
        ...pinned.filter((asset) => !explicit.has(asset.id) && !excluded.has(asset.id)),
      ];
    }
    if (characters.length + assets.length > MAX_SELECTIONS) {
      throw this.error(
        "too_many_selections",
        `Resolved library materials exceed ${MAX_SELECTIONS} items`,
      );
    }

    const orderedCharacters = [...characters].sort((left, right) => left.id - right.id);
    const orderedAssets = [...assets].sort((left, right) => left.id - right.id);
    const characterSnapshots = orderedCharacters.map((character) => ({
      id: character.id,
      name: character.name,
      content: characterPromptContent(character, selection.skipDefaultOutfit === true),
      version: character.updatedAt.toISOString(),
    }));
    const assetSnapshots = orderedAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      content: asset.content,
      version: asset.updatedAt.toISOString(),
    }));
    const resolvedPrompt = [
      ...characterSnapshots.map((entry) => entry.content),
      ...assetSnapshots.map((entry) => entry.content),
      prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (resolvedPrompt.length > MAX_PROMPT_LENGTH) {
      throw this.error(
        "prompt_too_long",
        `Resolved prompt exceeds ${MAX_PROMPT_LENGTH} characters`,
      );
    }
    return {
      prompt: resolvedPrompt,
      snapshot: {
        originalPrompt: prompt,
        safetyMode,
        characters: characterSnapshots,
        assets: assetSnapshots,
      },
    };
  }

  private characterColumns() {
    return {
      id: generationCharacters.id,
      botId: generationCharacters.botId,
      source: generationCharacters.source,
      canonicalTag: generationCharacters.canonicalTag,
      name: generationCharacters.name,
      aliases: generationCharacters.aliases,
      appearance: generationCharacters.appearance,
      defaultOutfit: generationCharacters.defaultOutfit,
      notes: generationCharacters.notes,
      copyright: generationCharacters.copyright,
      ownerTelegramId: generationCharacters.ownerTelegramId,
      postCount: generationCharacters.postCount,
      wikiSummary: generationCharacters.wikiSummary,
      sourceUrl: generationCharacters.sourceUrl,
      sourceFetchedAt: generationCharacters.sourceFetchedAt,
      queryCount: generationCharacters.queryCount,
      firstQueriedAt: generationCharacters.firstQueriedAt,
      lastQueriedAt: generationCharacters.lastQueriedAt,
      createdAt: generationCharacters.createdAt,
      updatedAt: generationCharacters.updatedAt,
    };
  }

  private characterWhere(actor: GenerationLibraryActor, query: LibraryListQuery): SQL {
    const conditions: SQL[] = [
      eq(generationCharacters.botId, actor.botId),
      this.characterVisibility(actor),
    ];
    if (query.source) conditions.push(eq(generationCharacters.source, query.source));
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(
        or(
          ilike(generationCharacters.name, pattern),
          ilike(generationCharacters.canonicalTag, pattern),
          ilike(generationCharacters.copyright, pattern),
          sql`${generationCharacters.aliases}::text ilike ${pattern}`,
        )!,
      );
    }
    return and(...conditions)!;
  }

  private characterVisibility(actor: GenerationLibraryActor): SQL {
    if (actor.source === "panel") return sql`true`;
    const viewer = actor.telegramUserId;
    if (!viewer) return sql`false`;
    return sql`(
      ${generationCharacters.ownerTelegramId} is null
      or (
        ${generationCharacters.ownerTelegramId} = ${viewer}
        and coalesce((
          select ${userPrivacySettings.mode} from ${userPrivacySettings}
          where ${userPrivacySettings.botId} = ${generationCharacters.botId}
            and ${userPrivacySettings.userId} = ${generationCharacters.ownerTelegramId}
        ), 'normal') <> 'off'
      )
      or (
        ${generationCharacters.ownerTelegramId} <> ${viewer}
        and coalesce((
          select ${userPrivacySettings.mode} from ${userPrivacySettings}
          where ${userPrivacySettings.botId} = ${generationCharacters.botId}
            and ${userPrivacySettings.userId} = ${generationCharacters.ownerTelegramId}
        ), 'normal') = 'normal'
      )
    )`;
  }

  private async getVisibleCharacter(
    actor: GenerationLibraryActor,
    id: number,
  ): Promise<CharacterRow | undefined> {
    const [row] = await this.db
      .select()
      .from(generationCharacters)
      .where(
        and(
          eq(generationCharacters.botId, actor.botId),
          eq(generationCharacters.id, id),
          this.characterVisibility(actor),
        ),
      )
      .limit(1);
    return row;
  }

  private async getVisibleCharacters(
    actor: GenerationLibraryActor,
    ids: number[],
  ): Promise<CharacterRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(generationCharacters)
      .where(
        and(
          eq(generationCharacters.botId, actor.botId),
          inArray(generationCharacters.id, ids),
          this.characterVisibility(actor),
        ),
      )
      .orderBy(asc(generationCharacters.id));
  }

  private async getRawCharacter(botId: string, id: number): Promise<CharacterRow | undefined> {
    const [row] = await this.db
      .select()
      .from(generationCharacters)
      .where(and(eq(generationCharacters.botId, botId), eq(generationCharacters.id, id)))
      .limit(1);
    return row;
  }

  private async getBindingCount(botId: string, characterId: number): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(peopleCharacterBindings)
      .where(
        and(
          eq(peopleCharacterBindings.botId, botId),
          eq(peopleCharacterBindings.characterId, characterId),
        ),
      );
    return row?.value ?? 0;
  }

  private async getProfile(botId: string, telegramId: number) {
    const [profile] = await this.db
      .select({ id: peopleProfiles.id })
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, telegramId)))
      .limit(1);
    return profile;
  }

  private async getOrCreateBindingProfile(actor: GenerationLibraryActor, telegramId: number) {
    const existing = await this.getProfile(actor.botId, telegramId);
    if (existing) return existing;
    if (actor.source !== "telegram" || actor.telegramUserId !== telegramId) {
      throw this.error("not_found", "People profile not found");
    }
    const [created] = await this.db
      .insert(peopleProfiles)
      .values({ botId: actor.botId, telegramId })
      .onConflictDoNothing({ target: [peopleProfiles.botId, peopleProfiles.telegramId] })
      .returning({ id: peopleProfiles.id });
    if (created) return created;
    const concurrent = await this.getProfile(actor.botId, telegramId);
    if (!concurrent) throw this.error("not_found", "People profile not found");
    return concurrent;
  }

  private async getAssetsByIds(botId: string, ids: number[]): Promise<AssetRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(promptAssets)
      .where(and(eq(promptAssets.botId, botId), inArray(promptAssets.id, ids)))
      .orderBy(asc(promptAssets.id));
  }

  private async assertAssignableOwner(
    actor: GenerationLibraryActor,
    telegramId: number,
  ): Promise<void> {
    await this.assertPrivacyWritable(actor.botId, telegramId);
    if (await this.getProfile(actor.botId, telegramId)) return;
    if (actor.source === "telegram" && actor.telegramUserId === telegramId) {
      await this.getOrCreateBindingProfile(actor, telegramId);
      return;
    }
    throw this.error("not_found", "Character owner people profile not found");
  }

  private async assertPrivacyWritable(botId: string, telegramId: number): Promise<void> {
    if ((await this.privacyService.getMode(botId, telegramId)) === "off") {
      throw this.error(
        "privacy_denied",
        "Generation-library personal data is disabled for this user",
      );
    }
  }

  private async withBindingPrivacy<T>(
    actor: GenerationLibraryActor,
    telegramId: number,
    write: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (actor.source === "panel") {
      if (write && !actor.isAdmin) this.forbidden();
      if (!write) return operation();
      return this.privacyService.runLibraryExclusiveMany(actor.botId, [telegramId], async () => {
        await this.assertPrivacyWritable(actor.botId, telegramId);
        return operation();
      });
    }
    if (!actor.telegramUserId) this.forbidden();
    if (write && actor.telegramUserId !== telegramId && !actor.isAdmin) this.forbidden();
    const privacyOperation = async () => {
      const actorMode = await this.privacyService.getMode(actor.botId, actor.telegramUserId!);
      if (actorMode === "off") {
        if (write)
          throw this.error("privacy_denied", "People profile is not available to this actor");
        return [] as T;
      }
      const mode = await this.privacyService.getMode(actor.botId, telegramId);
      if (mode === "off" || (mode === "isolated" && actor.telegramUserId !== telegramId)) {
        if (write)
          throw this.error("privacy_denied", "People profile is not available to this actor");
        return [] as T;
      }
      return operation();
    };
    return this.privacyService.runLibraryExclusiveMany(actor.botId, [telegramId], privacyOperation);
  }

  private assertActor(actor: GenerationLibraryActor): void {
    if (!actor.botId || (actor.source !== "panel" && actor.source !== "telegram")) {
      throw this.error("invalid_input", "Invalid generation-library actor");
    }
    if (
      actor.source === "telegram" &&
      (actor.telegramUserId === undefined ||
        !telegramIdSchema.safeParse(actor.telegramUserId).success)
    ) {
      throw this.error("invalid_input", "Telegram actor identity is required");
    }
  }

  private assertAdmin(actor: GenerationLibraryActor): void {
    this.assertActor(actor);
    if (!actor.isAdmin) this.forbidden();
  }

  private forbidden(message = "Generation-library operation is not permitted"): never {
    throw this.error("forbidden", message);
  }

  private error(code: GenerationLibraryErrorCode, message: string): GenerationLibraryError {
    return new GenerationLibraryError(code, message);
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw this.error("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
    return parsed.data;
  }
}

function normalizeCharacterInput(input: z.infer<typeof characterInputSchema>): CharacterInput {
  return {
    ...input,
    aliases: uniqueStrings(input.aliases).filter((alias) => alias !== input.name),
    copyright: input.copyright || undefined,
  };
}

function dedupeDanbooruResults(rawResults: DanbooruCharacterResult[]): DanbooruCharacterResult[] {
  const schema = z
    .array(
      z
        .object({
          tag: z.string().trim().min(1).max(200),
          label: z.string().trim().min(1).max(200),
          matchedAlias: z.string().trim().min(1).max(200).optional(),
          postCount: z.number().int().nonnegative().optional(),
          otherNames: z.array(z.string().trim().min(1).max(200)).max(100),
          wikiSummary: z.string().trim().max(10_000).optional(),
          postsUrl: z.string().url().max(2_000),
        })
        .strict(),
    )
    .max(100);
  const parsed = schema.safeParse(rawResults);
  if (!parsed.success) {
    throw new GenerationLibraryError(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "Invalid Danbooru result",
    );
  }
  const byTag = new Map<string, DanbooruCharacterResult>();
  for (const result of parsed.data) if (!byTag.has(result.tag)) byTag.set(result.tag, result);
  return [...byTag.values()];
}

function toCharacter(row: CharacterRow): LibraryCharacter {
  return {
    id: row.id,
    botId: row.botId,
    source: row.source,
    canonicalTag: row.canonicalTag,
    name: row.name,
    aliases: row.aliases,
    appearance: row.appearance,
    defaultOutfit: row.defaultOutfit,
    notes: row.notes,
    copyright: row.copyright ?? undefined,
    ownerTelegramId: row.ownerTelegramId ?? undefined,
    postCount: row.postCount,
    wikiSummary: row.wikiSummary,
    sourceUrl: row.sourceUrl,
    sourceFetchedAt: toIso(row.sourceFetchedAt),
    queryCount: row.queryCount,
    firstQueriedAt: toIso(row.firstQueriedAt),
    lastQueriedAt: toIso(row.lastQueriedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    bindingCount: row.bindingCount ?? 0,
  };
}

function toAsset(row: AssetRow): PromptAsset {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    type: row.type,
    content: row.content,
    notes: row.notes,
    safety: row.safety,
    pinned: row.pinned,
    useCount: row.useCount,
    lastUsedAt: toIso(row.lastUsedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function characterPromptContent(character: CharacterRow, skipDefaultOutfit: boolean): string {
  const details = [character.appearance, skipDefaultOutfit ? "" : character.defaultOutfit]
    .filter(Boolean)
    .join(", ");
  const identity = character.source === "danbooru" ? character.canonicalTag! : character.name;
  return `[Character: ${identity}]${details ? ` ${details}` : ""}`;
}

function emptySnapshot(
  originalPrompt: string,
  safetyMode: "safe" | "nsfw",
): GenerationMaterialSnapshot {
  return { originalPrompt, safetyMode, characters: [], assets: [] };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
