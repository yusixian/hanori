import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import { GitHubAppCredentialService } from "../services/github-app-credentials.js";
import { botGitHubAppRoutes, githubAppCallbackRoutes } from "./github-app.js";

function editorContext() {
  return async (
    c: { set: (key: keyof AuthVariables, value: never) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authMember", {
      id: "member-1",
      userId: "user-1",
      organizationId: "org-1",
      role: "editor",
    } as never);
    await next();
  };
}

function ownerContext() {
  return async (
    c: { set: (key: keyof AuthVariables, value: never) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authMember", {
      id: "member-1",
      userId: "user-1",
      organizationId: "org-1",
      role: "owner",
    } as never);
    c.set("authUser", { id: "user-1" } as never);
    await next();
  };
}

describe("GitHub App route authorization", () => {
  const service = new GitHubAppCredentialService({ config: {}, stateSecret: "secret" });
  const db = {} as Database;
  const botPool = {} as BotPool;

  it.each([
    ["GET", "/api/bots/bot-1/github-app"],
    ["POST", "/api/bots/bot-1/github-app/authorize"],
    ["DELETE", "/api/bots/bot-1/github-app"],
  ])("rejects editor access to %s %s before touching storage", async (method, path) => {
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", editorContext())
      .route("/api/bots", botGitHubAppRoutes(db, service, botPool, "https://panel"));
    const response = await app.request(path, { method });
    expect(response.status).toBe(403);
  });

  it("rejects editor access to the OAuth callback", async () => {
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", editorContext())
      .route("/api/github-app", githubAppCallbackRoutes(db, service, botPool, "https://panel"));
    const response = await app.request("/api/github-app/callback?code=x&state=y");
    expect(response.status).toBe(403);
    const setupResponse = await app.request("/api/github-app/setup?installation_id=1&state=y");
    expect(setupResponse.status).toBe(403);
  });

  it("refreshes a connected installation through OAuth without another installation setup", async () => {
    const routeDb = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              aiConfig: {
                githubToolsConfig: {
                  githubAppInstallation: { installationId: 77, connectedAt: "previous" },
                },
              },
            },
          ],
        }),
      }),
    } as unknown as Database;
    const createOAuthAuthorizationUrl = vi
      .fn()
      .mockReturnValue("https://github.com/login/oauth/authorize");
    const routeService = {
      createOAuthAuthorizationUrl,
      createAuthorizationUrl: () => "https://github.com/apps/test/installations/new",
    } as unknown as GitHubAppCredentialService;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/bots",
        botGitHubAppRoutes(routeDb, routeService, botPool, "https://panel.example"),
      );
    const response = await app.request("/api/bots/bot-1/github-app/authorize?refresh=1", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { url: "https://github.com/login/oauth/authorize" },
    });
    expect(createOAuthAuthorizationUrl).toHaveBeenCalledWith(
      "bot-1",
      "user-1",
      77,
      "https://panel.example/api/github-app/callback",
      "previous",
    );
  });

  it("turns the signed installation setup callback into a bound OAuth redirect", async () => {
    const verifyState = vi.fn().mockReturnValue({ botId: "bot-1", userId: "user-1" });
    const createOAuthAuthorizationUrl = vi
      .fn()
      .mockReturnValue("https://github.com/login/oauth/authorize?state=oauth-state");
    const routeService = {
      verifyState,
      createOAuthAuthorizationUrl,
    } as unknown as GitHubAppCredentialService;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/github-app",
        githubAppCallbackRoutes(db, routeService, botPool, "https://panel.example"),
      );

    const response = await app.request(
      "/api/github-app/setup?installation_id=77&state=install-state",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=oauth-state",
    );
    expect(verifyState).toHaveBeenCalledWith("install-state", "user-1", "install");
    expect(createOAuthAuthorizationUrl).toHaveBeenCalledWith(
      "bot-1",
      "user-1",
      77,
      "https://panel.example/api/github-app/callback",
    );
  });

  it("clears the legacy repository list when saving an installation snapshot", async () => {
    const existingAiConfig = {
      enabled: false,
      encryptedApiKey: null,
      baseURL: "",
      model: "",
      systemPrompt: "",
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: [],
        randomReplyPercent: 0,
        randomReplyCooldown: 60,
      },
      groupOverrides: {},
      githubToolsConfig: {
        enabled: true,
        publicReadEnabled: false,
        codingAgentEnabled: true,
        encryptedToken: "legacy-encrypted-pat",
        login: "legacy-user",
        authorName: "Hanori",
        authorEmail: "ai@example.com",
        githubAppInstallation: {
          installationId: 77,
          connectedAt: "previous",
          repositorySelection: "selected",
          repositories: ["cosorg/a"],
        },
        repositories: ["cosorg/a", "outside/repo"],
      },
    };
    let storedAiConfig: unknown;
    const routeDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ aiConfig: existingAiConfig }],
        }),
      }),
      update: () => ({
        set: (value: { aiConfig: unknown }) => {
          storedAiConfig = value.aiConfig;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;
    const invalidateGitHubCredentials = vi.fn(() => {
      expect(storedAiConfig).toBeDefined();
    });
    const routeBotPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials,
      getManager: () => undefined,
    } as unknown as BotPool;
    const exchangeAndVerifyInstallation = vi.fn().mockResolvedValue({
      installationId: 77,
      accountLogin: "CosOrg",
      accountType: "Organization",
      repositorySelection: "all",
      repositories: ["cosorg/a", "cosorg/b"],
      permissions: { contents: "write" },
    });
    const routeService = {
      verifyState: vi.fn().mockReturnValue({
        botId: "bot-1",
        userId: "user-1",
        installationId: 77,
        refreshConnectedAt: "previous",
      }),
      clearInstallationToken: vi.fn(),
      consumeOAuthCodeVerifier: vi.fn().mockReturnValue("pkce-verifier"),
      exchangeAndVerifyInstallation,
    } as unknown as GitHubAppCredentialService;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/github-app",
        githubAppCallbackRoutes(routeDb, routeService, routeBotPool, "https://panel.example"),
      );

    const response = await app.request(
      "/api/github-app/callback?code=oauth-code&state=oauth-state",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://panel.example/bots/bot-1/ai?githubApp=connected",
    );
    expect(exchangeAndVerifyInstallation).toHaveBeenCalledWith(
      "oauth-code",
      77,
      77,
      "https://panel.example/api/github-app/callback",
      "pkce-verifier",
    );
    const github = (storedAiConfig as typeof existingAiConfig).githubToolsConfig as Record<
      string,
      unknown
    >;
    expect(github.encryptedToken).toBeUndefined();
    expect(github.repositories).toEqual([]);
    expect(github.githubAppInstallation).toMatchObject({
      installationId: 77,
      accountLogin: "CosOrg",
      permissions: { contents: "write" },
      repositorySelection: "all",
      repositories: ["cosorg/a", "cosorg/b"],
    });
    expect(JSON.stringify(storedAiConfig)).not.toContain("oauth-code");
    expect(JSON.stringify(storedAiConfig)).not.toContain("pkce-verifier");
    expect(invalidateGitHubCredentials).toHaveBeenCalledWith("bot-1");
  });

  it("discards a refresh if the bot disconnects while GitHub is returning the new scope", async () => {
    const githubToolsConfig = {
      githubAppInstallation: { installationId: 77, connectedAt: "previous" },
    };
    const where = vi
      .fn()
      .mockResolvedValueOnce([{ aiConfig: { githubToolsConfig } }])
      .mockResolvedValueOnce([{ aiConfig: { githubToolsConfig: {} } }]);
    const update = vi.fn();
    const routeDb = { select: () => ({ from: () => ({ where }) }), update } as unknown as Database;
    const routePool = {
      withAiConfigLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    } as unknown as BotPool;
    const routeService = {
      verifyState: () => ({ botId: "bot-1", installationId: 77, refreshConnectedAt: "previous" }),
      consumeOAuthCodeVerifier: () => "verifier",
      exchangeAndVerifyInstallation: async () => ({
        installationId: 77,
        repositories: ["cosorg/a", "cosorg/b"],
      }),
    } as unknown as GitHubAppCredentialService;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/github-app",
        githubAppCallbackRoutes(routeDb, routeService, routePool, "https://panel.example"),
      );
    const response = await app.request("/api/github-app/callback?code=code&state=state");
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("githubApp")).toBe("error");
    expect(location.searchParams.get("message")).toContain("连接已变更");
    expect(update).not.toHaveBeenCalled();
  });

  it("returns installation connection health in the owner-only status response", async () => {
    const getInstallationConnectionError = vi.fn().mockResolvedValue("installation 已被暂停");
    const routeService = {
      available: true,
      configurationError: undefined,
      getInstallationConnectionError,
    } as unknown as GitHubAppCredentialService;
    const routeDb = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              aiConfig: {
                githubToolsConfig: {
                  githubAppInstallation: {
                    installationId: 77,
                    accountLogin: "CosOrg",
                    accountType: "Organization",
                    repositorySelection: "selected",
                    repositories: [],
                    permissions: {},
                    connectedAt: "2026-07-21T00:00:00Z",
                  },
                },
              },
            },
          ],
        }),
      }),
    } as unknown as Database;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/bots",
        botGitHubAppRoutes(routeDb, routeService, {} as BotPool, "https://panel"),
      );

    const response = await app.request("/api/bots/bot-1/github-app");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { connected: true, connectionError: "installation 已被暂停" },
    });
    expect(getInstallationConnectionError).toHaveBeenCalledWith(77);
  });

  it("does not expose GitHub OAuth error details in the callback URL", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const routeService = {
      verifyState: vi.fn().mockReturnValue({
        botId: "bot-1",
        userId: "user-1",
        installationId: 77,
      }),
      clearInstallationToken: vi.fn(),
      consumeOAuthCodeVerifier: vi.fn().mockReturnValue("pkce-verifier"),
    } as unknown as GitHubAppCredentialService;
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/github-app",
        githubAppCallbackRoutes(
          {} as Database,
          routeService,
          {} as BotPool,
          "https://panel.example",
        ),
      );

    try {
      const response = await app.request(
        "/api/github-app/callback?state=oauth-state&error=access_denied&error_description=oauth-secret-detail",
      );
      const location = new URL(response.headers.get("location")!);
      expect(response.status).toBe(302);
      expect(location.searchParams.get("message")).toBe("GitHub 已取消或拒绝授权");
      expect(location.toString()).not.toContain("oauth-secret-detail");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("invalidates credentials before restart and surfaces restart failure as a generic callback error", async () => {
    const existingAiConfig = {
      githubToolsConfig: {
        enabled: true,
        publicReadEnabled: false,
        codingAgentEnabled: true,
        login: "legacy-user",
        authorName: "Hanori",
        authorEmail: "ai@example.com",
        repositories: ["cosorg/a"],
      },
    };
    let storedAiConfig: unknown;
    const routeDb = {
      select: () => ({
        from: () => ({ where: async () => [{ aiConfig: existingAiConfig }] }),
      }),
      update: () => ({
        set: (value: { aiConfig: unknown }) => {
          storedAiConfig = value.aiConfig;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;
    const invalidateGitHubCredentials = vi.fn();
    const restartBot = vi.fn().mockRejectedValue(new Error("restart-secret-detail"));
    const routeBotPool = {
      withAiConfigLock: async (_botId: string, operation: () => Promise<unknown>) => operation(),
      invalidateGitHubCredentials,
      getManager: () => ({}),
      restartBot,
    } as unknown as BotPool;
    const routeService = {
      verifyState: vi.fn().mockReturnValue({
        botId: "bot-1",
        userId: "user-1",
        installationId: 77,
      }),
      clearInstallationToken: vi.fn(),
      consumeOAuthCodeVerifier: vi.fn().mockReturnValue("pkce-verifier"),
      exchangeAndVerifyInstallation: vi.fn().mockResolvedValue({
        installationId: 77,
        accountLogin: "CosOrg",
        accountType: "Organization",
        repositorySelection: "selected",
        repositories: ["cosorg/a"],
        permissions: { contents: "write" },
      }),
    } as unknown as GitHubAppCredentialService;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono<{ Variables: AuthVariables }>()
      .use("*", ownerContext())
      .route(
        "/api/github-app",
        githubAppCallbackRoutes(routeDb, routeService, routeBotPool, "https://panel.example"),
      );

    try {
      const response = await app.request(
        "/api/github-app/callback?code=oauth-code&state=oauth-state",
      );
      const location = new URL(response.headers.get("location")!);
      expect(response.status).toBe(302);
      expect(storedAiConfig).toBeDefined();
      expect(location.searchParams.get("message")).toBe("GitHub App 授权失败，请检查服务端日志");
      expect(location.toString()).not.toContain("restart-secret-detail");
      expect(invalidateGitHubCredentials).toHaveBeenCalledWith("bot-1");
      expect(restartBot).toHaveBeenCalledWith("bot-1");
      expect(invalidateGitHubCredentials.mock.invocationCallOrder[0]).toBeLessThan(
        restartBot.mock.invocationCallOrder[0]!,
      );
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
