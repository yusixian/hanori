import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { AiConfigStored, GitHubAppInstallationStored } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ownerOrAdmin, requireRoles, type AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import {
  GitHubAppFlowError,
  type GitHubAppCredentialService,
} from "../services/github-app-credentials.js";

function storedInstallation(config: AiConfigStored | null | undefined) {
  return config?.githubToolsConfig?.githubAppInstallation;
}

async function restartIfRunning(botPool: BotPool, botId: string): Promise<void> {
  if (!botPool.getManager(botId)) return;
  await botPool.restartBot(botId);
}

function publicFlowMessage(error: unknown, fallback: string): string {
  return error instanceof GitHubAppFlowError ? error.message : fallback;
}

function recordFlowError(stage: string, error: unknown, botId?: string): void {
  console.error(`GitHub App ${stage} failed`, { botId, error });
}

export function botGitHubAppRoutes(
  db: Database,
  service: GitHubAppCredentialService,
  botPool: BotPool,
  baseURL: string,
) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", requireRoles(ownerOrAdmin))
    .get("/:botId/github-app", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db
        .select({ aiConfig: bots.aiConfig })
        .from(bots)
        .where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      const config = bot.aiConfig?.githubToolsConfig;
      const installation = storedInstallation(bot.aiConfig);
      const connectionError =
        installation && service.available
          ? await service.getInstallationConnectionError(installation.installationId)
          : undefined;
      return c.json({
        ok: true as const,
        data: {
          available: service.available,
          configurationError: service.configurationError,
          connected: !!installation,
          connectionError,
          legacyPat: !!config?.encryptedToken,
          installation: installation
            ? {
                installationId: installation.installationId,
                accountLogin: installation.accountLogin,
                accountType: installation.accountType,
                repositorySelection: installation.repositorySelection,
                repositories: installation.repositories,
                permissions: installation.permissions,
              }
            : undefined,
        },
      });
    })
    .post("/:botId/github-app/authorize", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db
        .select({ aiConfig: bots.aiConfig })
        .from(bots)
        .where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      const refresh = c.req.query("refresh") === "1";
      const installation = storedInstallation(bot.aiConfig);
      if (refresh && !installation)
        return c.json({ ok: false as const, error: "GitHub App 未连接" }, 409);
      const userId = c.get("authUser").id;
      try {
        const url =
          refresh && installation
            ? service.createOAuthAuthorizationUrl(
                botId,
                userId,
                installation.installationId,
                new URL("/api/github-app/callback", baseURL).toString(),
                installation.connectedAt,
              )
            : service.createAuthorizationUrl(botId, userId);
        return c.json({ ok: true as const, data: { url, authorizationUrl: url } });
      } catch (error) {
        recordFlowError("authorize", error, botId);
        throw new HTTPException(503, {
          message: publicFlowMessage(error, "GitHub App 暂时不可用，请检查服务端日志"),
        });
      }
    })
    .delete("/:botId/github-app", async (c) => {
      const botId = c.req.param("botId");
      let disconnectedInstallationId: number | undefined;
      const updated = await botPool.withAiConfigLock(botId, async () => {
        const [bot] = await db
          .select({ aiConfig: bots.aiConfig })
          .from(bots)
          .where(eq(bots.id, botId));
        if (!bot) return false;
        const github = bot.aiConfig?.githubToolsConfig;
        if (!bot.aiConfig || !github?.githubAppInstallation) return true;
        disconnectedInstallationId = github.githubAppInstallation.installationId;
        const { githubAppInstallation: _removed, ...remainingGitHub } = github;
        await db
          .update(bots)
          .set({ aiConfig: { ...bot.aiConfig, githubToolsConfig: remainingGitHub } })
          .where(eq(bots.id, botId));
        return true;
      });
      if (!updated) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      if (disconnectedInstallationId !== undefined) {
        service.clearInstallationToken(disconnectedInstallationId);
        await botPool.invalidateGitHubCredentials(botId);
        await restartIfRunning(botPool, botId);
      }
      return c.json({ ok: true as const });
    });
}

