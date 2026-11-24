import {
  createHash,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { GitHubApiError, type GitHubRequestInit, githubRequest } from "./github-api.js";

const GITHUB_WEB_ROOT = "https://github.com";
const STATE_TTL_MS = 10 * 60 * 1000;
const INSTALLATION_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const INSTALLATION_HEALTH_TTL_MS = 60 * 1000;
const MAX_PENDING_AUTH_STATES = 1_024;
const MAX_INSTALLATION_PAGES = 100;
const MAX_REPOSITORY_PAGES = 100;

export const GITHUB_APP_ENV_NAMES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
] as const;

export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
}

export interface GitHubAppInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  permissions: Record<string, string>;
}

interface InstallationResponse {
  id: number;
  app_id: number;
  account: { login: string; type: string } | null;
  repository_selection: "all" | "selected";
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}

interface UserInstallationsResponse {
  total_count: number;
  installations: InstallationResponse[];
}

interface RepositoriesResponse {
  total_count: number;
  repositories: Array<{ full_name: string }>;
}

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface StatePayload {
  v: 1;
  purpose: "install" | "oauth";
  botId: string;
  userId: string;
  exp: number;
  nonce: string;
  installationId?: number;
  refreshConnectedAt?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface PendingAuthState {
  expiresAt: number;
}

interface OAuthVerifier {
  value: string;
  expiresAt: number;
}

interface CachedInstallationHealth {
  connectionError?: string;
  expiresAt: number;
}

export class GitHubAppFlowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubAppFlowError";
  }
}

