import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { PeopleProfileStore } from "../services/people-profile-store.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.AUTH_OWNER_EMAIL ??= "owner@example.com";

let botsRoutes: (typeof import("./bots.js"))["botsRoutes"];
const botIds: string[] = [];

beforeAll(async () => {
  ({ botsRoutes } = await import("./bots.js"));
});

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

function createApp(db: Database, botPool: BotPool) {
  return new Hono().route(
    "/bots",
    botsRoutes(db, botPool, {} as unknown as ModelCapabilityService),
  );
}

describe("people profile avatar lifecycle", () => {
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
