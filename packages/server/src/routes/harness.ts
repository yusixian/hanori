import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AttachmentImage } from "../harness/attachments.js";
import type { GitHubWebhookRequest, GitHubWebhookResponse } from "../harness/webhook.js";

export interface HarnessWebhookHandler {
  handleGitHubWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse>;
  attachments: { read(token: string): Promise<AttachmentImage | null> };
}

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/**
 * Public by design: GitHub authenticates webhooks with the HMAC signature, and screenshot links
 * carry their own signature so GitHub's image proxy and the executor can fetch them.
 */
export function harnessRoutes(harness: HarnessWebhookHandler | undefined) {
  return new Hono()
    .get("/attachments/:token", async (c) => {
      const image = harness
        ? await harness.attachments.read(c.req.param("token")).catch(() => null)
        : null;
      if (!image) return c.json({ ok: false as const, error: "Not found" }, 404);
      return c.body(new Uint8Array(image.bytes), 200, {
        "Content-Type": image.mimeType,
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=86400, immutable",
      });
    })
    .post(
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