export interface GitHubAppServiceOptions {
  config: Partial<GitHubAppConfig>;
  stateSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function resolveGitHubAppConfig(values: Record<string, string | undefined>): {
  config?: GitHubAppConfig;
  available: boolean;
  configurationError?: string;
} {
  const raw = {
    appId: values.GITHUB_APP_ID?.trim(),
    clientId: values.GITHUB_APP_CLIENT_ID?.trim(),
    clientSecret: values.GITHUB_APP_CLIENT_SECRET?.trim(),
    privateKey: values.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim(),
    slug: values.GITHUB_APP_SLUG?.trim(),
  };
  const configuredCount = Object.values(raw).filter(Boolean).length;
  if (configuredCount === 0) return { available: false };

  const missing = GITHUB_APP_ENV_NAMES.filter((name) => !values[name]?.trim());
  if (missing.length > 0) {
    return {
      available: false,
      configurationError: `GitHub App 配置不完整，缺少环境变量：${missing.join(", ")}`,
    };
  }
  if (!/^[1-9]\d*$/.test(raw.appId!)) {
    return { available: false, configurationError: "GITHUB_APP_ID 必须是正整数" };
  }
  try {
    const key = createPrivateKey(raw.privateKey!);
    if (key.asymmetricKeyType !== "rsa") {
      return {
        available: false,
        configurationError: "GITHUB_APP_PRIVATE_KEY 必须是 RSA PEM 私钥",
      };
    }
  } catch {
    return {
      available: false,
      configurationError: "GITHUB_APP_PRIVATE_KEY 不是有效的 PEM 私钥",
    };
  }
  return { available: true, config: raw as GitHubAppConfig };
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export class GitHubAppCredentialService {
  readonly available: boolean;
  readonly configurationError?: string;
  private readonly config?: GitHubAppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokenCache = new Map<number, CachedToken>();
  private readonly tokenRequests = new Map<number, Promise<string>>();
  private readonly pendingStates = new Map<string, PendingAuthState>();
  private readonly oauthVerifiers = new Map<string, OAuthVerifier>();
  private readonly healthCache = new Map<number, CachedInstallationHealth>();
  private readonly healthRequests = new Map<number, Promise<string | undefined>>();

  constructor(private readonly options: GitHubAppServiceOptions) {
    const resolved = resolveGitHubAppConfig({
      GITHUB_APP_ID: options.config.appId,
      GITHUB_APP_CLIENT_ID: options.config.clientId,
      GITHUB_APP_CLIENT_SECRET: options.config.clientSecret,
      GITHUB_APP_PRIVATE_KEY: options.config.privateKey,
      GITHUB_APP_SLUG: options.config.slug,
    });
    this.available = resolved.available;
    this.configurationError = resolved.configurationError;
    this.config = resolved.config;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get slug(): string | null {
    return this.config?.slug ?? null;
  }

  createAuthorizationUrl(botId: string, userId: string): string {
    const config = this.requireConfig();
    const state = this.createState(botId, userId);
    return `${GITHUB_WEB_ROOT}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  createOAuthAuthorizationUrl(
    botId: string,
    userId: string,
    installationId: number,
    callbackUrl: string,
    refreshConnectedAt?: string,
  ): string {
    const config = this.requireConfig();
    this.pruneExpiredAuthState();
    if (this.oauthVerifiers.size >= MAX_PENDING_AUTH_STATES) {
      throw new GitHubAppFlowError("GitHub 授权请求过多，请稍后重试");
    }
    const state = this.createState(botId, userId, installationId, refreshConnectedAt);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.oauthVerifiers.set(state, { value: verifier, expiresAt: this.now() + STATE_TTL_MS });
    const url = new URL("/login/oauth/authorize", GITHUB_WEB_ROOT);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  consumeOAuthCodeVerifier(state: string): string {
    this.pruneExpiredAuthState();
    const verifier = this.oauthVerifiers.get(state);
    this.oauthVerifiers.delete(state);
    if (!verifier || verifier.expiresAt <= this.now()) {
      throw new GitHubAppFlowError("GitHub OAuth PKCE 状态已过期，请重新授权");
    }
    return verifier.value;
  }

  createState(
    botId: string,
    userId: string,
    installationId?: number,
    refreshConnectedAt?: string,
  ): string {
    this.requireConfig();
    this.pruneExpiredAuthState();
    if (this.pendingStates.size >= MAX_PENDING_AUTH_STATES) {
      throw new GitHubAppFlowError("GitHub 授权请求过多，请稍后重试");
    }
    const payload: StatePayload = {
      v: 1,
      purpose: installationId === undefined ? "install" : "oauth",
      botId,
      userId,
      exp: this.now() + STATE_TTL_MS,
      ...(refreshConnectedAt === undefined ? {} : { refreshConnectedAt }),
      nonce: randomBytes(16).toString("hex"),
      ...(installationId === undefined ? {} : { installationId }),
    };
    const encodedPayload = encode(JSON.stringify(payload));
    const signature = createHmac("sha256", this.options.stateSecret)
      .update(encodedPayload)
      .digest("base64url");
    this.pendingStates.set(signature, { expiresAt: payload.exp });
    return `${encodedPayload}.${signature}`;
  }

  verifyState(
    state: string,
    userId: string,
    expectedPurpose?: StatePayload["purpose"],
  ): StatePayload {
    this.requireConfig();
    const [encodedPayload, receivedSignature, extra] = state.split(".");
    if (
      !encodedPayload ||
      !receivedSignature ||
      extra ||
      !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
      !/^[A-Za-z0-9_-]+$/.test(receivedSignature)
    ) {
      throw new GitHubAppFlowError("GitHub 授权状态无效");
    }
    const expectedSignature = createHmac("sha256", this.options.stateSecret)
      .update(encodedPayload)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(receivedSignature, "base64url");
    } catch {
      throw new GitHubAppFlowError("GitHub 授权状态无效");
    }
    if (
      received.toString("base64url") !== receivedSignature ||
      Buffer.from(encodedPayload, "base64url").toString("base64url") !== encodedPayload
    ) {
      throw new GitHubAppFlowError("GitHub 授权状态无效");
    }
    if (
      received.length !== expectedSignature.length ||
      !timingSafeEqual(received, expectedSignature)
    ) {
      throw new GitHubAppFlowError("GitHub 授权状态签名无效");
    }
    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw new GitHubAppFlowError("GitHub 授权状态无效");
    }
    if (
      payload.v !== 1 ||
      (payload.purpose !== "install" && payload.purpose !== "oauth") ||
      typeof payload.botId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      (payload.installationId !== undefined && !Number.isSafeInteger(payload.installationId)) ||
      (payload.purpose === "oauth" && payload.installationId === undefined) ||
      (payload.purpose === "install" && payload.installationId !== undefined)
    ) {
      throw new GitHubAppFlowError("GitHub 授权状态无效");
    }
    if (payload.userId !== userId) {
      throw new GitHubAppFlowError("GitHub 授权与当前管理员不匹配");
    }
    if (expectedPurpose && payload.purpose !== expectedPurpose) {
      throw new GitHubAppFlowError("GitHub 授权状态阶段无效");
    }
    if (payload.exp <= this.now()) {
      throw new GitHubAppFlowError("GitHub 授权已过期，请重新发起授权");
    }
    this.pruneExpiredAuthState();
    if (!this.pendingStates.delete(receivedSignature)) {
      throw new GitHubAppFlowError("GitHub 授权状态已使用或不是由当前服务签发");
    }
    return payload;
  }

  async exchangeAndVerifyInstallation(
    code: string,
    requestedInstallationId?: number,
    currentInstallationId?: number,
    redirectUri?: string,
    codeVerifier?: string,
  ): Promise<GitHubAppInstallation> {
    const config = this.requireConfig();
    const response = await this.fetchImpl(`${GITHUB_WEB_ROOT}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const oauth = (await response.json()) as OAuthTokenResponse;
    if (!response.ok || !oauth.access_token) {
      const detail = oauth.error_description || oauth.error;
      throw new GitHubAppFlowError("GitHub OAuth 授权交换失败，请重新尝试", {
        cause: detail ? new Error(detail) : new Error(`GitHub OAuth HTTP ${response.status}`),
      });
    }

    const targetId = requestedInstallationId ?? currentInstallationId;
    const appInstallations = (await this.listUserInstallations(oauth.access_token)).filter(
      (installation) => String(installation.app_id) === config.appId,
    );
    const selected = targetId
      ? appInstallations.find((installation) => installation.id === targetId)
      : appInstallations.length === 1
        ? appInstallations[0]
        : undefined;
    if (!selected) {
      if (targetId) {
        throw new GitHubAppFlowError("当前 GitHub 用户无权访问所选 App installation");
      }
      if (appInstallations.length === 0)
        throw new GitHubAppFlowError("当前 GitHub 用户没有可用的 App installation");
      throw new GitHubAppFlowError(
        "检测到多个 GitHub App installation，请先断开旧连接后从目标账号重新授权",
      );
    }

    const authoritative = await this.request<InstallationResponse>(
      `/app/installations/${selected.id}`,
      this.createAppJwt(),
    );
    if (String(authoritative.app_id) !== config.appId || !authoritative.account) {
      throw new GitHubAppFlowError("GitHub installation 不属于当前配置的 GitHub App");
    }
    const repositories = await this.listUserInstallationRepositories(
      oauth.access_token,
      authoritative.id,
    );
    return {
      installationId: authoritative.id,
      accountLogin: authoritative.account.login,
      accountType: authoritative.account.type,
      repositorySelection: authoritative.repository_selection,
      repositories,
      permissions: authoritative.permissions ?? {},
    };
  }

  async getInstallationToken(installationId: number): Promise<string> {
    this.requireConfig();
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - INSTALLATION_TOKEN_REFRESH_SKEW_MS > this.now()) {
      return cached.token;
    }
    const inFlight = this.tokenRequests.get(installationId);
    if (inFlight) return inFlight;
    const request = this.refreshInstallationToken(installationId)
      .then((result) => {
        if (this.tokenRequests.get(installationId) === request) {
          this.tokenCache.set(installationId, result);
        }
        return result.token;
      })
      .finally(() => {
        if (this.tokenRequests.get(installationId) === request) {
          this.tokenRequests.delete(installationId);
        }
      });
    this.tokenRequests.set(installationId, request);
    return request;
  }

  clearInstallationToken(installationId: number): void {
    this.tokenCache.delete(installationId);
    this.healthCache.delete(installationId);
    this.tokenRequests.delete(installationId);
    this.healthRequests.delete(installationId);
  }

  async getInstallationConnectionError(installationId: number): Promise<string | undefined> {
    this.requireConfig();
    const cached = this.healthCache.get(installationId);
    if (cached && cached.expiresAt > this.now()) return cached.connectionError;
    const inFlight = this.healthRequests.get(installationId);
    if (inFlight) return inFlight;
    const request = this.refreshInstallationHealth(installationId)
      .then((result) => {
        if (this.healthRequests.get(installationId) === request) {
          this.healthCache.set(installationId, result);
        }
        return result.connectionError;
      })
      .finally(() => {
        if (this.healthRequests.get(installationId) === request) {
          this.healthRequests.delete(installationId);
        }
      });
    this.healthRequests.set(installationId, request);
    return request;
  }

  createAppJwt(): string {
    const config = this.requireConfig();
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = encode(
      JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: config.appId }),
    );
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
  }

