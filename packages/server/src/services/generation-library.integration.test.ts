import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "@cos-tool-bot/database";
import {
  DEFAULT_GENERATION_LIBRARY_SETTINGS,
  type GenerationLibraryActor,
} from "@cos-tool-bot/shared";
import { GenerationLibraryService } from "./generation-library-service.js";
import { UserPrivacyService } from "./user-privacy-service.js";
import { recordGenerationAssetUses } from "./generation-asset-usage.js";

const url = process.env.GENERATION_LIBRARY_TEST_DATABASE_URL;
// Explicit opt-in only; never reuse DATABASE_URL or a production schema.
describe.skipIf(!url)("generation library PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let db: Database;
  let service: GenerationLibraryService;
  let privacy: UserPrivacyService;
  const namespace = `library_test_${randomUUID().replaceAll("-", "")}`;
  let actor: GenerationLibraryActor;
  let admin: GenerationLibraryActor;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Library integration tests require a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    const connection = createDb(parsed.toString());
    client = connection.client;
    db = connection.db;
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`
      CREATE TABLE bots (id uuid PRIMARY KEY);
      CREATE TABLE people_profiles (
        id serial PRIMARY KEY, bot_id uuid NOT NULL, telegram_id bigint NOT NULL,
        username text, display_name text, first_name text, last_name text, language_code text,
        is_premium boolean DEFAULT false NOT NULL, avatar_path text, avatar_version text,
        avatar_refresh_version bigint DEFAULT 0 NOT NULL, notes text, traits json DEFAULT '[]',
        interests json DEFAULT '[]', relationship text, first_seen timestamp DEFAULT now() NOT NULL,
        last_seen timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now(),
        UNIQUE(bot_id, telegram_id)
      );
      CREATE TABLE user_privacy_settings (
        bot_id uuid NOT NULL, user_id bigint NOT NULL, mode text DEFAULT 'normal' NOT NULL,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), PRIMARY KEY(bot_id, user_id)
      );
      CREATE TABLE image_generations (id uuid PRIMARY KEY, bot_id uuid NOT NULL, state text NOT NULL DEFAULT 'running');
    `);
    for (const name of [
      "0048_generation_characters",
      "0049_prompt_assets",
      "0050_generation_asset_usage",
    ]) {
      const migration = await readFile(
        new URL(`../../../database/drizzle/${name}.sql`, import.meta.url),
        "utf8",
      );
      await client.unsafe(migration.replaceAll('"public".', `"${namespace}".`));
    }
    privacy = new UserPrivacyService(db);
    service = new GenerationLibraryService(db, privacy);
  });

  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    const botId = randomUUID();
    await client`INSERT INTO bots (id) VALUES (${botId})`;
    await client`INSERT INTO people_profiles (bot_id, telegram_id) VALUES (${botId}, 42), (${botId}, 43)`;
    actor = { botId, source: "telegram", telegramUserId: 42, isAdmin: false };
    admin = { botId, source: "panel", isAdmin: true };
  });

  const oc = (name = "原创角色") => ({
    name,
    aliases: ["OC"],
    appearance: "silver hair, blue eyes",
    defaultOutfit: "white coat",
    notes: "",
  });
  const asset = (safety: "safe" | "nsfw" = "safe") => ({
    name: "style",
    type: "style" as const,
    content: "watercolor",
    notes: "",
    safety,
    pinned: true,
  });

  it("upserts canonical tags atomically and counts duplicates once per result set", async () => {
    const item = {
      tag: "hero_(work)",
      label: "Hero",
      otherNames: ["英雄"],
      wikiSummary: "original summary",
      postsUrl: "https://danbooru.donmai.us/posts?tags=hero",
    };
    const fetchedAt = new Date("2026-09-01T00:00:00Z");
    await Promise.all(
      Array.from({ length: 8 }, () => service.recordDanbooru(actor, [item, item], fetchedAt)),
    );
    const rows = await service.listCharacters(admin);
    expect(rows.total).toBe(1);
    expect(rows.data[0]?.queryCount).toBe(8);
    await service.recordDanbooru(actor, [{ ...item, wikiSummary: undefined }], new Date());
    expect((await service.listCharacters(admin)).data[0]?.wikiSummary).toBe("original summary");
  });

  it("keeps OC ownership, same-name records, privacy, and bot boundaries", async () => {
    const first = await service.saveCharacter(actor, oc());
    const second = await service.saveCharacter(actor, oc());
    expect(first.id).not.toBe(second.id);
    const other = { ...actor, telegramUserId: 43 };
    await expect(service.saveCharacter(other, oc("stolen"), first.id)).rejects.toThrow();
    await privacy.setMode(actor.botId, 42, "isolated");
    expect((await service.listCharacters(other)).total).toBe(0);
    expect((await service.listCharacters(actor)).total).toBe(2);
    await privacy.setMode(actor.botId, 42, "off");
    expect((await service.listCharacters(actor)).total).toBe(0);
    await expect(service.saveCharacter(actor, oc())).rejects.toThrow();
    const wrongBot = { ...admin, botId: randomUUID() };
    await expect(service.deleteCharacter(wrongBot, first.id)).rejects.toThrow();
    expect((await service.listCharacters(admin)).total).toBe(2);
  });

  it("preserves newer Danbooru metadata when an older query cache is returned", async () => {
    const item = {
      tag: "cache_hero",
      label: "new name",
      postCount: 100,
      otherNames: ["new alias"],
      wikiSummary: "new",
      postsUrl: "https://danbooru.donmai.us/posts?tags=cache_hero",
    };
    const newer = new Date("2026-09-20T00:00:00Z");
    await service.recordDanbooru(actor, [item], newer);
    await service.recordDanbooru(
      actor,
      [{ ...item, label: "old name", postCount: 1, wikiSummary: "old" }],
      new Date("2026-09-01T00:00:00Z"),
    );
    const result = (await service.listCharacters(admin)).data[0];
    expect(result).toMatchObject({
      name: "new name",
      postCount: 100,
      wikiSummary: "new",
      queryCount: 2,
      sourceFetchedAt: newer.toISOString(),
    });
  });

  it("keeps administrator annotations separate from refreshed Danbooru fields", async () => {
    const item = {
      tag: "annotated_hero",
      label: "Hero",
      otherNames: ["alias"],
      postsUrl: "https://danbooru.donmai.us/posts?tags=annotated_hero",
    };
    await service.recordDanbooru(actor, [item], new Date("2026-09-01T00:00:00Z"));
    const character = (await service.listCharacters(admin)).data[0]!;
    await expect(service.saveCharacter(actor, oc(), character.id)).rejects.toThrow();
    await service.saveCharacter(
      admin,
      { ...oc("cannot override source"), copyright: "curated work", notes: "manual note" },
      character.id,
    );
    await service.recordDanbooru(actor, [{ ...item, label: "Updated source label" }], new Date());
    expect((await service.listCharacters(admin)).data[0]).toMatchObject({
      name: "Updated source label",
      canonicalTag: "annotated_hero",
      copyright: "curated work",
      notes: "manual note",
      appearance: "silver hair, blue eyes",
    });
    const resolved = await service.resolveMaterials(actor, "portrait", {
      characterIds: [character.id],
    });
    expect(resolved.prompt).toContain("[Character: annotated_hero]");
    expect(resolved.prompt).not.toContain("Updated source label");
  });

  it("saves OC and bindings inside a foreground AI privacy lock without deadlocking", async () => {
    await privacy.runExclusive(actor.botId, 42, async () => {
      const character = await service.saveCharacter(actor, oc());
      await service.setBinding(actor, 42, {
        characterId: character.id,
        relation: "representation",
        isDefault: true,
      });
      const resolved = await service.resolveMaterials(actor, "draw", {
        personTelegramId: 42,
        skipDefaultOutfit: true,
      });
      expect(resolved.snapshot.characters[0]?.id).toBe(character.id);
      expect(resolved.prompt).toContain("silver hair");
      expect(resolved.prompt).not.toContain("white coat");
    });
  });

  it("allows a friend's normal default representation but respects isolation and off", async () => {
    const character = await service.saveCharacter(actor, oc());
    await service.setBinding(actor, 42, {
      characterId: character.id,
      relation: "representation",
      isDefault: true,
    });
    const friend = { ...actor, telegramUserId: 43 };
    expect(
      (await service.resolveMaterials(friend, "draw my friend", { personTelegramId: 42 })).snapshot
        .characters[0]?.id,
    ).toBe(character.id);
    await privacy.setMode(actor.botId, 42, "isolated");
    expect(await service.getBindings(friend, 42)).toEqual([]);
    await privacy.setMode(actor.botId, 42, "off");
    await expect(
      service.setBinding(admin, 42, {
        characterId: character.id,
        relation: "favorite",
        isDefault: false,
      }),
    ).rejects.toThrow();
  });

  it("serializes another person's binding reads behind their privacy update", async () => {
    const character = await service.saveCharacter(actor, oc());
    await service.setBinding(actor, 42, {
      characterId: character.id,
      relation: "representation",
      isDefault: true,
    });
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const switchOff = privacy.runExclusive(actor.botId, 42, async () => {
      signalStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await privacy.setMode(actor.botId, 42, "off");
    });
    await started;
    const read = service.getBindings({ ...actor, telegramUserId: 43 }, 42);
    release();
    await switchOff;
    expect(await read).toEqual([]);
  });

  it("attributes a Telegram administrator's own OC to them for privacy deletion", async () => {
    const character = await service.saveCharacter({ ...actor, isAdmin: true }, oc());
    expect(character.ownerTelegramId).toBe(actor.telegramUserId);
    await service.saveCharacter(admin, { ...oc(), name: "edited by panel" }, character.id);
    await expect(
      service.saveCharacter(admin, { ...oc(), ownerTelegramId: 43 }, character.id),
    ).rejects.toThrow("creator cannot be reassigned");
    expect((await service.listCharacters(admin)).data[0]?.ownerTelegramId).toBe(
      actor.telegramUserId,
    );
  });

  it("enforces Telegram safe-by-default retrieval and library switches", async () => {
    const character = await service.saveCharacter(actor, oc());
    await service.setBinding(actor, 42, {
      characterId: character.id,
      relation: "representation",
      isDefault: true,
    });
    await service.saveAsset(admin, asset());
    await service.saveAsset(admin, asset("nsfw"));
    expect((await service.listAssets(actor)).data.map((row) => row.safety)).toEqual(["safe"]);
    await expect(service.listAssets(actor, { safety: "nsfw" })).rejects.toThrow();
    await service.updateSettings(admin, {
      ...DEFAULT_GENERATION_LIBRARY_SETTINGS,
      nsfwEnabled: true,
    });
    expect(
      (await service.listAssets(actor, { safety: "nsfw" })).data.map((row) => row.safety),
    ).toEqual(["nsfw"]);
    await service.updateSettings(admin, {
      ...DEFAULT_GENERATION_LIBRARY_SETTINGS,
      charactersEnabled: false,
      assetsEnabled: false,
    });
    await expect(service.listCharacters(actor, {}, true)).rejects.toThrow();
    await expect(service.getBindings(actor, 42)).rejects.toMatchObject({
      code: "characters_disabled",
    });
    expect(await service.getBindings(admin, 42)).toHaveLength(1);
    await expect(service.listAssets(actor)).rejects.toThrow();
    expect((await service.listAssets(admin)).total).toBe(2);
  });

  it("serializes default bindings and cascades deleted characters", async () => {
    const first = await service.saveCharacter(actor, oc("one"));
    const second = await service.saveCharacter(actor, oc("two"));
    await Promise.all(
      [first, second].map((character) =>
        service.setBinding(actor, 42, {
          characterId: character.id,
          relation: "representation",
          isDefault: true,
        }),
      ),
    );
    await service.setBinding(actor, 42, {
      characterId: first.id,
      relation: "favorite",
      isDefault: false,
    });
    const bindings = await service.getBindings(actor, 42);
    expect(bindings).toHaveLength(3);
    expect(bindings.filter((binding) => binding.isDefault)).toHaveLength(1);
    await expect(
      service.setBinding({ ...actor, telegramUserId: 43 }, 42, {
        characterId: first.id,
        relation: "favorite",
        isDefault: false,
      }),
    ).rejects.toThrow();
    await service.deleteCharacter(actor, first.id);
    expect(
      (await service.getBindings(actor, 42)).every((binding) => binding.characterId !== first.id),
    ).toBe(true);
  });

  it("filters NSFW pinned, validates explicit selections, and freezes selected content", async () => {
    await service.updateSettings(admin, {
      ...DEFAULT_GENERATION_LIBRARY_SETTINGS,
      injectionEnabled: true,
    });
    const safe = await service.saveAsset(admin, asset());
    const nsfw = await service.saveAsset(admin, { ...asset("nsfw"), content: "nsfw recipe" });
    await expect(service.saveAsset(actor, asset())).rejects.toThrow();
    const resolved = await service.resolveMaterials(actor, "draw", {
      assetIds: [safe.id, safe.id],
    });
    expect(resolved.snapshot.assets.map((item) => item.id)).toEqual([safe.id]);
    expect(resolved.prompt).not.toContain("nsfw recipe");
    await expect(
      service.resolveMaterials(actor, "draw", { assetIds: [nsfw.id] }),
    ).rejects.toThrow();
    expect(
      (await service.resolveMaterials(actor, "draw", { skipPinned: true })).snapshot.assets,
    ).toHaveLength(0);
    await service.saveAsset(admin, { ...asset(), content: "changed" }, safe.id);
    expect(resolved.snapshot.assets[0]?.content).toBe("watercolor");
    await expect(service.resolveMaterials(actor, "x".repeat(8000), {})).rejects.toThrow();
  });

  it("counts successful asset use once across concurrent retries and rolls back failed completion", async () => {
    const saved = await service.saveAsset(admin, asset());
    const generationId = randomUUID();
    await client`INSERT INTO image_generations (id, bot_id) VALUES (${generationId}, ${actor.botId})`;
    await expect(
      db.transaction(async (tx) => {
        await recordGenerationAssetUses(tx, actor.botId, generationId, [saved.id], new Date());
        throw new Error("completion failed");
      }),
    ).rejects.toThrow("completion failed");
    expect((await service.listAssets(admin)).data[0]?.useCount).toBe(0);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        db.transaction((tx) =>
          recordGenerationAssetUses(
            tx,
            actor.botId,
            generationId,
            [saved.id, saved.id],
            new Date(),
          ),
        ),
      ),
    );
    expect((await service.listAssets(admin)).data[0]?.useCount).toBe(1);
    await service.deleteAsset(admin, saved.id);
    await db.transaction((tx) =>
      recordGenerationAssetUses(tx, actor.botId, generationId, [saved.id], new Date()),
    );
    expect((await service.listAssets(admin)).total).toBe(0);
  });
});
