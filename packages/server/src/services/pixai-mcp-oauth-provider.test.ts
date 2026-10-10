import { describe, expect, it, vi } from "vitest";
import {
  PIXAI_MCP_OAUTH_SCOPES,
  PixaiMcpOAuthPersistenceError,
  PixaiMcpOAuthProvider,
  type PixaiMcpOAuthState,
  type PixaiMcpOAuthStore,
} from "./pixai-mcp-oauth-provider.js";

function memoryStore(initial: PixaiMcpOAuthState = {}) {
  let state: PixaiMcpOAuthState = { endpoint: "https://mcp.example.com/mcp/pixai", ...initial };
  const store: PixaiMcpOAuthStore = {
    read: vi.fn(async () => state),
    patch: vi.fn(async (endpoint, update) => {
      if (!endpoint || state.endpoint !== endpoint) state = {};
      if (endpoint) state.endpoint = endpoint;
      for (const [key, value] of Object.entries(update)) {
        if (value === null) delete state[key as keyof PixaiMcpOAuthState];
        else Object.assign(state, { [key]: value });
      }
    }),
    consumeAuthorizationState: vi.fn(async (endpoint, receivedState) => {
      if (
        state.endpoint !== endpoint ||
        !state.authorizationState ||
        state.authorizationState !== receivedState
      )
        return false;
      delete state.authorizationState;
      return true;
    }),
  };
  return { store, current: () => state };
}

describe("PixaiMcpOAuthProvider", () => {
  it.each([undefined, "https://old.example.com/mcp/pixai", "https://mcp.example.com/mcp/other"])(
    "does not reuse unbound or foreign credentials (%s)",
    async (endpoint) => {
      const memory = memoryStore({
        endpoint,
        clientInformation: { client_id: "old-client" },
        tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
        codeVerifier: "old-verifier",
        authorizationState: "old-state",
        discoveryState: { authorizationServerUrl: "https://old-auth.example" },
      });
      const provider = new PixaiMcpOAuthProvider({
        endpoint: "https://mcp.example.com/mcp/pixai",
        store: memory.store,
        redirectUrl: "https://bot.example/callback",
        onAuthorizationUrl: vi.fn(),
      });
      expect(await provider.tokens()).toBeUndefined();
      expect(await provider.clientInformation()).toBeUndefined();
      expect(await provider.discoveryState()).toBeUndefined();
      await expect(provider.codeVerifier()).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
      expect(await provider.consumeAuthorizationState("old-state")).toBe(false);
      expect(memory.store.patch).not.toHaveBeenCalled();

      await provider.saveClientInformation({ client_id: "new-client" });
      expect(memory.current()).toEqual({
        endpoint: "https://mcp.example.com/mcp/pixai",
        clientInformation: { client_id: "new-client" },
      });
      await provider.saveTokens({ access_token: "new-access", token_type: "Bearer" });
      expect(await provider.tokens()).toEqual({ access_token: "new-access", token_type: "Bearer" });
    },
  );

  it("does not expose credentials while the endpoint is disabled", async () => {
    const memory = memoryStore({
      tokens: { access_token: "saved-access", token_type: "Bearer" },
    });
    const provider = new PixaiMcpOAuthProvider({
      endpoint: undefined,
      store: memory.store,
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl: vi.fn(),
    });
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.consumeAuthorizationState("saved-state")).toBe(false);
    expect(memory.store.consumeAuthorizationState).not.toHaveBeenCalled();
    await expect(
      provider.saveTokens({ access_token: "new", token_type: "Bearer" }),
    ).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
    expect(memory.current().tokens?.access_token).toBe("saved-access");
    await provider.invalidateCredentials("all");
    expect(memory.current()).toEqual({});
  });

  it("persists the full owner grant and consumes callback state once", async () => {
    const memory = memoryStore();
    const onAuthorizationUrl = vi.fn();
    const provider = new PixaiMcpOAuthProvider({
      endpoint: "https://mcp.example.com/mcp/pixai",
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
      endpoint: "https://mcp.example.com/mcp/pixai",
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
      endpoint: "https://mcp.example.com/mcp/pixai",
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
      endpoint: "https://mcp.example.com/mcp/pixai",
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
      endpoint: "https://mcp.example.com/mcp/pixai",
      store: {
        read: async () => {
          throw new Error("access-secret verifier-secret");
        },
        patch: async () => {
          throw new Error("patch-secret");
        },
        consumeAuthorizationState: async () => {
          throw new Error("state-secret");
        },
      },
      redirectUrl: "https://bot.example/callback",
      onAuthorizationUrl: vi.fn(),
    });

    await expect(provider.tokens()).rejects.toEqual(new PixaiMcpOAuthPersistenceError());
    await expect(provider.tokens()).rejects.not.toThrow(/secret/);
    await expect(provider.saveCodeVerifier("verifier")).rejects.toEqual(
      new PixaiMcpOAuthPersistenceError(),
    );
    await expect(provider.consumeAuthorizationState("state")).rejects.toEqual(
      new PixaiMcpOAuthPersistenceError(),
    );
  });
});

