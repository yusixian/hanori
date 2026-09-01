import { describe, expect, it, vi } from "vitest";
import {
  PIXAI_MCP_OAUTH_SCOPES,
  PixaiMcpOAuthPersistenceError,
  PixaiMcpOAuthProvider,
  type PixaiMcpOAuthState,
  type PixaiMcpOAuthStore,
} from "./pixai-mcp-oauth-provider.js";

function memoryStore(initial: PixaiMcpOAuthState = {}) {
  let state = { ...initial };
  const store: PixaiMcpOAuthStore = {
    read: vi.fn(async () => state),
    patch: vi.fn(async (update) => {
      for (const [key, value] of Object.entries(update)) {
        if (value === null) delete state[key as keyof PixaiMcpOAuthState];
        else Object.assign(state, { [key]: value });
      }
    }),
    consumeAuthorizationState: vi.fn(async (receivedState) => {
      if (!state.authorizationState || state.authorizationState !== receivedState) return false;
      delete state.authorizationState;
      return true;
    }),
  };
  return { store, current: () => state };
}

describe("PixaiMcpOAuthProvider", () => {
  it("persists the full owner grant and consumes callback state once", async () => {
    const memory = memoryStore();
    const onAuthorizationUrl = vi.fn();
    const provider = new PixaiMcpOAuthProvider({
      store: memory.store,
      redirectUrl: "https://bot.example/oauth/pixai/callback",
      onAuthorizationUrl,
    });

    const state = await provider.state();
    await provider.saveCodeVerifier("verifier-secret");
    await provider.saveTokens({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
    });
    await provider.redirectToAuthorization(new URL("https://auth.example/authorize?secret=nope"));

    expect(provider.clientMetadata.scope).toBe(PIXAI_MCP_OAUTH_SCOPES.join(" "));
    expect(PIXAI_MCP_OAUTH_SCOPES).toEqual([
      "openid",
      "profile",
      "offline_access",
      "mcp:pixai:read",
      "mcp:pixai:generate",
      "mcp:pixai:cancel",
    ]);
    expect(await provider.codeVerifier()).toBe("verifier-secret");
    expect((await provider.tokens())?.access_token).toBe("access-secret");
    expect(onAuthorizationUrl).toHaveBeenCalledOnce();
    expect(await provider.consumeAuthorizationState("attacker-state")).toBe(false);
    expect(memory.current().authorizationState).toBe(state);
    expect(await provider.consumeAuthorizationState(state)).toBe(true);
    expect(await provider.consumeAuthorizationState(state)).toBe(false);
    expect(memory.current().authorizationState).toBeUndefined();
  });

  it("keeps the durable refresh token when a refresh response rotates only the access token", async () => {
    const memory = memoryStore({
      tokens: {
        access_token: "old-access",
        refresh_token: "durable-refresh",
        token_type: "Bearer",
      },
    });
    const provider = new PixaiMcpOAuthProvider({
      store: memory.store,
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl: vi.fn(),
    });

    await provider.saveTokens({ access_token: "new-access", token_type: "Bearer" });

    expect(await provider.tokens()).toMatchObject({
      access_token: "new-access",
      refresh_token: "durable-refresh",
    });
  });

  it("invalidates only the requested credential class", async () => {
    const memory = memoryStore({
      clientInformation: { client_id: "client" },
      tokens: { access_token: "access", token_type: "Bearer" },
      codeVerifier: "verifier",
      authorizationState: "state",
      discoveryState: { authorizationServerUrl: "https://auth.example" },
    });
    const provider = new PixaiMcpOAuthProvider({
      store: memory.store,
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl: vi.fn(),
    });

    await provider.invalidateCredentials("tokens");
    expect(memory.current().tokens).toBeUndefined();
    expect(memory.current().clientInformation).toBeDefined();
    expect(memory.current().codeVerifier).toBe("verifier");
  });

  it("requests the full owner grant while preserving authorization-server scopes", async () => {
    const onAuthorizationUrl = vi.fn();
    const provider = new PixaiMcpOAuthProvider({
      store: memoryStore().store,
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl,
    });

    await provider.redirectToAuthorization(
      new URL("https://auth.example/authorize?scope=openid%20mcp%3Apixai%3Aread"),
    );

    const authorizationUrl = onAuthorizationUrl.mock.calls[0]![0] as URL;
    const scopes = authorizationUrl.searchParams.get("scope")?.split(" ") ?? [];
    expect(new Set(scopes)).toEqual(new Set(PIXAI_MCP_OAUTH_SCOPES));
    expect(scopes).toHaveLength(PIXAI_MCP_OAUTH_SCOPES.length);
  });

  it("replaces secret-bearing storage errors with a fixed error", async () => {
    const provider = new PixaiMcpOAuthProvider({
      store: {
        read: async () => {
          throw new Error("access-secret verifier-secret");
        },
        patch: async () => {},
        consumeAuthorizationState: async () => {
          throw new Error("state-secret");
        },
      },
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl: vi.fn(),
    });

    await expect(provider.tokens()).rejects.toEqual(new PixaiMcpOAuthPersistenceError());
    await expect(provider.tokens()).rejects.not.toThrow(/secret/);
  });
});
