import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GitHubWebhookRequest, GitHubWebhookResponse } from "../harness/webhook.js";

export interface HarnessWebhookHandler {
  handleGitHubWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse>;
}

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/** Public by design: GitHub authenticates with the HMAC signature, not a session. */
export function harnessRoutes(harness: HarnessWebhookHandler | undefined) {
  return new Hono().post(
    "/github/webhook",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (c) => c.json({ ok: false as const, error: "payload too large" }, 413),
    }),
    async (c) => {
      if (!harness) return c.json({ ok: false as const, error: "Not found" }, 404);
      const response = await harness.handleGitHubWebhook({
        event: c.req.header("x-github-event"),
        deliveryId: c.req.header("x-github-delivery"),
        signature: c.req.header("x-hub-signature-256"),
        body: await c.req.text(),
      });
      return c.json(response.body, response.status);
    },
  );
}