it("revokes a connection before late token persistence and old reads complete", async () => {
  const memory = memoryStore();
  const provider = new PixaiMcpOAuthProvider({
    endpoint: "https://mcp.example.com/mcp/pixai",
    store: memory.store,
    redirectUrl: "https://bot.example/callback",
    onAuthorizationUrl: vi.fn(),
  });
  const session = provider.forConnection();
  await session.revokeAndDrain();
  await expect(
    session.provider.saveTokens!({ access_token: "late", token_type: "Bearer" }),
  ).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
  expect(memory.current().tokens).toBeUndefined();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("rejects a stale read and never writes a refresh that was still reading at revoke", async () => {
  const memory = memoryStore();
  const read = deferred<PixaiMcpOAuthState>();
  const started = deferred<void>();
  vi.mocked(memory.store.read).mockImplementation(async () => {
    started.resolve();
    return read.promise;
  });
  const provider = new PixaiMcpOAuthProvider({
    endpoint: "https://mcp.example.com/mcp/pixai",
    store: memory.store,
    redirectUrl: "https://bot.example/callback",
    onAuthorizationUrl: vi.fn(),
  });
  const session = provider.forConnection();
  const saving = session.provider.saveTokens!({ access_token: "late", token_type: "Bearer" });
  const rejection = expect(saving).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
  await started.promise;
  const drained = session.revokeAndDrain();
  read.resolve({
    endpoint: "https://mcp.example.com/mcp/pixai",
    tokens: { access_token: "old", refresh_token: "refresh", token_type: "Bearer" },
  });
  await drained;
  await rejection;
  expect(memory.store.patch).not.toHaveBeenCalled();
});

it("drains an already started write before root invalidation and rejects queued session effects", async () => {
  const memory = memoryStore();
  const write = deferred<void>();
  const started = deferred<void>();
  const patch = memory.store.patch;
  vi.mocked(memory.store.patch).mockImplementationOnce(async (endpoint, update) => {
    started.resolve();
    await write.promise;
    await patch(endpoint, update);
  });
  const redirect = vi.fn();
  const provider = new PixaiMcpOAuthProvider({
    endpoint: "https://mcp.example.com/mcp/pixai",
    store: memory.store,
    redirectUrl: "https://bot.example/callback",
    onAuthorizationUrl: redirect,
  });
  const session = provider.forConnection();
  const saving = session.provider.saveCodeVerifier("late");
  const rejection = expect(saving).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
  await started.promise;
  let didDrain = false;
  const drained = session.revokeAndDrain().then(() => {
    didDrain = true;
  });
  const clearing = provider.invalidateCredentials("all");
  await Promise.resolve();
  expect(didDrain).toBe(false);
  write.resolve();
  await Promise.all([drained, clearing, rejection]);
  expect(memory.current().codeVerifier).toBeUndefined();
  await expect(
    session.provider.redirectToAuthorization(new URL("https://auth.example")),
  ).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
  expect(redirect).not.toHaveBeenCalled();
});

it("does not return credentials from a read that finishes after session revocation", async () => {
  const memory = memoryStore();
  const read = deferred<PixaiMcpOAuthState>();
  const started = deferred<void>();
  vi.mocked(memory.store.read).mockImplementation(async () => {
    started.resolve();
    return read.promise;
  });
  const root = new PixaiMcpOAuthProvider({
    endpoint: "https://mcp.example.com/mcp/pixai",
    store: memory.store,
    redirectUrl: "https://bot.example/callback",
    onAuthorizationUrl: vi.fn(),
  });
  const session = root.forConnection();
  const tokens = session.provider.tokens();
  const rejected = expect(tokens).rejects.toBeInstanceOf(PixaiMcpOAuthPersistenceError);
  await started.promise;
  const drained = session.revokeAndDrain();
  read.resolve({
    endpoint: "https://mcp.example.com/mcp/pixai",
    tokens: { access_token: "old", token_type: "Bearer" },
  });
  await Promise.all([drained, rejected]);
});
