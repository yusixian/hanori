import type { Database } from "@cos-tool-bot/database";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { ImageMcpConnectionService } from "./image-mcp-connection-service.js";

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

afterEach(() => vi.unstubAllGlobals());

describe("ImageMcpConnectionService", () => {
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
