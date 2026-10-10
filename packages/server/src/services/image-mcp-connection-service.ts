import type { Database } from "@cos-tool-bot/database";
import { pixaiMcpConnections } from "@cos-tool-bot/database";
import { eq, ne } from "drizzle-orm";
import type { Logger } from "pino";
import { KeyedAsyncLock } from "./keyed-async-lock.js";
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
  private epoch = 0;
  private readonly stateWrites = new KeyedAsyncLock();

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
      createAuthSession: () => this.provider.forConnection(),
      environment: options.environment,
      endpointOverride: options.endpointOverride,
      onCallError: async ({ toolName, code, isCurrent }) => {
        if (code === "NOT_CONFIGURED") return;
        if (
          toolName === "get_capabilities" ||
          code === "AUTHORIZATION_REQUIRED" ||
          code === "NOT_CONNECTED"
        ) {
          await this.recordError(
            code === "AUTHORIZATION_REQUIRED" ? code : `MCP_${toolName.toUpperCase()}_${code}`,
            { preserveAuthorization: true, isCurrent },
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
    const epoch = this.epoch;
    const state = await this.provider.tokens().catch(() => undefined);
    if (!state || epoch !== this.epoch) return;
    if (!state.refresh_token) {
      await this.recordError("OFFLINE_ACCESS_REQUIRED", { epoch });
      return;
    }
    try {
      await this.client.connect();
      await this.recordConnected(epoch);
    } catch {
      await this.recordError("CONNECTION_FAILED", { epoch });
    }
  }

  async beginAuthorization(ownerUserId: string): Promise<string> {
    if (!this.client.endpoint) throw new PixaiMcpClientError("NOT_CONFIGURED");
    const epoch = ++this.epoch;
    this.authorizationUrl = undefined;
    const closing = this.client.close();
    await this.stateWrites.run("state", async () => {
      await closing;
      if (epoch !== this.epoch) return;
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
    });
    this.requireCurrent(epoch);
    try {
      await this.client.connect();
      await this.recordConnected(epoch);
    } catch (error) {
      this.requireCurrent(epoch);
      if (!(error instanceof PixaiMcpClientError) || error.code !== "AUTHORIZATION_REQUIRED") {
        await this.recordError("AUTHORIZATION_START_FAILED", { epoch });
        throw new Error("PixAI MCP authorization could not start");
      }
    }
    this.requireCurrent(epoch);
    const authorizationUrl = this.authorizationUrl as URL | undefined;
    if (!authorizationUrl) throw new Error("PixAI MCP authorization URL is unavailable");
    return authorizationUrl.toString();
  }

  async finishAuthorization(code: string, state: string): Promise<void> {
    const epoch = this.epoch;
    const valid = await this.stateWrites.run("state", async () => {
      if (epoch !== this.epoch) return false;
      const [pending] = await this.db
        .select({
          status: pixaiMcpConnections.status,
          expiresAt: pixaiMcpConnections.authorizationExpiresAt,
        })
        .from(pixaiMcpConnections)
        .where(eq(pixaiMcpConnections.id, this.connectionId))
        .limit(1);
      if (epoch !== this.epoch || pending?.status !== "authorizing" || !pending.expiresAt)
        return false;
      if (pending.expiresAt.getTime() <= Date.now()) {
        await this.provider.invalidateCredentials("verifier");
        await this.writeError("OAUTH_STATE_EXPIRED");
        return false;
      }
      return this.provider.consumeAuthorizationState(state);
    });
    if (!valid) throw new Error("PixAI MCP OAuth state is invalid or expired");
    this.requireCurrent(epoch);
    try {
      await this.client.finishAuthorization(code);
    } catch {
      await this.recordError("OAUTH_CALLBACK_FAILED", { epoch });
      throw new Error("PixAI MCP authorization failed");
    }
    this.requireCurrent(epoch);
    if (!(await this.provider.tokens())?.refresh_token) {
      await this.recordError("OFFLINE_ACCESS_REQUIRED", { epoch });
      throw new Error("PixAI MCP offline access was not granted");
    }
    await this.recordConnected(epoch);
    this.requireCurrent(epoch);
  }

  async disconnect(): Promise<void> {
    const epoch = ++this.epoch;
    this.authorizationUrl = undefined;
    const closing = this.client.close();
    await this.stateWrites.run("state", async () => {
      await closing;
      if (epoch !== this.epoch) return;
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
    ++this.epoch;
    this.authorizationUrl = undefined;
    await this.client.close();
    await this.stateWrites.run("state", async () => {});
  }

  private requireCurrent(epoch: number): void {
    if (epoch !== this.epoch) throw new Error("PixAI MCP authorization was superseded");
  }

  private recordConnected(epoch: number): Promise<void> {
    return this.stateWrites.run("state", async () => {
      if (epoch !== this.epoch) return;
      await this.writeConnected();
    });
  }

  private async writeConnected(): Promise<void> {
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

  private recordError(
    code: string,
    options: { preserveAuthorization?: boolean; epoch?: number; isCurrent?: () => boolean } = {},
  ): Promise<void> {
    const epoch = options.epoch ?? this.epoch;
    return this.stateWrites.run("state", async () => {
      if (epoch !== this.epoch || options.isCurrent?.() === false) return;
      await this.writeError(code, options.preserveAuthorization);
    });
  }

  private async writeError(code: string, preserveAuthorization = false): Promise<void> {
    this.logger.warn({ code }, "PixAI MCP connection needs attention");
    await this.db
      .insert(pixaiMcpConnections)
      .values({ id: this.connectionId, status: "error", lastErrorCode: code })
      .onConflictDoUpdate({
        target: pixaiMcpConnections.id,
        set: { status: "error", lastErrorCode: code, updatedAt: new Date() },
        // Background polling must not invalidate the owner's pending OAuth callback.
        setWhere: preserveAuthorization ? ne(pixaiMcpConnections.status, "authorizing") : undefined,
      });
  }
}
