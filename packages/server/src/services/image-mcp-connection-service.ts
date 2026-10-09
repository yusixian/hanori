import type { Database } from "@cos-tool-bot/database";
import { pixaiMcpConnections } from "@cos-tool-bot/database";
import { eq, ne } from "drizzle-orm";
import type { Logger } from "pino";
import { PixaiMcpAdapter } from "./pixai-mcp-adapter.js";
import { PixaiMcpArtifactReader } from "./pixai-mcp-artifacts.js";
import {
  PixaiMcpClient,
  PixaiMcpClientError,
  resolvePixaiMcpEndpoint,
} from "./pixai-mcp-client.js";
import { PIXAI_MCP_OAUTH_SCOPES, PixaiMcpOAuthProvider } from "./pixai-mcp-oauth-provider.js";
import { PixaiMcpOAuthDbStore } from "./pixai-mcp-oauth-store.js";

export interface ImageMcpConnectionStatus {
  status: "disconnected" | "authorizing" | "connected" | "error";
  scopes: string[];
  lastError?: string;
}

export interface ImageMcpConnectionServiceOptions {
  db: Database;
  encryptionKey: string;
  baseURL: string;
  logger: Logger;
  environment: "production" | "non-production";
  endpointOverride?: string;
  connectionId?: string;
  scopes?: readonly string[];
  routePrefix?: string;
}

export class ImageMcpConnectionService {
  readonly endpoint: string | undefined;
  private readonly connectionId: string;
  private readonly scopes: readonly string[];
  readonly adapter: PixaiMcpAdapter;
  readonly artifacts: PixaiMcpArtifactReader;

  private readonly db: Database;
  private readonly logger: Logger;
  private readonly provider: PixaiMcpOAuthProvider;
  private readonly client: PixaiMcpClient;
  private authorizationUrl?: URL;

  constructor(options: ImageMcpConnectionServiceOptions) {
    this.db = options.db;
    this.connectionId = options.connectionId ?? "default";
    this.scopes = options.scopes ?? PIXAI_MCP_OAUTH_SCOPES;
    this.logger = options.logger;
    const endpoint = resolvePixaiMcpEndpoint({
      environment: options.environment,
      endpointOverride: options.endpointOverride,
    });
    this.endpoint = endpoint?.href;
    this.provider = new PixaiMcpOAuthProvider({
      endpoint,
      store: new PixaiMcpOAuthDbStore(options.db, options.encryptionKey, this.connectionId),
      redirectUrl: new URL(
        `${options.routePrefix ?? "/api/image-mcp"}/oauth/callback`,
        options.baseURL,
      ),
      onAuthorizationUrl: (url) => {
        this.authorizationUrl = new URL(url);
      },
      clientUri: options.baseURL,
      scopes: this.scopes,
    });
    this.client = new PixaiMcpClient({
      authProvider: this.provider,
      environment: options.environment,
      endpointOverride: options.endpointOverride,
      onCallError: async ({ toolName, code }) => {
        if (code === "NOT_CONFIGURED") return;
        if (
          toolName === "get_capabilities" ||
          code === "AUTHORIZATION_REQUIRED" ||
          code === "NOT_CONNECTED"
        ) {
          await this.recordError(
            code === "AUTHORIZATION_REQUIRED" ? code : `MCP_${toolName.toUpperCase()}_${code}`,
            { preserveAuthorization: true },
          );
        }
      },
    });
    this.adapter = new PixaiMcpAdapter(this.client);
    this.artifacts = new PixaiMcpArtifactReader({
      endpoint,
      authProvider: this.provider,
      maxBytes: this.connectionId === "default" ? 5 * 1024 * 1024 : 20 * 1024 * 1024,
    });
  }

  async initialize(): Promise<void> {
    if (!this.client.endpoint) return;
    const state = await this.provider.tokens().catch(() => undefined);
    if (!state) return;
    if (!state.refresh_token) {
      await this.recordError("OFFLINE_ACCESS_REQUIRED");
      return;
    }
    try {
      await this.client.connect();
      await this.recordConnected();
    } catch {
      await this.recordError("CONNECTION_FAILED");
    }
  }

