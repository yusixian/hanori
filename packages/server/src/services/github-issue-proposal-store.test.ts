import type { Database } from "@cos-tool-bot/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { SettingsGitHubIssueProposalStore } from "./github-issue-proposal-store.js";

const BOT = "00000000-0000-4000-8000-000000000001";
const ID = "a".repeat(24);

describe("PostgreSQL settings proposal CAS", () => {
  it("updates only the tenant/ID key and exact previous persisted value, checking RETURNING", async () => {
    const conditions: SQL[] = [];
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ key: "claimed" }])
      .mockResolvedValueOnce([]);
    const set = vi.fn(() => ({
      where: (condition: SQL) => {
        conditions.push(condition);
        return { returning };
      },
    }));
    const db = { update: () => ({ set }) } as unknown as Database;
    const store = new SettingsGitHubIssueProposalStore(db);
    expect(await store.compareExchange(BOT, ID, "pending-json", "executing-json")).toBe(true);
    expect(await store.compareExchange(BOT, ID, "pending-json", "cancelled-json")).toBe(false);
    const query = new PgDialect().sqlToQuery(conditions[0]!);
    expect(query.sql).toContain('"settings"."key" = $1');
    expect(query.sql).toContain('"settings"."value" = $2');
    expect(query.sql).toContain("and");
    expect(query.params).toEqual([`github-issue-proposal:v1:${BOT}:${ID}`, "pending-json"]);
    expect(set).toHaveBeenCalledWith({ value: "executing-json" });
  });
});

it.each(["insert", "get", "list", "compareExchange"] as const)(
  "does not expose body-bearing SQL diagnostics when %s fails",
  async (operation) => {
    const privateValue =
      'SQL parameters: {"body":"private proposal body","diagnostic":"private diagnostic"}';
    const fail = async () => {
      throw new Error(privateValue);
    };
    const db = {
      insert: () => ({ values: fail }),
      select: () => ({ from: () => ({ where: fail }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: fail }) }) }),
    } as unknown as Database;
    const store = new SettingsGitHubIssueProposalStore(db);
    const error = await (
      operation === "insert"
        ? store.insert(BOT, ID, privateValue)
        : operation === "get"
          ? store.get(BOT, ID)
          : operation === "list"
            ? store.list(BOT)
            : store.compareExchange(BOT, ID, privateValue, privateValue)
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("不要重发");
    expect(String(error)).not.toContain("private");
    expect((error as Error).cause).toBeUndefined();
  },
);

it("scopes every read/list query to the proposal tenant and rejects wildcard tenant keys", async () => {
  const conditions: SQL[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          conditions.push(condition);
          return [];
        },
      }),
    }),
  } as unknown as Database;
  const store = new SettingsGitHubIssueProposalStore(db);
  await store.get(BOT, ID);
  await store.list(BOT);
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(conditions[0]!).params).toEqual([
    `github-issue-proposal:v1:${BOT}:${ID}`,
  ]);
  expect(dialect.sqlToQuery(conditions[1]!).params).toEqual([`github-issue-proposal:v1:${BOT}:%`]);
  await expect(store.list("%".repeat(36))).rejects.toThrow("key");
  expect(conditions).toHaveLength(2);
});
