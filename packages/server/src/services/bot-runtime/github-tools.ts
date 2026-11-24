import type { AiReplyBotConfig } from "@cos-tool-bot/bot";
import type { GitHubToolsRuntimeConfig } from "@cos-tool-bot/shared";
import type { AiConfigRuntime } from "../ai-config-runtime.js";
import type { DbLogger } from "../db-logger.js";
import type { BotRuntimeServices } from "./types.js";

export function resolveGitHubToolsConfig(
  botId: string,
  aiRuntime: AiConfigRuntime,
  dbLogger: DbLogger,
  services: Readonly<BotRuntimeServices>,
): GitHubToolsRuntimeConfig | undefined {
  const storedGitHubConfig = aiRuntime.config.githubToolsConfig;
  const installation = storedGitHubConfig?.githubAppInstallation;
  const legacyGitHubToken = aiRuntime.githubToken;
  const githubCredentialResolver =
    installation && services.githubAppCredentialService?.available
      ? () => services.githubAppCredentialService!.getInstallationToken(installation.installationId)
      : !installation && legacyGitHubToken
        ? async () => legacyGitHubToken
        : undefined;
  const githubToolsConfig = storedGitHubConfig
    ? {
        enabled: storedGitHubConfig.enabled,
        publicReadEnabled: storedGitHubConfig.publicReadEnabled,
        codingAgentEnabled: storedGitHubConfig.codingAgentEnabled ?? false,
        createIssueConfirmationTtlMinutes:
          storedGitHubConfig.createIssueConfirmationTtlMinutes ?? null,
        codingProviderId: storedGitHubConfig.codingProviderId,
        codingModelId: storedGitHubConfig.codingModelId,
        githubAppInstallation: installation,
        login: installation?.accountLogin ?? storedGitHubConfig.login,
        authorName: storedGitHubConfig.authorName,
        authorEmail: storedGitHubConfig.authorEmail,
        repositories: installation?.repositories ?? storedGitHubConfig.repositories,
        tokenProvider: githubCredentialResolver
          ? services.githubCredentialGenerations.capture(botId, githubCredentialResolver)
          : undefined,
      }
    : undefined;
  if (aiRuntime.githubTokenDecryptFailed) {
    dbLogger.warn(
      "GitHub credential cannot be decrypted; private repository and write access disabled.",
    );
  }
  return githubToolsConfig;
}

export function createGitHubCodeCallbacks(
  botId: string,
  githubToolsConfig: GitHubToolsRuntimeConfig | undefined,
  services: Readonly<BotRuntimeServices>,
): AiReplyBotConfig["githubCodeCallbacks"] {
  return githubToolsConfig?.codingAgentEnabled &&
    githubToolsConfig.tokenProvider &&
    services.gitWorkspaceService
    ? {
        runTask: async (input, model, signal) => {
          const token = await githubToolsConfig.tokenProvider!();
          if (!token) throw new Error("The bot's GitHub credential is not configured");
          return services.gitWorkspaceService!.runCodeTask(
            {
              ...input,
              botId,
              token,
              authorName: githubToolsConfig.authorName,
              authorEmail: githubToolsConfig.authorEmail,
              model,
            },
            signal,
          );
        },
        previewPush: async (repository, branch, signal) => {
          const token = await githubToolsConfig.tokenProvider!();
          if (!token) throw new Error("The bot's GitHub credential is not configured");
          return services.gitWorkspaceService!.previewPush(
            {
              botId,
              repository,
              branch,
              token,
            },
            signal,
          );
        },
        pushBranch: async (repository, branch, expectedCommitSha, signal) => {
          const token = await githubToolsConfig.tokenProvider!();
          if (!token) throw new Error("The bot's GitHub credential is not configured");
          return services.gitWorkspaceService!.pushBranch(
            {
              botId,
              repository,
              branch,
              token,
              expectedCommitSha,
            },
            signal,
          );
        },
        inspectWorkspace: (repository, signal) =>
          services.gitWorkspaceService!.inspectWorkspace({ botId, repository }, signal),
        resumeWorkspace: (input, model, expected, signal) =>
          services.gitWorkspaceService!.resumeWorkspace(
            {
              ...input,
              botId,
              authorName: githubToolsConfig.authorName,
              authorEmail: githubToolsConfig.authorEmail,
              model,
            },
            expected,
            signal,
          ),
        discardWorkspace: (repository, expected, signal) =>
          services.gitWorkspaceService!.discardWorkspace({ botId, repository }, expected, signal),
      }
    : undefined;
}