  private async listUserInstallations(userToken: string): Promise<InstallationResponse[]> {
    const installations: InstallationResponse[] = [];
    let totalCount = 0;
    let complete = false;
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const pageQuery = page === 1 ? "" : `&page=${page}`;
      const result = await this.request<UserInstallationsResponse>(
        `/user/installations?per_page=100${pageQuery}`,
        userToken,
      );
      installations.push(...result.installations);
      totalCount = result.total_count;
      if (installations.length >= totalCount) {
        complete = true;
        break;
      }
      if (result.installations.length === 0) break;
    }
    if (!complete && installations.length < totalCount) {
      throw new GitHubAppFlowError(
        `GitHub App installation 超过 ${MAX_INSTALLATION_PAGES * 100} 个，无法安全完成授权`,
      );
    }
    return installations;
  }

  private async refreshInstallationToken(installationId: number): Promise<CachedToken> {
    const result = await this.request<InstallationTokenResponse>(
      `/app/installations/${installationId}/access_tokens`,
      this.createAppJwt(),
      {
        method: "POST",
        failureMessage: (status) => `GitHub installation token 获取失败 (${status})`,
      },
    );
    const expiresAt = Date.parse(result.expires_at);
    if (!result.token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub 返回了无效的 installation token");
    }
    return { token: result.token, expiresAt };
  }

  private async refreshInstallationHealth(
    installationId: number,
  ): Promise<CachedInstallationHealth> {
    let connectionError: string | undefined;
    try {
      const installation = await this.request<InstallationResponse>(
        `/app/installations/${installationId}`,
        this.createAppJwt(),
        { timeoutMs: 10_000 },
      );
      if (String(installation.app_id) !== this.requireConfig().appId) {
        connectionError = "GitHub App installation 不属于当前服务器配置";
      } else if (installation.suspended_at) {
        connectionError = "GitHub App installation 已被暂停";
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError)) {
        console.error("GitHub App installation health check failed", error);
      }
      connectionError =
        error instanceof GitHubApiError && error.kind === "not_found"
          ? "GitHub App installation 已被撤销或不存在"
          : "暂时无法验证 GitHub App installation 状态";
    }
    return {
      connectionError,
      expiresAt: this.now() + INSTALLATION_HEALTH_TTL_MS,
    };
  }

  private async listUserInstallationRepositories(
    userToken: string,
    installationId: number,
  ): Promise<string[]> {
    const repositories: string[] = [];
    let totalCount = 0;
    let complete = false;
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
      const result = await this.request<RepositoriesResponse>(
        `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        userToken,
      );
      repositories.push(
        ...result.repositories.map((repository) => repository.full_name.toLowerCase()),
      );
      totalCount = result.total_count;
      if (repositories.length >= totalCount) {
        complete = true;
        break;
      }
      if (result.repositories.length === 0) break;
    }
    if (!complete && repositories.length < totalCount) {
      throw new GitHubAppFlowError(
        `GitHub installation 仓库超过 ${MAX_REPOSITORY_PAGES * 100} 个，无法安全完成授权快照`,
      );
    }
    return [...new Set(repositories)].sort();
  }

  private request<T>(path: string, token: string, init: GitHubRequestInit = {}): Promise<T> {
    return githubRequest<T>(this.fetchImpl, path, token, {
      timeoutMs: 30_000,
      failureMessage: (status) => `GitHub API 请求失败 (${status})`,
      ...init,
    });
  }

  private requireConfig(): GitHubAppConfig {
    if (this.configurationError) throw new GitHubAppFlowError(this.configurationError);
    if (!this.config) throw new GitHubAppFlowError("GitHub App 未配置，请先设置服务器环境变量");
    return this.config;
  }

  private pruneExpiredAuthState(): void {
    const now = this.now();
    for (const [signature, state] of this.pendingStates) {
      if (state.expiresAt <= now) this.pendingStates.delete(signature);
    }
    for (const [state, verifier] of this.oauthVerifiers) {
      if (verifier.expiresAt <= now) this.oauthVerifiers.delete(state);
    }
  }
}
