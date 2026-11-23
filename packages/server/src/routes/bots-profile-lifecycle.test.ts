import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import type { BotLifecycleService } from "../services/bot-lifecycle-service.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import type { AuthVariables } from "../middleware/better-auth.js";
import { PeopleProfileStore } from "../services/people-profile-store.js";
import { botsRoutes } from "./bots.js";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "test-secret";
  process.env.AUTH_OWNER_EMAIL ??= "owner@example.com";
  process.env.ENCRYPTION_KEY ||= "test-encryption-key";
});

const botIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    botIds
      .splice(0)
      .map((botId) =>
        fs.rm(path.join(process.cwd(), "data", botId), { recursive: true, force: true }),
      ),
  );
});

function profileDeleteDb(avatarPath: string | null) {
  const profile = { id: 7, telegramId: 42, avatarPath };
  const transaction = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({ where: async () => [profile] }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => [{ avatarPath }],
      }),
    }),
  };
  return {
    transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
  } as unknown as Database;
}

function createApp(
  db: Database,
  botPool: BotPool,
  options: { role?: string; lifecycle?: BotLifecycleService } = {},
) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authUser", { id: "user-1" } as never);
      c.set("authMember", { role: options.role ?? "owner" } as never);
      await next();
    })
    .route(
      "/bots",
      botsRoutes(db, botPool, {} as unknown as ModelCapabilityService, options.lifecycle),
    );
}