  async beginAuthorization(ownerUserId: string): Promise<string> {
    if (!this.client.endpoint) throw new PixaiMcpClientError("NOT_CONFIGURED");
    this.authorizationUrl = undefined;
    await this.client.close();
    await this.provider.invalidateCredentials("tokens");
    await this.provider.invalidateCredentials("verifier");
    const authorizationExpiresAt = new Date(Date.now() + 10 * 60_000);
    await this.db
      .insert(pixaiMcpConnections)
      .values({
        id: this.connectionId,
        status: "authorizing",
        ownerUserId,
        authorizationExpiresAt,
        lastErrorCode: null,
      })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: {
          status: "authorizing",
          ownerUserId,
          authorizationExpiresAt,
          lastErrorCode: null,
          updatedAt: new Date(),
        },
      });
    try {
      await this.client.connect();
      await this.recordConnected();
    } catch (error) {
      if (!(error instanceof PixaiMcpClientError) || error.code !== "AUTHORIZATION_REQUIRED") {
        await this.recordError("AUTHORIZATION_START_FAILED");
        throw new Error("PixAI MCP authorization could not start");
      }
    }
    const authorizationUrl = this.authorizationUrl as URL | undefined;
    if (!authorizationUrl) throw new Error("PixAI MCP authorization URL is unavailable");
    return authorizationUrl.toString();
  }

  async finishAuthorization(code: string, state: string): Promise<void> {
    const [pending] = await this.db
      .select({
        status: pixaiMcpConnections.status,
        expiresAt: pixaiMcpConnections.authorizationExpiresAt,
      })
      .from(pixaiMcpConnections)
      .where(eq(pixaiMcpConnections.id, this.connectionId))
      .limit(1);
    if (pending?.status !== "authorizing" || !pending.expiresAt) {
      throw new Error("PixAI MCP OAuth state is invalid or expired");
    }
    if (pending.expiresAt.getTime() <= Date.now()) {
      await this.provider.invalidateCredentials("verifier");
      await this.recordError("OAUTH_STATE_EXPIRED");
      throw new Error("PixAI MCP OAuth state is invalid or expired");
    }
    if (!(await this.provider.consumeAuthorizationState(state))) {
      throw new Error("PixAI MCP OAuth state is invalid or expired");
    }
    try {
      await this.client.finishAuthorization(code);
    } catch {
      await this.recordError("OAUTH_CALLBACK_FAILED");
      throw new Error("PixAI MCP authorization failed");
    }
    if (!(await this.provider.tokens())?.refresh_token) {
      await this.recordError("OFFLINE_ACCESS_REQUIRED");
      throw new Error("PixAI MCP offline access was not granted");
    }
    await this.recordConnected();
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    await this.provider.invalidateCredentials("all");
    await this.db
      .insert(pixaiMcpConnections)
      .values({ id: this.connectionId, status: "disconnected", grantedScopes: [] })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: {
          status: "disconnected",
          grantedScopes: [],
          ownerUserId: null,
          authorizationExpiresAt: null,
          lastErrorCode: null,
          connectedAt: null,
          updatedAt: new Date(),
        },
      });
  }

  async getStatus(): Promise<ImageMcpConnectionStatus> {
    if (!this.client.endpoint) {
      return { status: "disconnected", scopes: [], lastError: "NOT_CONFIGURED" };
    }
    const [row] = await this.db
      .select({
        status: pixaiMcpConnections.status,
        grantedScopes: pixaiMcpConnections.grantedScopes,
        lastErrorCode: pixaiMcpConnections.lastErrorCode,
      })
      .from(pixaiMcpConnections)
      .where(eq(pixaiMcpConnections.id, this.connectionId))
      .limit(1);
    if (row?.status === "connected" && !(await this.provider.tokens())) {
      return { status: "disconnected", scopes: [], lastError: "AUTHORIZATION_REQUIRED" };
    }
    return {
      status: (row?.status as ImageMcpConnectionStatus["status"] | undefined) ?? "disconnected",
      scopes: row?.grantedScopes ?? [],
      lastError: row?.lastErrorCode ?? undefined,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async recordConnected(): Promise<void> {
    const tokens = await this.provider.tokens();
    const scopes = tokens?.scope?.split(/\s+/).filter(Boolean) ?? [...this.scopes];
    await this.db
      .insert(pixaiMcpConnections)
      .values({
        id: this.connectionId,
        status: "connected",
        grantedScopes: scopes,
        connectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: {
          status: "connected",
          grantedScopes: scopes,
          lastErrorCode: null,
          connectedAt: new Date(),
          authorizationExpiresAt: null,
          updatedAt: new Date(),
        },
      });
  }

  private async recordError(
    code: string,
    options: { preserveAuthorization?: boolean } = {},
  ): Promise<void> {
    this.logger.warn({ code }, "PixAI MCP connection needs attention");
    await this.db
      .insert(pixaiMcpConnections)
      .values({ id: this.connectionId, status: "error", lastErrorCode: code })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: { status: "error", lastErrorCode: code, updatedAt: new Date() },
        // Background polling must not invalidate the owner's pending OAuth callback.
        setWhere: options.preserveAuthorization
          ? ne(pixaiMcpConnections.status, "authorizing")
          : undefined,
      });
  }
}
