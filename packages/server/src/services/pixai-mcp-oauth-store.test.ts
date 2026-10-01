import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { PixaiMcpOAuthProvider, type PixaiMcpOAuthState } from "./pixai-mcp-oauth-provider.js";
import { PixaiMcpOAuthDbStore } from "./pixai-mcp-oauth-store.js";

const KEY = "test-encryption-key";
const ENDPOINT_A = "https://mcp.example.com/mcp/pixai";
const ENDPOINT_B = "https://other.example.com/mcp/pixai";

function database(initial: PixaiMcpOAuthState) {
  let encryptedState: string | null = encrypt(JSON.stringify(initial), KEY);
  let pause: { entered: () => void; wait: Promise<void> } | undefined;
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ encryptedState }] }),
    }),
  });
  const write = vi.fn(async ({ set }: { set: { encryptedState: string | null } }) => {
    encryptedState = set.encryptedState;
  });
  const db = {
    select,
    transaction: vi.fn(async <T>(operation: (tx: ReturnType<typeof transaction>) => Promise<T>) => {
      const pending = pause;
      pause = undefined;
      if (pending) {
        pending.entered();
        await pending.wait;
      }
      return operation(transaction());
    }),
  };

  function transaction() {
    let locked = false;
    return {
      execute: async (statement: SQL) => {
        expect(new PgDialect().sqlToQuery(statement).sql).toBe(
          "select pg_advisory_xact_lock(hashtext('pixai-mcp-oauth'))",
        );
        locked = true;
      },
      select: () => {
        expect(locked).toBe(true);
        return select();
      },
      insert: () => ({ values: () => ({ onConflictDoUpdate: write }) }),
    };
  }

  return {
    store: new PixaiMcpOAuthDbStore(db as unknown as Database, KEY),
    write,
    encryptedState: () => encryptedState,
    pauseNextTransaction: () => {
      let markEntered!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        resume = resolve;
      });
      pause = { entered: markEntered, wait };
      return { entered, resume };
    },
  };
}

function provider(store: PixaiMcpOAuthDbStore, endpoint: string) {
  return new PixaiMcpOAuthProvider({
    endpoint,
    store,
    redirectUrl: "https://bot.example.com/callback",
    onAuthorizationUrl: vi.fn(),
  });
}

describe("PixaiMcpOAuthDbStore endpoint isolation", () => {
  it("resets a foreign grant atomically when an old endpoint writes after a new grant", async () => {
    const fixture = database({
      endpoint: ENDPOINT_A,
      tokens: { access_token: "old-access", token_type: "Bearer" },
    });
    const oldProvider = provider(fixture.store, ENDPOINT_A);
    const newProvider = provider(fixture.store, ENDPOINT_B);
    const blocked = fixture.pauseNextTransaction();
    const lateWrite = oldProvider.saveDiscoveryState({
      authorizationServerUrl: "https://old.example",
    });
    await blocked.entered;

    await newProvider.saveClientInformation({ client_id: "new-client" });
    await newProvider.saveTokens({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
    });
    await newProvider.saveCodeVerifier("new-verifier");
    await newProvider.state();
    expect((await newProvider.tokens())?.access_token).toBe("new-access");
    expect(fixture.encryptedState()).not.toContain("new-access");

    blocked.resume();
    await lateWrite;

    expect(await oldProvider.tokens()).toBeUndefined();
    expect(await oldProvider.clientInformation()).toBeUndefined();
    expect(await newProvider.tokens()).toBeUndefined();
    expect(await fixture.store.read()).toEqual({
      endpoint: ENDPOINT_A,
      discoveryState: { authorizationServerUrl: "https://old.example" },
    });
  });

  it.each([ENDPOINT_B, "https://mcp.example.com/mcp/another", undefined])(
    "does not consume a callback belonging to endpoint %s",
    async (endpoint) => {
      const fixture = database({ endpoint, authorizationState: "pending-state" });
      const ciphertext = fixture.encryptedState();

      expect(await fixture.store.consumeAuthorizationState(ENDPOINT_A, "pending-state")).toBe(
        false,
      );
      expect(fixture.encryptedState()).toBe(ciphertext);
      expect(fixture.write).not.toHaveBeenCalled();
    },
  );

  it("checks callback ownership after obtaining the transaction lock", async () => {
    const fixture = database({ endpoint: ENDPOINT_A, authorizationState: "pending-state" });
    const blocked = fixture.pauseNextTransaction();
    const lateCallback = provider(fixture.store, ENDPOINT_A).consumeAuthorizationState(
      "pending-state",
    );
    await blocked.entered;
    await fixture.store.patch(ENDPOINT_B, { authorizationState: "pending-state" });

    blocked.resume();
    expect(await lateCallback).toBe(false);
    expect((await fixture.store.read())?.authorizationState).toBe("pending-state");
    expect(await fixture.store.consumeAuthorizationState(ENDPOINT_B, "pending-state")).toBe(true);
    expect(await fixture.store.consumeAuthorizationState(ENDPOINT_B, "pending-state")).toBe(false);
  });

  it("preserves the refresh token for an update to the same endpoint", async () => {
    const fixture = database({
      endpoint: ENDPOINT_A,
      clientInformation: { client_id: "existing-client" },
      tokens: {
        access_token: "old-access",
        refresh_token: "durable-refresh",
        token_type: "Bearer",
      },
    });
    const oauth = provider(fixture.store, ENDPOINT_A);
    await oauth.saveTokens({ access_token: "new-access", token_type: "Bearer" });
    expect(await oauth.tokens()).toEqual({
      access_token: "new-access",
      refresh_token: "durable-refresh",
      token_type: "Bearer",
    });
    expect(await oauth.clientInformation()).toEqual({ client_id: "existing-client" });
  });
});
