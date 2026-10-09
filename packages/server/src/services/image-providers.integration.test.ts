import { createDb, schema, type Database } from "@cos-tool-bot/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PixaiMcpOAuthDbStore } from "./pixai-mcp-oauth-store.js";
import { PixaiMcpOAuthProvider } from "./pixai-mcp-oauth-provider.js";
const url = process.env["IMAGE_PROVIDER_TEST_DATABASE_URL"];
const integration = url ? describe : describe.skip;
integration("image providers PostgreSQL compatibility", () => {
  let database: ReturnType<typeof createDb>,
    reserved: Awaited<ReturnType<ReturnType<typeof createDb>["client"]["reserve"]>>;
  let isolated: ReturnType<typeof drizzle>, db: Database;
  const namespace = `image_provider_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    database = createDb(url!);
    reserved = await database.client.reserve();
    await reserved.unsafe(`create schema ${namespace}`);
    await reserved.unsafe(`set search_path to ${namespace}`);
    const initial = await readFile(
      new URL("../../../database/drizzle/0043_crazy_tusk.sql", import.meta.url),
      "utf8",
    );
    const connectionTable = initial
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes('CREATE TABLE "pixai_mcp_connections"'))!;
    await reserved.unsafe(connectionTable);
    await reserved.unsafe(
      "create table image_generations (id text primary key, provider text not null, constraint image_generations_provider_check check (provider in ('mcp_pixai','general_backend')))",
    );
    isolated = drizzle({
      connection: { url: url!, max: 1, connection: { search_path: namespace } },
      schema,
    });
    db = isolated as unknown as Database;
  });
  afterAll(async () => {
    await isolated?.$client.end();
    if (reserved) {
      await reserved.unsafe(`drop schema ${namespace} cascade`);
      reserved.release();
    }
    await database?.client.end();
  });
  it("keeps PixAI, GPT and Gemini grants independent, including callback state consumption", async () => {
    const stores = ["default", "openai-image", "gemini-image"].map(
      (id) => new PixaiMcpOAuthDbStore(db, "synthetic-image-encryption-key", id),
    );
    for (const [index, store] of stores.entries())
      await store.patch(`https://mcp.example.com/${index}`, {
        tokens: {
          access_token: `synthetic-${index}`,
          refresh_token: `refresh-${index}`,
          token_type: "Bearer",
        },
        authorizationState: `state-${index}`,
      });
    expect(await stores[1]!.consumeAuthorizationState("https://mcp.example.com/1", "state-2")).toBe(
      false,
    );
    expect(await stores[1]!.consumeAuthorizationState("https://mcp.example.com/1", "state-1")).toBe(
      true,
    );
    expect((await stores[0]!.read())?.authorizationState).toBe("state-0");
    expect((await stores[2]!.read())?.authorizationState).toBe("state-2");
    await stores[1]!.patch("https://mcp.example.com/1", { tokens: null });
    expect((await stores[0]!.read())?.tokens?.access_token).toBe("synthetic-0");
    expect((await stores[2]!.read())?.tokens?.access_token).toBe("synthetic-2");
    const rows = await reserved.unsafe("select encrypted_state from pixai_mcp_connections");
    expect(JSON.stringify(rows)).not.toContain("synthetic-");
  });
  it("requests the matching provider scopes without granting PixAI rights", () => {
    const provider = new PixaiMcpOAuthProvider({
      endpoint: "https://mcp.example.com/mcp/gemini-image",
      store: new PixaiMcpOAuthDbStore(db, "key", "gemini-image"),
      redirectUrl: "https://bot.example.com/callback",
      onAuthorizationUrl: () => {},
      scopes: ["openid", "offline_access", "mcp:gemini-image:read", "mcp:gemini-image:generate"],
    });
    expect(provider.clientMetadata.scope).toContain("mcp:gemini-image:generate");
    expect(provider.clientMetadata.scope).not.toContain("mcp:pixai");
  });
  it("applies the generated migration while preserving historical task providers", async () => {
    await reserved.unsafe(
      "insert into image_generations values ('old-pixai','mcp_pixai'),('old-general','general_backend')",
    );
    const migration = await readFile(
      new URL("../../../database/drizzle/0068_equal_owl.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      await reserved.unsafe(statement);
    await reserved.unsafe(
      "insert into image_generations values ('gpt','mcp_openai'),('gemini','mcp_gemini')",
    );
    expect(
      (await reserved.unsafe("select provider from image_generations order by id")).map(
        (row) => row.provider,
      ),
    ).toEqual(["mcp_gemini", "mcp_openai", "general_backend", "mcp_pixai"]);
    await expect(
      reserved.unsafe("insert into image_generations values ('unknown','unknown')"),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
