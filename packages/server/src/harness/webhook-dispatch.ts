import { handleIssueEvent } from "./bug.js";
import { handleIssueComment } from "./protocol.js";
import type { HarnessService } from "./service.js";
import {
  type GitHubWebhookRequest,
  type GitHubWebhookResponse,
  handleGitHubWebhook,
} from "./webhook.js";

export function dispatchWebhookEvent(
  service: HarnessService,
  event: string,
  payload: Record<string, unknown>,
  projectKey: string,
) {
  if (event === "issues") return handleIssueEvent(service.work, payload, projectKey);
  if (event === "issue_comment") return handleIssueComment(service.work, payload, projectKey);
  return service.prFlow.handleWebhookEvent(event, payload, projectKey);
}

export function dispatchGitHubWebhook(
  service: HarnessService,
  request: GitHubWebhookRequest,
): Promise<GitHubWebhookResponse> {
  if (!service.active) {
    return Promise.resolve({ status: 503, body: { ok: false, error: "harness not loaded" } });
  }
  return handleGitHubWebhook(
    {
      secret: service.readEnv(service.globalView().config.github.webhookSecretEnv),
      store: service.store,
      projectForRepo: (repo) => service.projectKeyForRepo(repo),
      rememberInstallation: (repo, id) => service.github?.rememberInstallation(repo, id),
      dispatch: (event, payload, key) => dispatchWebhookEvent(service, event, payload, key),
      onDispatchError: (error, event, key) =>
        service.logger.error(`Dev Harness ${event} for ${key} failed: ${(error as Error).message}`),
    },
    request,
  );
}
