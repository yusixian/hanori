import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import { ownerOrAdmin, requireRoles } from "../middleware/better-auth.js";
import { cosInsideRoutes } from "./cos-inside.js";
import { governanceRoutes } from "./governance.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

const subjects = [
  { id: -1001, name: "Operations", username: "operations" },
  { id: -1002, name: "Release", username: null },
];

function routeDatabase(options: { botExists?: boolean } = {}) {
  let chatWhere: unknown;
  let chatLimit: number | undefined;
  const select = vi
    .fn()
    .mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (options.botExists === false ? [] : [{ id: BOT_ID }]),
        }),
      }),
    }))
    .mockImplementationOnce(() => ({
      from: () => ({
        where: (condition: unknown) => {
          chatWhere = condition;
          return {
            orderBy: () => ({
              limit: async (value: number) => {
                chatLimit = value;
                return subjects;
              },
            }),
          };
        },
      }),
    }));
  return {
    db: { select } as unknown as Database,
    select,
    chatQuery: () => ({ where: chatWhere, limit: chatLimit }),
  };
}

function routeApp(role: string, db: Database) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authMember", { role } as AuthVariables["authMember"]);
      await next();
    })
    .use("/api/bots/:botId/cos-inside/groups", requireRoles(ownerOrAdmin))
    .route("/api/bots", cosInsideRoutes(db));
}

describe("cos inside group search", () => {
  it.each(["owner", "admin"])("allows %s to read Bot-scoped groups", async (role) => {
    const { db, chatQuery } = routeDatabase();
    const response = await routeApp(role, db).request(
      `/api/bots/${BOT_ID}/cos-inside/groups?query=%40ops`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      subjects: [
        { id: "-1001", name: "Operations", username: "operations" },
        { id: "-1002", name: "Release", username: null },
      ],
    });
    const compiled = new PgDialect().sqlToQuery(chatQuery().where as never);
    expect(compiled.sql).toContain('"telegram_chats"."bot_id" = $1');
    expect(compiled.sql).toContain('"telegram_chats"."left_at" is null');
    expect(compiled.sql).toContain('"telegram_chats"."migrated_to_chat_id" is null');
    expect(compiled.params).toContain(BOT_ID);
    expect(chatQuery().limit).toBe(20);
  });

  it.each(["editor", "viewer"])("rejects %s before reading group data", async (role) => {
    const { db, select } = routeDatabase();
    const response = await routeApp(role, db).request(
      `/api/bots/${BOT_ID}/cos-inside/groups?query=ops`,
    );

    expect(response.status).toBe(403);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps the lookup scoped to an existing Bot", async () => {
    const { db, select } = routeDatabase({ botExists: false });
    const response = await routeApp("admin", db).request(
      "/api/bots/00000000-0000-4000-8000-000000000099/cos-inside/groups?query=ops",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Bot not found" });
    expect(select).toHaveBeenCalledOnce();
  });

  it("rejects an overlong search before querying the Bot", async () => {
    const { db, select } = routeDatabase();
    const response = await routeApp("owner", db).request(
      `/api/bots/${BOT_ID}/cos-inside/groups?query=${"x".repeat(65)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_subject_search",
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps the governance chat subjects shape on the shared query", async () => {
    const { db } = routeDatabase();
    const app = new Hono().route("/api/bots", governanceRoutes(db, {} as never, {} as never));
    const response = await app.request(
      `/api/bots/${BOT_ID}/governance/subjects?kind=chat&query=ops`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      subjects: [
        { id: "-1001", name: "Operations", username: "operations" },
        { id: "-1002", name: "Release", username: null },
      ],
    });
  });
});
