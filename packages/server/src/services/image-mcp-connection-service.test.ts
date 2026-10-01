import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { ImageMcpConnectionService } from "./image-mcp-connection-service.js";
import { PixaiMcpClient } from "./pixai-mcp-client.js";
import { PixaiMcpOAuthProvider } from "./pixai-mcp-oauth-provider.js";

const encryptionKey = "isolated-test-encryption-key";

function createService(db: Database, endpointOverride?: string) {
  return new ImageMcpConnectionService({
    db,
    encryptionKey,
    baseURL: "https://bot.example.com",
    logger: pino({ enabled: false }),
    environment: "production",
    endpointOverride,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pendingConnection(status = "authorizing") {
  const row = {
    status,
    authorizationExpiresAt: new Date(Date.now() + 60_000),
    grantedScopes: [] as string[],
    lastErrorCode: null as string | null,
  };
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [{ ...row, expiresAt: row.authorizationExpiresAt }]),
  };
  const conditions: { sql: string; params: unknown[] }[] = [];
  const upsert = vi.fn(async (options: { set: Partial<typeof row>; setWhere?: SQL }) => {
    if (options.setWhere) {
      const condition = new PgDialect().sqlToQuery(options.setWhere);
      conditions.push({ sql: condition.sql, params: condition.params });
      if (row.status === condition.params[0]) return;
    }
    Object.assign(row, options.set);
  });
  const db = {
    select: vi.fn(() => query),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: upsert })) })),
  } as unknown as Database;
  const service = createService(db, "https://mcp.example.com/mcp/pixai");
  vi.spyOn(PixaiMcpOAuthProvider.prototype, "consumeAuthorizationState").mockResolvedValue(true);
  vi.spyOn(PixaiMcpOAuthProvider.prototype, "tokens").mockResolvedValue({
    access_token: "synthetic-access",
    token_type: "Bearer",
    refresh_token: "synthetic-refresh",
    scope: "mcp:pixai:read offline_access",
  });
  const finish = vi.spyOn(PixaiMcpClient.prototype, "finishAuthorization").mockResolvedValue();
  return { service, row, finish, conditions };
}

describe("ImageMcpConnectionService", () => {
  it("accepts the owner callback after background result polling fails during authorization", async () => {
    const { service, row, finish, conditions } = pendingConnection();

    await expect(service.adapter.waitForGeneration("synthetic-operation")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
    expect(conditions).toEqual([
      { sql: '"pixai_mcp_connections"."status" <> $1', params: ["authorizing"] },
    ]);
    expect(row.status).toBe("authorizing");
    await service.finishAuthorization("synthetic-code", "synthetic-state");
    expect(finish).toHaveBeenCalledWith("synthetic-code");
    expect(await service.getStatus()).toEqual({
      status: "connected",
      scopes: ["mcp:pixai:read", "offline_access"],
      lastError: undefined,
    });
    await service.close();
  });

  it.each(["connected", "disconnected"])(
    "continues reporting polling failures when the connection is %s",
    async (status) => {
      const { service, row } = pendingConnection(status);
      await expect(service.adapter.waitForGeneration("synthetic-operation")).rejects.toMatchObject({
        code: "NOT_CONNECTED",
      });
      expect(row.status).toBe("error");
      expect(row.lastErrorCode).toBe("MCP_WAIT_FOR_RESULT_NOT_CONNECTED");
      await service.close();
    },
  );

  it("reports an actual OAuth callback failure while authorization is pending", async () => {
    const { service, row, finish } = pendingConnection();
    finish.mockRejectedValue(new Error("synthetic callback failure"));

    await expect(service.finishAuthorization("synthetic-code", "synthetic-state")).rejects.toThrow(
      "PixAI MCP authorization failed",
    );
    expect(row.status).toBe("error");
    expect(row.lastErrorCode).toBe("OAUTH_CALLBACK_FAILED");
    await service.close();
  });

  it("keeps an unconfigured integration idle without database or network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const select = vi.fn();
    const insert = vi.fn();
    const transaction = vi.fn();
    const service = createService({ select, insert, transaction } as unknown as Database);

    await service.initialize();
    expect(await service.getStatus()).toEqual({
      status: "disconnected",
      scopes: [],
      lastError: "NOT_CONFIGURED",
    });
    await expect(service.beginAuthorization("owner")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    await expect(
      service.artifacts.download({
        type: "resource_link",
        uri: "https://mcp.example.com/api/artifacts/12345678-1234-4234-8234-123456789abc",
        name: "image",
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "INVALID_URI" });
    await service.close();
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://previous.example.com/mcp/pixai"])(
    "reports that a previously connected grant needs authorization when its endpoint is %s",
    async (endpoint) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const row = {
        status: "connected",
        grantedScopes: ["mcp:pixai:read"],
        encryptedState: encrypt(
          JSON.stringify({
            endpoint,
            tokens: { access_token: "synthetic-access", token_type: "Bearer" },
          }),
          encryptionKey,
        ),
      };
      const query = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([row]),
      };
      const insert = vi.fn();
      const transaction = vi.fn();
      const db = { select: vi.fn(() => query), insert, transaction } as unknown as Database;
      const service = createService(db, "https://mcp.example.com/mcp/pixai");

      await service.initialize();
      expect(await service.getStatus()).toEqual({
        status: "disconnected",
        scopes: [],
        lastError: "AUTHORIZATION_REQUIRED",
      });
      await service.close();
      expect(fetch).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
