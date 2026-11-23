import type { Database } from "@cos-tool-bot/database";
import type { UsageSnapshot } from "@cos-tool-bot/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeDiagnostics, diagnosticRetentionMs } from "./diagnostics.js";
import type { BotRuntimeServices } from "./types.js";

const botId = "00000000-0000-4000-8000-000000000148";
const actor = { chatId: -100, userId: 7, messageId: 20 };
function setup(options: { stalled?: boolean } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn((statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    queries.push(query);
    if (options.stalled) return new Promise(() => {});
    if (query.sql.includes('"image_generations"'))
      return Promise.resolve([
        { state: "running", total: 2, prompt: "PRIVATE" },
        { state: "secret-state", total: 1, errorMessage: "PRIVATE" },
      ]);
    if (query.sql.includes('"rss_collections"'))
      return Promise.resolve([
        { active: 3, lastDigestAt: "2026-10-01T00:00:00.000Z", feedUrl: "PRIVATE" },
      ]);
    return Promise.resolve([{ value: 1 }]);
  });
  const audit = vi.fn().mockResolvedValue(undefined);
  const db = { execute, insert: vi.fn(() => ({ values: audit })) } as unknown as Database;
  const quota: UsageSnapshot = {
    timezone: "Asia/Shanghai",
    resources: [
      { resource: "ai_reply", scope: "bot", subjectKey: "PRIVATE", active: 99, windows: [] },
      { resource: "image", scope: "user_global", subjectKey: "PRIVATE", active: 99, windows: [] },
      {
        resource: "ai_reply",
        scope: "chat_user",
        subjectKey: "PRIVATE",
        active: 1,
        windows: [
          { window: "hour", used: 2, limit: 10, resetsAt: new Date("2026-10-02T12:00:00Z") },
        ],
      },
    ],
  };
  const getSnapshot = vi.fn().mockResolvedValue(quota);
  const services = {
    db,
    timerRegistry: { listActive: vi.fn(() => [{ chatId: -100 }, { chatId: -200 }]) },
    usageGovernance: { getSnapshot },
  } as unknown as BotRuntimeServices;
  const host = { getRuntimeStatus: () => ({ status: "running" as const, uptime: 1234 }) };
  const diagnostics = createRuntimeDiagnostics(
    {
      bot: { id: botId, name: "test", adminChatIds: [7], cosInsideConfig: null },
      token: "SECRET",
      aiRuntime: null,
    },
    services,
    host,
  );
  return { diagnostics, execute, queries, audit, getSnapshot };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runtime diagnostics assembly", () => {
  it("scopes operational reads and audit to the current Bot and chat, projecting safe state only", async () => {
    vi.stubEnv("APP_VERSION", "a".repeat(40));
    vi.stubEnv("NODE_ENV", "production");
    const { diagnostics, queries, getSnapshot, audit } = setup();
    const response = await diagnostics.query(actor, { operation: "get_runtime_status" });
    expect(response.ok).toBe(true);
    expect(response.runtime).toMatchObject({
      botStatus: "running",
      uptimeMs: 1234,
      database: "reachable",
      server: "responding",
      version: "a".repeat(40),
      environment: "production",
      telegramMode: "polling",
      observationCapabilities: {
        model: { status: "not_implemented", reason: "active_probe_not_configured" },
        telegram: { status: "not_implemented", reason: "active_probe_not_configured" },
        githubTasks: { status: "not_implemented", reason: "task_reader_not_connected" },
      },
      activeTimers: 1,
      imageTasks: { states: { running: 2, unknown: 1 } },
      rss: { activeCollections: 3, lastDigestAt: Date.parse("2026-10-01T00:00:00Z") },
      quota: [
        {
          resource: "ai_reply",
          scope: "chat_user",
          active: 1,
          windows: [{ window: "hour", used: 2, limit: 10, remaining: 8 }],
        },
      ],
    });
    expect(JSON.stringify(response)).not.toMatch(
      /PRIVATE|SECRET|secret-state|subjectKey|feedUrl|prompt/,
    );
    const scoped = queries.filter((query) => query.sql !== "select 1");
    expect(scoped).toHaveLength(2);
    for (const query of scoped)
      expect(query.params).toEqual(expect.arrayContaining([botId, actor.chatId]));
    expect(getSnapshot).toHaveBeenCalledWith({ botId, chatId: -100, userId: 7, chatKind: "group" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        botId,
        meta: expect.objectContaining({
          userId: 7,
          chatId: -100,
          operation: "get_runtime_status",
          resultCount: 1,
        }),
      }),
    );
  });

  it("performs no state read for a non-admin and audits the denial", async () => {
    const { diagnostics, execute, audit, getSnapshot } = setup();
    const response = await diagnostics.query(
      { ...actor, userId: 8 },
      { operation: "get_runtime_status" },
    );
    expect(response).toMatchObject({ ok: false, code: "forbidden" });
    expect(execute).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ outcome: "forbidden", resultCount: 0 }),
      }),
    );
  });

  it("bounds database reads even when timed-out reads never settle", async () => {
    vi.useFakeTimers();
    const { diagnostics, execute } = setup({ stalled: true });
    for (let index = 0; index < 5; index++) {
      const result = diagnostics.query(
        { ...actor, chatId: -100 - index },
        { operation: "get_runtime_status" },
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect((await result).runtime).toMatchObject({
        database: "unavailable",
        imageTasks: "unobserved",
        rss: "unobserved",
      });
    }
    expect(execute.mock.calls.length).toBeLessThanOrEqual(8);
  });
});

it("bounds configurable retention and marks empty history as current-process evidence", async () => {
  expect(diagnosticRetentionMs("7200000")).toBe(7_200_000);
  for (const invalid of [undefined, "", "NaN", "0", "86400001"])
    expect(diagnosticRetentionMs(invalid)).toBe(86_400_000);
  vi.stubEnv("RUNTIME_DIAGNOSTIC_RETENTION_MS", "7200000");
  const { diagnostics } = setup();
  await expect(diagnostics.query(actor, { operation: "get_request_trace" })).resolves.toMatchObject(
    {
      ok: false,
      code: "not_found",
      retentionMs: 7_200_000,
      historyScope: "current_process",
    },
  );
});