function panelRedirect(baseURL: string, botId?: string, params?: Record<string, string>): string {
  const url = new URL(botId ? `/bots/${encodeURIComponent(botId)}/ai` : "/", baseURL);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export function githubAppCallbackRoutes(
  db: Database,
  service: GitHubAppCredentialService,
  botPool: BotPool,
  baseURL: string,
) {
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", requireRoles(ownerOrAdmin))
    .get("/setup", async (c) => {
      let botId: string | undefined;
      try {
        const state = c.req.query("state");
        const rawInstallationId = c.req.query("installation_id");
        if (!state || !rawInstallationId) {
          throw new GitHubAppFlowError("GitHub installation 回调缺少 state 或 installation_id");
        }
        const payload = service.verifyState(state, c.get("authUser").id, "install");
        botId = payload.botId;
        const installationId = Number.parseInt(rawInstallationId, 10);
        if (!Number.isSafeInteger(installationId) || installationId <= 0) {
          throw new GitHubAppFlowError("GitHub installation_id 无效");
        }
        const callbackUrl = new URL("/api/github-app/callback", baseURL).toString();
        return c.redirect(
          service.createOAuthAuthorizationUrl(
            payload.botId,
            payload.userId,
            installationId,
            callbackUrl,
          ),
        );
      } catch (error) {
        recordFlowError("setup", error, botId);
        const message = publicFlowMessage(error, "GitHub App 安装失败，请重新尝试");
        return c.redirect(
          panelRedirect(baseURL, botId, {
            githubApp: "error",
            message: message.slice(0, 300),
          }),
        );
      }
    })
    .get("/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const oauthError = c.req.query("error_description") ?? c.req.query("error");
      let botId: string | undefined;
      try {
        if (!state) throw new GitHubAppFlowError("GitHub 回调缺少 state");
        const payload = service.verifyState(state, c.get("authUser").id, "oauth");
        botId = payload.botId;
        const codeVerifier = service.consumeOAuthCodeVerifier(state);
        if (oauthError) {
          throw new GitHubAppFlowError("GitHub 已取消或拒绝授权", {
            cause: new Error(oauthError),
          });
        }
        if (!code) throw new GitHubAppFlowError("GitHub 回调缺少 code");
        const [bot] = await db
          .select({ aiConfig: bots.aiConfig })
          .from(bots)
          .where(eq(bots.id, botId));
        if (!bot) throw new GitHubAppFlowError("Bot 不存在");
        if (!bot.aiConfig?.githubToolsConfig) {
          throw new GitHubAppFlowError("请先保存 GitHub 工具基础配置");
        }
        const installation = await service.exchangeAndVerifyInstallation(
          code,
          payload.installationId,
          storedInstallation(bot.aiConfig)?.installationId,
          new URL("/api/github-app/callback", baseURL).toString(),
          codeVerifier,
        );
        const stored: GitHubAppInstallationStored = {
          ...installation,
          connectedAt: new Date().toISOString(),
        };
        const saved = await botPool.withAiConfigLock(botId, async () => {
          const [latest] = await db
            .select({ aiConfig: bots.aiConfig })
            .from(bots)
            .where(eq(bots.id, botId!));
          if (!latest?.aiConfig?.githubToolsConfig) return false;
          const github = latest.aiConfig.githubToolsConfig;
          if (
            payload.refreshConnectedAt !== undefined &&
            (github.githubAppInstallation?.connectedAt !== payload.refreshConnectedAt ||
              github.githubAppInstallation?.installationId !== payload.installationId)
          ) {
            throw new GitHubAppFlowError("GitHub App 连接已变更，请返回面板重新同步");
          }
          const { encryptedToken: _legacyPat, ...withoutLegacyPat } = github;
          await db
            .update(bots)
            .set({
              aiConfig: {
                ...latest.aiConfig,
                githubToolsConfig: {
                  ...withoutLegacyPat,
                  login: installation.accountLogin,
                  repositories: [],
                  githubAppInstallation: stored,
                },
              },
            })
            .where(eq(bots.id, botId!));
          return true;
        });
        if (!saved) {
          throw new GitHubAppFlowError("GitHub 工具配置已不存在，请重新保存后授权");
        }
        service.clearInstallationToken(installation.installationId);
        await botPool.invalidateGitHubCredentials(botId);
        await restartIfRunning(botPool, botId);
        return c.redirect(panelRedirect(baseURL, botId, { githubApp: "connected" }));
      } catch (error) {
        recordFlowError("callback", error, botId);
        const message = publicFlowMessage(error, "GitHub App 授权失败，请检查服务端日志");
        return c.redirect(
          panelRedirect(baseURL, botId, { githubApp: "error", message: message.slice(0, 300) }),
        );
      }
    });
}
