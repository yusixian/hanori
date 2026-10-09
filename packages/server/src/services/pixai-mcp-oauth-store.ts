import type { Database } from "@cos-tool-bot/database";
import { pixaiMcpConnections } from "@cos-tool-bot/database";
import { sql } from "drizzle-orm";
import { encrypt, tryDecrypt } from "../utils/crypto.js";
import {
  constantTimeEqual,
  type PixaiMcpOAuthState,
  type PixaiMcpOAuthStore,
  type PixaiMcpOAuthUpdate,
} from "./pixai-mcp-oauth-provider.js";

export class PixaiMcpOAuthStateCorruptError extends Error {
  constructor() {
    super("PixAI MCP OAuth state cannot be decrypted");
    this.name = "PixaiMcpOAuthStateCorruptError";
  }
}

/** Encrypted, transactionally patched storage for the instance-wide Owner grant. */
export class PixaiMcpOAuthDbStore implements PixaiMcpOAuthStore {
  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly connectionId = "default",
  ) {}

  async read(): Promise<Readonly<PixaiMcpOAuthState> | undefined> {
    const [row] = await this.db
      .select({ encryptedState: pixaiMcpConnections.encryptedState })
      .from(pixaiMcpConnections)
      .where(sql`${pixaiMcpConnections.id} = ${this.connectionId}`)
      .limit(1);
    return this.decode(row?.encryptedState ?? null);
  }

  async patch(endpoint: string | undefined, update: PixaiMcpOAuthUpdate): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        this.connectionId === "default"
          ? sql`select pg_advisory_xact_lock(hashtext('pixai-mcp-oauth'))`
          : sql`select pg_advisory_xact_lock(hashtext(${`image-mcp-oauth:${this.connectionId}`}))`,
      );
      const [row] = await tx
        .select({ encryptedState: pixaiMcpConnections.encryptedState })
        .from(pixaiMcpConnections)
        .where(sql`${pixaiMcpConnections.id} = ${this.connectionId}`)
        .limit(1);
      const current = this.decode(row?.encryptedState ?? null);
      const next: PixaiMcpOAuthState =
        endpoint && current?.endpoint === endpoint ? { ...current } : {};
      if (endpoint) next.endpoint = endpoint;
      for (const [key, value] of Object.entries(update) as [
        keyof PixaiMcpOAuthState,
        PixaiMcpOAuthState[keyof PixaiMcpOAuthState] | null,
      ][]) {
        if (value === null) delete next[key];
        else next[key] = value as never;
      }
      const encryptedState =
        Object.keys(next).length === 0 ? null : encrypt(JSON.stringify(next), this.encryptionKey);
      await tx
        .insert(pixaiMcpConnections)
        .values({ id: this.connectionId, encryptedState })
        .onConflictDoUpdate({
          target: pixaiMcpConnections.id,
          set: { encryptedState, updatedAt: new Date() },
        });
    });
  }

  async consumeAuthorizationState(endpoint: string, receivedState: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        this.connectionId === "default"
          ? sql`select pg_advisory_xact_lock(hashtext('pixai-mcp-oauth'))`
          : sql`select pg_advisory_xact_lock(hashtext(${`image-mcp-oauth:${this.connectionId}`}))`,
      );
      const [row] = await tx
        .select({ encryptedState: pixaiMcpConnections.encryptedState })
        .from(pixaiMcpConnections)
        .where(sql`${pixaiMcpConnections.id} = ${this.connectionId}`)
        .limit(1);
      const current = this.decode(row?.encryptedState ?? null) ?? {};
      const expected = current.authorizationState;
      if (current.endpoint !== endpoint || !expected || !constantTimeEqual(expected, receivedState))
        return false;
      const next = { ...current };
      delete next.authorizationState;
      const encryptedState =
        Object.keys(next).length === 0 ? null : encrypt(JSON.stringify(next), this.encryptionKey);
      await tx
        .insert(pixaiMcpConnections)
        .values({ id: this.connectionId, encryptedState })
        .onConflictDoUpdate({
          target: pixaiMcpConnections.id,
          set: { encryptedState, updatedAt: new Date() },
        });
      return true;
    });
  }

  private decode(encryptedState: string | null): PixaiMcpOAuthState | undefined {
    if (!encryptedState) return undefined;
    const plaintext = tryDecrypt(encryptedState, this.encryptionKey);
    if (!plaintext) throw new PixaiMcpOAuthStateCorruptError();
    try {
      const value: unknown = JSON.parse(plaintext);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PixaiMcpOAuthStateCorruptError();
      }
      return value as PixaiMcpOAuthState;
    } catch (error) {
      if (error instanceof PixaiMcpOAuthStateCorruptError) throw error;
      throw new PixaiMcpOAuthStateCorruptError();
    }
  }
}