describe("Mini App Bot management", () => {
  it("rejects retired webhook bots before creating a record", async () => {
    const insert = vi.fn();
    const app = createApp({ insert } as unknown as Database, {} as BotPool);
    const response = await app.request("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Retired", platform: "lark-webhook", token: "fixture" }),
    });
    expect(response.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not let an editor create a Bot trust root", async () => {
    const insert = vi.fn();
    const app = createApp({ insert } as unknown as Database, {} as BotPool, { role: "editor" });

    const response = await app.request("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Restricted Bot",
        platform: "telegram",
        token: "123:test",
        miniAppEnabled: false,
      }),
    });

    expect(response.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not let an editor replace Telegram admins or the Bot token", async () => {
    const existing = {
      id: "00000000-0000-4000-8000-000000000001",
      platform: "telegram",
      adminChatIds: [7],
      cosInsideConfig: { targets: [{ alias: "ops", chatId: -100 }] },
      isActive: false,
      miniAppEnabled: false,
    };
    const select = vi.fn(() => ({ from: () => ({ where: async () => [existing] }) }));
    const app = createApp({ select } as unknown as Database, {} as BotPool, { role: "editor" });

    for (const body of [
      { adminChatIds: [42] },
      { token: "999:attacker-token" },
      { cosInsideConfig: { targets: [{ alias: "public", chatId: -200 }] } },
      { cosInsideConfig: { targets: [] } },
    ]) {
      const response = await app.request("/bots/00000000-0000-4000-8000-000000000001", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
    }
    expect(select).toHaveBeenCalledTimes(4);
  });

  it.each(["owner", "admin"])("lets a %s manage the relay target allowlist", async (role) => {
    const botId = "00000000-0000-4000-8000-000000000001";
    const existing = {
      id: botId,
      name: "Relay Bot",
      platform: "telegram" as const,
      encryptedToken: "encrypted",
      adminChatIds: [7],
      cosInsideConfig: { targets: [{ alias: "ops", chatId: -100 }] },
      aiConfig: null,
      larkWebhookConfig: null,
      emailForwardConfig: null,
      isActive: false,
      miniAppEnabled: false,
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    };
    const savedConfigs: unknown[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          savedConfigs.push(updates.cosInsideConfig);
          return {
            where: () => ({ returning: async () => [{ ...existing, ...updates }] }),
          };
        },
      }),
    } as unknown as Database;
    const app = createApp(db, { getManager: vi.fn(() => undefined) } as unknown as BotPool, {
      role,
    });

    for (const cosInsideConfig of [
      { targets: [{ alias: "release", chatId: -200 }] },
      { targets: [] },
    ]) {
      const response = await app.request(`/bots/${botId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cosInsideConfig }),
      });
      expect(response.status).toBe(200);
    }

    expect(savedConfigs).toEqual([
      { targets: [{ alias: "release", chatId: -200 }] },
      { targets: [] },
    ]);
  });

  it("lets an editor save ordinary fields when protected values are unchanged", async () => {
    const botId = "00000000-0000-4000-8000-000000000001";
    const existing = {
      id: botId,
      name: "Before",
      platform: "telegram" as const,
      encryptedToken: "encrypted",
      adminChatIds: [9, 7],
      aiConfig: null,
      larkWebhookConfig: null,
      emailForwardConfig: null,
      isActive: false,
      miniAppEnabled: false,
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    };
    const db = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...existing, ...updates }] }),
        }),
      }),
    } as unknown as Database;
    const app = createApp(db, { getManager: vi.fn(() => undefined) } as unknown as BotPool, {
      role: "editor",
    });

    const response = await app.request(`/bots/${botId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "After",
        adminChatIds: [7, 9, 9],
        isActive: false,
        miniAppEnabled: false,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { name: "After" } });
  });

  it("restarts an active Bot when disabling Mini App after its manager disappeared", async () => {
    const botId = "00000000-0000-4000-8000-000000000001";
    const existing = {
      id: botId,
      name: "Recovery Bot",
      platform: "telegram" as const,
      encryptedToken: "unreadable-test-token",
      adminChatIds: [],
      aiConfig: null,
      larkWebhookConfig: null,
      emailForwardConfig: null,
      isActive: true,
      miniAppEnabled: true,
      createdAt: new Date("2026-07-27T00:00:00.000Z"),
      updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    };
    const db = {
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...existing, ...updates }] }),
        }),
      }),
    } as unknown as Database;
    const restart = vi.fn(async () => ({
      desiredActive: true,
      runtimeStatus: "running" as const,
      reconciled: true,
      persisted: true as const,
      applied: true,
    }));
    const botPool = { getManager: vi.fn(() => undefined) } as unknown as BotPool;
    const app = createApp(db, botPool, {
      lifecycle: { restart } as unknown as BotLifecycleService,
    });

    const response = await app.request(`/bots/${botId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ miniAppEnabled: false }),
    });

    expect(response.status).toBe(200);
    expect(restart).toHaveBeenCalledWith({
      botId,
      actor: { kind: "better_auth_user", id: "user-1" },
    });
  });
});

describe("people profile avatar lifecycle", () => {
  it("returns conflict when manually creating an existing Telegram profile", async () => {
    const createProfile = vi.fn(async () => ({
      created: false as const,
      profile: { id: 7, telegramId: 42, displayName: "Observed" },
    }));
    const botPool = {
      getProfileStore: () => ({ createProfile }),
    } as unknown as BotPool;
    const app = createApp({} as Database, botPool);

    const response = await app.request("/bots/test-bot/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramId: 42, displayName: "Manual replacement" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Profile already exists",
    });
    expect(createProfile).toHaveBeenCalledWith("test-bot", {
      telegramId: 42,
      displayName: "Manual replacement",
    });
  });

  it("removes the cached avatar after deleting a profile", async () => {
    const botId = `profile-delete-${Date.now()}`;
    botIds.push(botId);
    const avatarPath = "avatars/42-current.jpg";
    const absoluteAvatarPath = path.join(process.cwd(), "data", botId, avatarPath);
    await fs.mkdir(path.dirname(absoluteAvatarPath), { recursive: true });
    await fs.writeFile(absoluteAvatarPath, new Uint8Array([1, 2, 3]));
    const staleAvatarPath = path.join(process.cwd(), "data", botId, "avatars", "42-stale.jpg");
    const tempAvatarPath = `${staleAvatarPath}.pending.tmp`;
    const legacyAvatarPath = path.join(process.cwd(), "data", botId, "avatars", "42.jpg");
    const unrelatedAvatarPath = path.join(
      process.cwd(),
      "data",
      botId,
      "avatars",
      "420-unrelated.jpg",
    );
    await fs.writeFile(staleAvatarPath, new Uint8Array([4]));
    await fs.writeFile(tempAvatarPath, new Uint8Array([5]));
    await fs.writeFile(legacyAvatarPath, new Uint8Array([5]));
    await fs.writeFile(unrelatedAvatarPath, new Uint8Array([6]));
    const store = new PeopleProfileStore(profileDeleteDb(avatarPath));
    const botPool = { getProfileStore: () => store } as unknown as BotPool;
    const app = createApp({} as Database, botPool);

    const response = await app.request(`/bots/${botId}/profiles/7`, { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(fs.stat(absoluteAvatarPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(staleAvatarPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(tempAvatarPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(legacyAvatarPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(unrelatedAvatarPath)).resolves.toEqual(Buffer.from([6]));
  });

  it("does not unlink an avatar path outside the deleted profile's bot directory", async () => {
    const botId = `profile-delete-${Date.now()}`;
    const otherBotId = `other-bot-${Date.now()}`;
    botIds.push(botId, otherBotId);
    const retainedPath = path.join(process.cwd(), "data", otherBotId, "avatars", "42-current.jpg");
    await fs.mkdir(path.dirname(retainedPath), { recursive: true });
    await fs.writeFile(retainedPath, new Uint8Array([1, 2, 3]));
    const store = new PeopleProfileStore(
      profileDeleteDb(`../${otherBotId}/avatars/42-current.jpg`),
    );
    const botPool = { getProfileStore: () => store } as unknown as BotPool;
    const app = createApp({} as Database, botPool);

    const response = await app.request(`/bots/${botId}/profiles/7`, { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(fs.readFile(retainedPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("fails profile deletion when its avatar cleanup cannot run", async () => {
    const botId = `profile-delete-${Date.now()}`;
    botIds.push(botId);
    const dataDir = path.join(process.cwd(), "data", botId);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "avatars"), new Uint8Array([1]));
    const store = new PeopleProfileStore(profileDeleteDb("avatars/42-current.jpg"));
    const botPool = { getProfileStore: () => store } as unknown as BotPool;
    const app = createApp({} as Database, botPool);

    const response = await app.request(`/bots/${botId}/profiles/7`, { method: "DELETE" });

    expect(response.status).toBe(500);
  });

  it("removes only the avatar directory after deleting a bot", async () => {
    const botId = `bot-delete-${Date.now()}`;
    botIds.push(botId);
    const dataDir = path.join(process.cwd(), "data", botId);
    const avatarPath = path.join(dataDir, "avatars", "42-current.jpg");
    const retainedPath = path.join(dataDir, "notes", "context.md");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.mkdir(path.dirname(retainedPath), { recursive: true });
    await fs.writeFile(avatarPath, new Uint8Array([1, 2, 3]));
    await fs.writeFile(retainedPath, "keep me");
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: botId }] }),
      }),
      delete: () => ({ where: async () => undefined }),
    } as unknown as Database;
    const botPool = {
      stopBot: vi.fn(async () => undefined),
      clearDeletedBotGenerationState: vi.fn(),
    } as unknown as BotPool;
    const app = createApp(db, botPool);

    const response = await app.request(`/bots/${botId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(fs.stat(path.dirname(avatarPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("keep me");
  });

  it("retries avatar cleanup after the bot row is already gone", async () => {
    const botId = `bot-delete-retry-${Date.now()}`;
    botIds.push(botId);
    const avatarPath = path.join(process.cwd(), "data", botId, "avatars", "42-orphan.jpg");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, new Uint8Array([1]));
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Database;
    const app = createApp(db, {} as BotPool);

    const response = await app.request(`/bots/${botId}`, { method: "DELETE" });

    expect(response.status).toBe(404);
    await expect(fs.stat(path.dirname(avatarPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails bot deletion when avatar cleanup cannot run", async () => {
    const botId = `bot-delete-failure-${Date.now()}`;
    botIds.push(botId);
    const dataDir = path.join(process.cwd(), "data", botId);
    const avatarDir = path.join(dataDir, "avatars");
    await fs.mkdir(avatarDir, { recursive: true });
    await fs.writeFile(path.join(avatarDir, "42-current.jpg"), new Uint8Array([1]));
    const removeBot = vi.fn(() => ({ where: async () => undefined }));
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: botId }] }) }),
      delete: removeBot,
    } as unknown as Database;
    const botPool = {
      stopBot: vi.fn(async () => undefined),
      clearDeletedBotGenerationState: vi.fn(),
    } as unknown as BotPool;
    const app = createApp(db, botPool);

    await fs.chmod(dataDir, 0o555);
    const response = await app.request(`/bots/${botId}`, { method: "DELETE" });
    await fs.chmod(dataDir, 0o755);

    expect(response.status).toBe(500);
    expect(removeBot).not.toHaveBeenCalled();
  });
});
