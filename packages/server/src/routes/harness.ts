import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AttachmentImage } from "../harness/attachments.js";
import type { LodyTurnRequest, LodyTurnResponse } from "../harness/turn-callback.js";
import type { GitHubWebhookRequest, GitHubWebhookResponse } from "../harness/webhook.js";

export interface HarnessWebhookHandler {
  handleGitHubWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse>;
  handleLodyTurn(request: LodyTurnRequest): LodyTurnResponse;
  attachments: { read(token: string): Promise<AttachmentImage | null> };
}

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;
const MAX_TURN_BYTES = 16 * 1024;

/**
 * Public by design: GitHub authenticates webhooks with the HMAC signature, the lody-bridge signs
 * turn ends with the shared bridge secret, and screenshot links carry their own signature so
 * GitHub's image proxy and the executor can fetch them.
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
    )
    .post(
      "/lody/turn",
      bodyLimit({
        maxSize: MAX_TURN_BYTES,
        onError: (c) => c.json({ ok: false as const, error: "payload too large" }, 413),
      }),
      async (c) => {
        if (!harness) return c.json({ ok: false as const, error: "Not found" }, 404);
        const response = harness.handleLodyTurn({
          timestamp: c.req.header("x-harness-timestamp"),
          signature: c.req.header("x-harness-signature"),
          body: await c.req.text(),
        });
        return c.json(response.body, response.status);
      },
    );
}
