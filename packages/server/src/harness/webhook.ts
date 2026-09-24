import { createHmac, timingSafeEqual } from "node:crypto";
import type { HarnessStore } from "./store.js";

export function signGitHubPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function verifyGitHubSignature(
  secret: string,
  body: string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(signGitHubPayload(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface GitHubWebhookRequest {
  event: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  body: string;
}

export interface GitHubWebhookResponse {
  status: 200 | 202 | 400 | 401 | 503;
  body: { ok: boolean; result?: string; error?: string };
}

export interface GitHubWebhookDeps {
  secret: string | undefined;
  store: Pick<HarnessStore, "recordDelivery" | "releaseDelivery">;
  projectForRepo(repo: string): string | undefined;
  rememberInstallation(repo: string, installationId: number): void;
  dispatch(event: string, payload: Record<string, unknown>, projectKey: string): Promise<void>;
  onDispatchError(error: unknown, event: string, projectKey: string): void;
}

function summarize(event: string, payload: Record<string, unknown>) {
  const pr = payload.pull_request as { number?: number; head?: { sha?: string } } | undefined;
  return {
    event,
    action: typeof payload.action === "string" ? payload.action : null,
    number: pr?.number ?? null,
    sha: pr?.head?.sha ?? (typeof payload.sha === "string" ? payload.sha : null),
  };
}

/**
 * Fails closed without a secret, verifies the HMAC over the raw body, and records the delivery id
 * before dispatching so a redelivery is acknowledged without being processed twice.
 */
export async function handleGitHubWebhook(
  deps: GitHubWebhookDeps,
  request: GitHubWebhookRequest,
): Promise<GitHubWebhookResponse> {
  if (!deps.secret)
    return { status: 503, body: { ok: false, error: "webhook secret not configured" } };
  if (!verifyGitHubSignature(deps.secret, request.body, request.signature)) {
    return { status: 401, body: { ok: false, error: "invalid signature" } };
  }
  if (!request.event || !request.deliveryId) {
    return { status: 400, body: { ok: false, error: "missing GitHub headers" } };
  }
  if (request.event === "ping") return { status: 200, body: { ok: true, result: "pong" } };
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.body);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON" } };
  }
  const repository = payload.repository as { full_name?: unknown } | undefined;
  const repo = typeof repository?.full_name === "string" ? repository.full_name : undefined;
  const projectKey = repo ? deps.projectForRepo(repo) : undefined;
  if (!repo || !projectKey) return { status: 202, body: { ok: true, result: "ignored" } };

  const fresh = await deps.store.recordDelivery(request.deliveryId, {
    type: `github.${request.event}`,
    projectKey,
    payload: summarize(request.event, payload),
  });
  if (!fresh) return { status: 200, body: { ok: true, result: "duplicate" } };

  const installation = payload.installation as { id?: unknown } | undefined;
  if (typeof installation?.id === "number") deps.rememberInstallation(repo, installation.id);
  const event = request.event;
  const deliveryId = request.deliveryId;
  void deps.dispatch(event, payload, projectKey).catch(async (error) => {
    deps.onDispatchError(error, event, projectKey);
    await deps.store
      .releaseDelivery(deliveryId, error instanceof Error ? error.message.slice(0, 200) : "error")
      .catch((releaseError) => deps.onDispatchError(releaseError, event, projectKey));
  });
  return { status: 202, body: { ok: true, result: "accepted" } };
}
