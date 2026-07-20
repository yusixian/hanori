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
  return {
    delete: () => ({
      where: () => ({
        returning: async () => [{ avatarPath }],
      }),
    }),
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
    const store = new PeopleProfileStore(profileDeleteDb(avatarPath));
    const botPool = { getProfileStore: () => store } as unknown as BotPool;
    const app = createApp({} as Database, botPool);

    const response = await app.request(`/bots/${botId}/profiles/7`, { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(fs.stat(absoluteAvatarPath)).rejects.toMatchObject({ code: "ENOENT" });
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
});
