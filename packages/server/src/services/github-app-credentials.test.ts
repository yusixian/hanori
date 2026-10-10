import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "./github-api.js";
import {
  GitHubAppCredentialService,
  resolveGitHubAppConfig,
  type GitHubAppConfig,
} from "./github-app-credentials.js";

let config: GitHubAppConfig;
let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  publicKey = pair.publicKey;
  config = {
    appId: "12345",
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    slug: "cos-tool-bot-test",
  };
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHubAppCredentialService configuration and state", () => {
  it("is unavailable when all variables are absent and reports partial configuration", () => {
    expect(resolveGitHubAppConfig({})).toEqual({ available: false });
    const partial = resolveGitHubAppConfig({ GITHUB_APP_ID: "123" });
    expect(partial.available).toBe(false);
    expect(partial.configurationError).toContain("GITHUB_APP_CLIENT_ID");
  });

  it("accepts a PEM private key whose newlines came from a .env literal", () => {
    const resolved = resolveGitHubAppConfig({
      GITHUB_APP_ID: config.appId,
      GITHUB_APP_CLIENT_ID: config.clientId,
      GITHUB_APP_CLIENT_SECRET: config.clientSecret,
      GITHUB_APP_PRIVATE_KEY: config.privateKey.replace(/\n/g, "\\n"),
      GITHUB_APP_SLUG: config.slug,
    });
    expect(resolved.available).toBe(true);
    expect(resolved.config?.privateKey).toContain("\n");
  });

  it("rejects a non-RSA PEM private key", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const resolved = resolveGitHubAppConfig({
      GITHUB_APP_ID: config.appId,
      GITHUB_APP_CLIENT_ID: config.clientId,
      GITHUB_APP_CLIENT_SECRET: config.clientSecret,
      GITHUB_APP_PRIVATE_KEY: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_SLUG: config.slug,
    });
    expect(resolved).toEqual({
      available: false,
      configurationError: "GITHUB_APP_PRIVATE_KEY 必须是 RSA PEM 私钥",
    });
  });

  it("binds signed state to the panel user and rejects tampering and replay", () => {
    const service = new GitHubAppCredentialService({ config, stateSecret: "state-secret" });
    const state = service.createState("bot-1", "user-1");
    expect(service.verifyState(state, "user-1").botId).toBe("bot-1");
    expect(() => service.verifyState(state, "user-1")).toThrow("已使用");

    const other = service.createState("bot-1", "user-1");
    expect(() => service.verifyState(other, "user-2")).toThrow("不匹配");
    const [payload, signature] = other.split(".") as [string, string];
    expect(() => service.verifyState(`${payload}.${signature}!`, "user-1")).toThrow("状态无效");
    expect(() => service.verifyState(`x${payload.slice(1)}.${signature}`, "user-1")).toThrow();
    expect(service.verifyState(other, "user-1").botId).toBe("bot-1");
  });

  it("rejects non-canonical base64url state without consuming the canonical state", () => {
    const service = new GitHubAppCredentialService({ config, stateSecret: "state-secret" });
    const state = service.createState("bot-1", "user-1");
    const [payload, signature] = state.split(".") as [string, string];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(signature.at(-1)!);
    expect(lastIndex & 0b11).toBe(0);
    const nonCanonicalSignature = `${signature.slice(0, -1)}${alphabet[lastIndex + 1]}`;
    expect(Buffer.from(nonCanonicalSignature, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );

    expect(() => service.verifyState(`${payload}.${nonCanonicalSignature}`, "user-1")).toThrow(
      "状态无效",
    );
    expect(service.verifyState(state, "user-1").botId).toBe("bot-1");
  });

  it("expires pending state and PKCE verifiers and bounds pending authorization state", () => {
    let now = 0;
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      now: () => now,
    });
    const oauthUrl = new URL(
      service.createOAuthAuthorizationUrl(
        "bot-oauth",
        "user-1",
        77,
        "https://panel.example/api/github-app/callback",
      ),
    );
    const oauthState = oauthUrl.searchParams.get("state")!;
    now = 10 * 60 * 1000;
    expect(() => service.consumeOAuthCodeVerifier(oauthState)).toThrow("PKCE 状态已过期");
    expect(() => service.verifyState(oauthState, "user-1")).toThrow("授权已过期");

    for (let index = 0; index < 1_024; index += 1) {
      service.createState(`bot-${index}`, "user-1");
    }
    expect(() => service.createState("bot-overflow", "user-1")).toThrow("授权请求过多");

    now += 10 * 60 * 1000;
    expect(() => service.createState("bot-after-expiry", "user-1")).not.toThrow();
  });

  it("binds the installation id into the second-stage OAuth state", () => {
    const service = new GitHubAppCredentialService({ config, stateSecret: "state-secret" });
    const url = new URL(
      service.createOAuthAuthorizationUrl(
        "bot-1",
        "user-1",
        77,
        "https://panel.example/api/github-app/callback",
      ),
    );
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://panel.example/api/github-app/callback",
    );
    const state = url.searchParams.get("state")!;
    expect(service.verifyState(state, "user-1").installationId).toBe(77);
    const verifier = service.consumeOAuthCodeVerifier(state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(url.toString()).not.toContain(verifier);
  });

  it("creates a short-lived RS256 app JWT", () => {
    const now = Date.parse("2026-07-21T00:00:00Z");
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      now: () => now,
    });
    const jwt = service.createAppJwt();
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({
      alg: "RS256",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: config.appId,
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("GitHubAppCredentialService authorization", () => {
  it("exchanges the user code, verifies installation ownership, and snapshots repositories", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "user-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 1,
          installations: [
            {
              id: 77,
              app_id: 12345,
              account: { login: "CosOrg", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 77,
          app_id: 12345,
          account: { login: "CosOrg", type: "Organization" },
          repository_selection: "selected",
          permissions: { contents: "write", issues: "write" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 2,
          repositories: [{ full_name: "CosOrg/A" }, { full_name: "CosOrg/B" }],
        }),
      );
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    await expect(service.exchangeAndVerifyInstallation("code", 77)).resolves.toEqual({
      installationId: 77,
      accountLogin: "CosOrg",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: ["cosorg/a", "cosorg/b"],
      permissions: { contents: "write", issues: "write" },
    });
    const oauthBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(oauthBody).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: "code",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100",
    );
    const authorizationUrl = service.createAuthorizationUrl("bot-1", "user-1");
    expect(authorizationUrl).not.toContain(config.clientSecret);
    expect(authorizationUrl).not.toContain("user-token");
  });

  it("rejects an installation that is not accessible to the authorizing user", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "user-token" }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 0, installations: [] }));
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });
    await expect(service.exchangeAndVerifyInstallation("code", 999)).rejects.toThrow("无权访问");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("finds the selected installation beyond the first user installation page", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "user-token" });
      }
      if (url.endsWith("/user/installations?per_page=100")) {
        return jsonResponse({
          total_count: 2,
          installations: [
            {
              id: 1,
              app_id: 12345,
              account: { login: "FirstOrg", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        });
      }
      if (url.endsWith("/user/installations?per_page=100&page=2")) {
        return jsonResponse({
          total_count: 2,
          installations: [
            {
              id: 77,
              app_id: 12345,
              account: { login: "CosOrg", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        });
      }
      if (url.endsWith("/app/installations/77")) {
        return jsonResponse({
          id: 77,
          app_id: 12345,
          account: { login: "CosOrg", type: "Organization" },
          repository_selection: "selected",
        });
      }
      if (url.includes("/user/installations/77/repositories")) {
        return jsonResponse({ total_count: 0, repositories: [] });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    });
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    await expect(service.exchangeAndVerifyInstallation("code", 77)).resolves.toMatchObject({
      installationId: 77,
      accountLogin: "CosOrg",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2",
    );
  });

  it("fails closed when the repository page cap is reached before the snapshot is complete", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "user-token" });
      }
      if (url.endsWith("/user/installations?per_page=100")) {
        return jsonResponse({
          total_count: 1,
          installations: [
            {
              id: 77,
              app_id: 12345,
              account: { login: "CosOrg", type: "Organization" },
              repository_selection: "selected",
            },
          ],
        });
      }
      if (url.endsWith("/app/installations/77")) {
        return jsonResponse({
          id: 77,
          app_id: 12345,
          account: { login: "CosOrg", type: "Organization" },
          repository_selection: "selected",
        });
      }
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse({
        total_count: 101,
        repositories: [{ full_name: `CosOrg/repo-${page}` }],
      });
    });
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    await expect(service.exchangeAndVerifyInstallation("code", 77)).rejects.toThrow(
      "无法安全完成授权快照",
    );
    expect(fetchMock).toHaveBeenCalledTimes(103);
  });

  it("keeps its own failure text on a GitHub API error while classifying the answer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "user-token" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Server Error" }, 500));
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    const error = await service.exchangeAndVerifyInstallation("code", 77).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      message: "GitHub API 请求失败 (500)",
      status: 500,
      kind: "other",
    });
  });
});

