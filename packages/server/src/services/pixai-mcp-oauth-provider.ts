import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const PIXAI_MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "mcp:pixai:read",
  "mcp:pixai:generate",
  "mcp:pixai:cancel",
] as const;

export interface PixaiMcpOAuthState {
  endpoint?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  authorizationState?: string;
  discoveryState?: OAuthDiscoveryState;
}

export type PixaiMcpOAuthUpdate = {
  [K in Exclude<keyof PixaiMcpOAuthState, "endpoint">]?: PixaiMcpOAuthState[K] | null;
};

/**
 * Persistence boundary for the single, instance-wide PixAI MCP owner grant.
 * Encrypt secrets at rest. Check the endpoint and reset a foreign grant in the
 * same transaction as each patch; callback consumption must check it atomically too.
 * A null value deletes that field; an undefined endpoint clears disabled grants.
 */
export interface PixaiMcpOAuthStore {
  read(): Promise<Readonly<PixaiMcpOAuthState> | undefined>;
  patch(endpoint: string | undefined, update: PixaiMcpOAuthUpdate): Promise<void>;
  consumeAuthorizationState(endpoint: string, receivedState: string): Promise<boolean>;
}

export interface PixaiMcpOAuthProviderOptions {
  endpoint: string | URL | undefined;
  store: PixaiMcpOAuthStore;
  redirectUrl: string | URL;
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
  clientName?: string;
  clientUri?: string;
  scopes?: readonly string[];
}

export interface PixaiMcpAuthSession {
  provider: OAuthClientProvider;
  revokeAndDrain(): Promise<void>;
}

export class PixaiMcpOAuthPersistenceError extends Error {
  constructor() {
    super("PixAI MCP OAuth persistence failed");
    this.name = "PixaiMcpOAuthPersistenceError";
  }
}

/** OAuthClientProvider backed by a durable store; it never includes credentials in errors. */
export class PixaiMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;

  private readonly scopes: readonly string[];
  private readonly store: PixaiMcpOAuthStore;
  private readonly endpoint: string | undefined;
  private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;

  // Root cleanup and connection grants share this queue; network requests never enter it.
  private queue = { tail: Promise.resolve() };
  private revoked = false;

  constructor(private readonly options: PixaiMcpOAuthProviderOptions) {
    this.store = options.store;
    this.scopes = options.scopes ?? PIXAI_MCP_OAUTH_SCOPES;
    this.endpoint = options.endpoint ? new URL(options.endpoint).href : undefined;
    this.redirectUrl = new URL(options.redirectUrl);
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: options.clientName ?? "Hanori",
      client_uri: options.clientUri,
      scope: this.scopes.join(" "),
    };
  }

  forConnection(): PixaiMcpAuthSession {
    const provider = new PixaiMcpOAuthProvider(this.options);
    provider.queue = this.queue;
    return {
      provider,
      revokeAndDrain: () => {
        provider.revoked = true;
        return provider.queue.tail;
      },
    };
  }

  private assertActive(): void {
    if (this.revoked) throw new PixaiMcpOAuthPersistenceError();
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.tail.then(async () => {
      this.assertActive();
      const value = await operation();
      this.assertActive();
      return value;
    });
    this.queue.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async state(): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    await this.patch({ authorizationState: value });
    return value;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.read()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.patch({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.run(async () => {
      const current = (await this.readUnqueued()).tokens;
      await this.patchUnqueued({
        tokens:
          tokens.refresh_token || !current?.refresh_token
            ? tokens
            : { ...tokens, refresh_token: current.refresh_token },
      });
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const ownerAuthorizationUrl = new URL(authorizationUrl);
    const requestedScopes = new Set(
      (ownerAuthorizationUrl.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
    );
    for (const scope of this.scopes) requestedScopes.add(scope);
    ownerAuthorizationUrl.searchParams.set("scope", [...requestedScopes].join(" "));
    await this.run(async () => {
      await this.onAuthorizationUrl(ownerAuthorizationUrl);
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.patch({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.read()).codeVerifier;
    if (!verifier) throw new PixaiMcpOAuthPersistenceError();
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.patch({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const update: PixaiMcpOAuthUpdate = {};
    if (scope === "all" || scope === "client") update.clientInformation = null;
    if (scope === "all" || scope === "tokens") update.tokens = null;
    if (scope === "all" || scope === "verifier") {
      update.codeVerifier = null;
      update.authorizationState = null;
    }
    if (scope === "all" || scope === "discovery") update.discoveryState = null;
    await this.patch(update);
  }

  /** Validate the OAuth callback state once, then invalidate it to prevent replay. */
  async consumeAuthorizationState(receivedState: string): Promise<boolean> {
    return this.run(async () => {
      try {
        if (!this.endpoint) return false;
        return await this.store.consumeAuthorizationState(this.endpoint, receivedState);
      } catch {
        throw new PixaiMcpOAuthPersistenceError();
      }
    });
  }

  private read(): Promise<Readonly<PixaiMcpOAuthState>> {
    return this.run(() => this.readUnqueued());
  }

  private async readUnqueued(): Promise<Readonly<PixaiMcpOAuthState>> {
    try {
      this.assertActive();
      const state = (await this.store.read()) ?? {};
      this.assertActive();
      // Legacy grants and grants for another endpoint require owner reauthorization.
      return this.endpoint && state.endpoint === this.endpoint ? state : {};
    } catch {
      throw new PixaiMcpOAuthPersistenceError();
    }
  }

  private patch(update: PixaiMcpOAuthUpdate): Promise<void> {
    return this.run(() => this.patchUnqueued(update));
  }

  private async patchUnqueued(update: PixaiMcpOAuthUpdate): Promise<void> {
    try {
      if (!this.endpoint && Object.values(update).some((value) => value !== null)) {
        throw new PixaiMcpOAuthPersistenceError();
      }
      this.assertActive();
      await this.store.patch(this.endpoint, update);
      this.assertActive();
    } catch {
      throw new PixaiMcpOAuthPersistenceError();
    }
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
