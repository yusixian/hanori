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
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  authorizationState?: string;
  discoveryState?: OAuthDiscoveryState;
}

/**
 * Persistence boundary for the single, instance-wide PixAI MCP owner grant.
 * Implementations must encrypt secrets at rest and apply each patch atomically.
 * A null value deletes that field.
 */
export interface PixaiMcpOAuthStore {
  read(): Promise<Readonly<PixaiMcpOAuthState> | undefined>;
  patch(update: { [K in keyof PixaiMcpOAuthState]?: PixaiMcpOAuthState[K] | null }): Promise<void>;
  consumeAuthorizationState(receivedState: string): Promise<boolean>;
}

export interface PixaiMcpOAuthProviderOptions {
  store: PixaiMcpOAuthStore;
  redirectUrl: string | URL;
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
  clientName?: string;
  clientUri?: string;
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

  private readonly store: PixaiMcpOAuthStore;
  private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;

  constructor(options: PixaiMcpOAuthProviderOptions) {
    this.store = options.store;
    this.redirectUrl = new URL(options.redirectUrl);
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: options.clientName ?? "COS Tool Bot",
      client_uri: options.clientUri,
      scope: PIXAI_MCP_OAUTH_SCOPES.join(" "),
    };
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
    const current = (await this.read()).tokens;
    await this.patch({
      tokens:
        tokens.refresh_token || !current?.refresh_token
          ? tokens
          : { ...tokens, refresh_token: current.refresh_token },
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const ownerAuthorizationUrl = new URL(authorizationUrl);
    const requestedScopes = new Set(
      (ownerAuthorizationUrl.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
    );
    for (const scope of PIXAI_MCP_OAUTH_SCOPES) requestedScopes.add(scope);
    ownerAuthorizationUrl.searchParams.set("scope", [...requestedScopes].join(" "));
    await this.onAuthorizationUrl(ownerAuthorizationUrl);
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
    const update: { [K in keyof PixaiMcpOAuthState]?: null } = {};
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
    try {
      return await this.store.consumeAuthorizationState(receivedState);
    } catch {
      throw new PixaiMcpOAuthPersistenceError();
    }
  }

  private async read(): Promise<Readonly<PixaiMcpOAuthState>> {
    try {
      return (await this.store.read()) ?? {};
    } catch {
      throw new PixaiMcpOAuthPersistenceError();
    }
  }

  private async patch(update: {
    [K in keyof PixaiMcpOAuthState]?: PixaiMcpOAuthState[K] | null;
  }): Promise<void> {
    try {
      await this.store.patch(update);
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