describe("GitHubAppCredentialService installation token cache", () => {
  it("coalesces requests and refreshes before the one-hour token expires", async () => {
    let now = Date.parse("2026-07-21T00:00:00Z");
    let serial = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      serial += 1;
      return jsonResponse({
        token: `installation-token-${serial}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      });
    });
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
      now: () => now,
    });

    await expect(
      Promise.all([service.getInstallationToken(77), service.getInstallationToken(77)]),
    ).resolves.toEqual(["installation-token-1", "installation-token-1"]);
    await expect(service.getInstallationToken(77)).resolves.toBe("installation-token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 56 * 60 * 1000;
    await expect(service.getInstallationToken(77)).resolves.toBe("installation-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["token", "old-first"],
    ["token", "new-first"],
    ["health", "old-first"],
    ["health", "new-first"],
  ] as const)("isolates %s refreshes across invalidation (%s)", async (kind, order) => {
    const now = Date.parse("2026-07-21T00:00:00Z");
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
      now: () => now,
    });
    const get = () =>
      kind === "token"
        ? service.getInstallationToken(77)
        : service.getInstallationConnectionError(77);
    const answer = (index: number) =>
      jsonResponse(
        kind === "token"
          ? {
              token: `token-${index}`,
              expires_at: new Date(now + 3600000).toISOString(),
            }
          : { app_id: 12345, suspended_at: index === 0 ? "2026-07-21T00:00:00Z" : null },
      );
    const currentValue = kind === "token" ? "token-1" : undefined;
    const old = get();
    service.clearInstallationToken(77);
    const current = get();
    try {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (order === "old-first") {
        pending[0]!(answer(0));
        await old;
        const joined = get();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        pending[1]!(answer(1));
        await expect(joined).resolves.toBe(currentValue);
      } else {
        pending[1]!(answer(1));
        await expect(current).resolves.toBe(currentValue);
        pending[0]!(answer(0));
        await old;
      }
      await expect(current).resolves.toBe(currentValue);
      await expect(get()).resolves.toBe(currentValue);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      pending.forEach((resolve, index) => resolve(answer(index)));
      await Promise.allSettled([old, current]);
    }
  });

  it("caches suspended and revoked installation health without rewriting metadata", async () => {
    let now = Date.parse("2026-07-21T00:00:00Z");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 77,
          app_id: 12345,
          account: { login: "CosOrg", type: "Organization" },
          repository_selection: "selected",
          suspended_at: "2026-07-21T00:00:00Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404));
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
      now: () => now,
    });

    await expect(service.getInstallationConnectionError(77)).resolves.toContain("已被暂停");
    await expect(service.getInstallationConnectionError(77)).resolves.toContain("已被暂停");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 60 * 1000;
    await expect(service.getInstallationConnectionError(77)).resolves.toContain("已被撤销");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names an installation token failure and marks a rate limit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "API rate limit exceeded for installation" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    const error = await service.getInstallationToken(77).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: "GitHub installation token 获取失败 (403)",
      status: 403,
      kind: "rate_limited",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(init?.method).toBe("POST");
  });

  it("reports unverifiable health for any answer other than a missing installation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "x" }, 500));
    const service = new GitHubAppCredentialService({
      config,
      stateSecret: "state-secret",
      fetch: fetchMock,
    });

    await expect(service.getInstallationConnectionError(77)).resolves.toBe(
      "暂时无法验证 GitHub App installation 状态",
    );
  });
});
