import type { Database } from "@cos-tool-bot/database";
import { pixaiMcpConnections } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
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
}

export class ImageMcpConnectionService {
  readonly adapter: PixaiMcpAdapter;
  readonly artifacts: PixaiMcpArtifactReader;

  private readonly db: Database;
  private readonly logger: Logger;
  private readonly provider: PixaiMcpOAuthProvider;
  private readonly client: PixaiMcpClient;
  private authorizationUrl?: URL;

  constructor(options: ImageMcpConnectionServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    const endpoint = resolvePixaiMcpEndpoint({
      environment: options.environment,
      endpointOverride: options.endpointOverride,
    });
    this.provider = new PixaiMcpOAuthProvider({
      store: new PixaiMcpOAuthDbStore(options.db, options.encryptionKey),
      redirectUrl: new URL("/api/image-mcp/oauth/callback", options.baseURL),
      onAuthorizationUrl: (url) => {
        this.authorizationUrl = new URL(url);
      },
      clientUri: options.baseURL,
    });
    this.client = new PixaiMcpClient({
      authProvider: this.provider,
      environment: options.environment,
      endpointOverride: options.endpointOverride,
      onCallError: async ({ toolName, code }) => {
        if (
          toolName === "get_capabilities" ||
          code === "AUTHORIZATION_REQUIRED" ||
          code === "NOT_CONNECTED"
        ) {
          await this.recordError(
            code === "AUTHORIZATION_REQUIRED" ? code : `MCP_${toolName.toUpperCase()}_${code}`,
          );
        }
      },
    });
    this.adapter = new PixaiMcpAdapter(this.client);
    this.artifacts = new PixaiMcpArtifactReader({ endpoint, authProvider: this.provider });
  }

  async initialize(): Promise<void> {
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
    this.authorizationUrl = undefined;
    await this.client.close();
    await this.provider.invalidateCredentials("tokens");
    await this.provider.invalidateCredentials("verifier");
    const authorizationExpiresAt = new Date(Date.now() + 10 * 60_000);
    await this.db
      .insert(pixaiMcpConnections)
      .values({
        id: "default",
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
      .where(eq(pixaiMcpConnections.id, "default"))
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
      .values({ id: "default", status: "disconnected", grantedScopes: [] })
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
    const [row] = await this.db
      .select({
        status: pixaiMcpConnections.status,
        grantedScopes: pixaiMcpConnections.grantedScopes,
        lastErrorCode: pixaiMcpConnections.lastErrorCode,
      })
      .from(pixaiMcpConnections)
      .where(eq(pixaiMcpConnections.id, "default"))
      .limit(1);
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
    const scopes = tokens?.scope?.split(/\s+/).filter(Boolean) ?? [...PIXAI_MCP_OAUTH_SCOPES];
    await this.db
      .insert(pixaiMcpConnections)
      .values({
        id: "default",
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

  private async recordError(code: string): Promise<void> {
    this.logger.warn({ code }, "PixAI MCP connection needs attention");
    await this.db
      .insert(pixaiMcpConnections)
      .values({ id: "default", status: "error", lastErrorCode: code })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: { status: "error", lastErrorCode: code, updatedAt: new Date() },
      });
  }
}
