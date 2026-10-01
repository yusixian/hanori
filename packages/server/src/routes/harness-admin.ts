import type { HarnessAdminErrorCode } from "@cos-tool-bot/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type HarnessAdmin, type HarnessAdminActor, HarnessAdminError } from "../harness/admin.js";
import type { AuthVariables } from "../middleware/better-auth.js";
import { clearMiniAppSessionCookie } from "../services/mini-app-session.js";
import type { MiniAppSessionVerifier } from "./mini-app-auth.js";

export type HarnessAdminPort = Pick<
  HarnessAdmin,
  | "botId"
  | "isOwner"
  | "overview"
  | "repos"
  | "preview"
  | "createProject"
  | "updateProject"
  | "deleteProject"
  | "setExecution"
  | "refreshExecution"
  | "updateRuntime"
>;

const ERROR_STATUS = {
  not_enabled: 503,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  read_only: 409,
  invalid: 400,
  github_unavailable: 503,
  lody_unavailable: 503,
} as const satisfies Record<HarnessAdminErrorCode, number>;

const MAX_BODY_BYTES = 64 * 1024;

const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json({ ok: false as const, code: "invalid" as const, error: "请求体过大" }, 413),
});

async function respond<T extends object>(c: Context, work: () => Promise<T>) {
  try {
    return c.json({ ok: true as const, ...(await work()) });
  } catch (error) {
    if (!(error instanceof HarnessAdminError)) throw error;
    return c.json(
      {
        ok: false as const,
        code: error.code,
        error: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      },
      ERROR_STATUS[error.code],
    );
  }
}

async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Mounted behind `requireAppAccess` + owner-only roles in app.ts. */
export function harnessAdminRoutes(admin: HarnessAdminPort) {
  const actor = (c: Context<{ Variables: AuthVariables }>): HarnessAdminActor => ({
    via: "panel",
    actorId: null,
    panelUserId: c.get("authUser")?.id,
  });
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "private, no-store");
    })
    .get("/overview", (c) => respond(c, () => admin.overview()))
    .post("/execution/refresh", (c) => respond(c, () => admin.refreshExecution()))
    .post("/runtime/update", (c) => respond(c, () => admin.updateRuntime(actor(c))))
    .get("/repos", (c) => respond(c, () => admin.repos()))
    .post("/preview", limitBody, (c) => respond(c, async () => admin.preview(await readBody(c))))
    .post("/projects", limitBody, (c) =>
      respond(c, async () => ({ project: await admin.createProject(await readBody(c), actor(c)) })),
    )
    .patch("/projects/:key", limitBody, (c) =>
      respond(c, async () => ({
        project: await admin.updateProject(c.req.param("key"), await readBody(c), actor(c)),
      })),
    )
    .delete("/projects/:key", (c) =>
      respond(c, async () => {
        await admin.deleteProject(c.req.param("key"), actor(c));
        return {};
      }),
    )
    .put("/execution", limitBody, (c) =>
      respond(c, async () => admin.setExecution(await readBody(c), actor(c))),
    );
}

type MiniAppHarnessEnv = { Variables: { harnessActor: HarnessAdminActor } };

/**
 * `/api/mini-app/:botId/harness/*`: only the Bot bound to the harness, only `telegram.owners`,
 * and writes carry the session's CSRF token from an allowed origin.
 */
export function harnessMiniAppRoutes(admin: HarnessAdminPort, sessions: MiniAppSessionVerifier) {
  return new Hono<MiniAppHarnessEnv>()
    .use("/:botId/harness/*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      const botId = c.req.param("botId");
      const verified = await sessions.verify(botId, c.req.raw);
      if (!verified.ok) {
        if (verified.status === 401) c.header("Set-Cookie", clearMiniAppSessionCookie(botId));
        const error = verified.status === 401 ? "Unauthorized" : "Not found";
        return c.json({ ok: false as const, code: "forbidden" as const, error }, verified.status);
      }
      if (admin.botId !== botId) {
        return c.json({ ok: false as const, code: "not_found" as const, error: "Not found" }, 404);
      }
      const { session } = verified;
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (!admin.isOwner(session.userId) || (write && !sessions.checkCsrf(c.req.raw, session))) {
        return c.json({ ok: false as const, code: "forbidden" as const, error: "Forbidden" }, 403);
      }
      c.set("harnessActor", { via: "mini-app", actorId: session.userId });
      await next();
    })
    .get("/:botId/harness/overview", (c) => respond(c, () => admin.overview()))
    .post("/:botId/harness/execution/refresh", (c) => respond(c, () => admin.refreshExecution()))
    .post("/:botId/harness/runtime/update", (c) =>
      respond(c, () => admin.updateRuntime(c.get("harnessActor"))),
    )
    .get("/:botId/harness/repos", (c) => respond(c, () => admin.repos()))
    .post("/:botId/harness/preview", limitBody, (c) =>
      respond(c, async () => admin.preview(await readBody(c))),
    )
    .post("/:botId/harness/projects", limitBody, (c) =>
      respond(c, async () => ({
        project: await admin.createProject(await readBody(c), c.get("harnessActor")),
      })),
    )
    .patch("/:botId/harness/projects/:key", limitBody, (c) =>
      respond(c, async () => ({
        project: await admin.updateProject(
          c.req.param("key"),
          await readBody(c),
          c.get("harnessActor"),
        ),
      })),
    )
    .delete("/:botId/harness/projects/:key", (c) =>
      respond(c, async () => {
        await admin.deleteProject(c.req.param("key"), c.get("harnessActor"));
        return {};
      }),
    )
    .put("/:botId/harness/execution", limitBody, (c) =>
      respond(c, async () => admin.setExecution(await readBody(c), c.get("harnessActor"))),
    );
}
