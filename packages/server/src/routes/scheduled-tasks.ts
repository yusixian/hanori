import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { ScheduledTaskActor, ScheduledTaskRecord } from "@cos-tool-bot/shared";
import type { ScheduledTaskService } from "../services/scheduled-tasks.js";
import { parseScheduledTaskPlan, ScheduledTaskRequestError } from "../services/scheduled-tasks.js";

const source = z.object({
  botId: z.string().uuid(),
  chatId: z.number().int().safe(),
  threadId: z.number().int().positive().optional(),
});
// All routes are mounted behind owner/admin middleware. Web approvals carry no Telegram identity.
function actor(
  task: Pick<ScheduledTaskRecord, "botId" | "chatId" | "threadId">,
): ScheduledTaskActor {
  return {
    botId: task.botId,
    chatId: task.chatId,
    threadId: task.threadId ?? undefined,
    userId: 0,
    userName: "Panel administrator",
    isAdmin: true,
    isBotAdmin: true,
  };
}
export function scheduledTaskRoutes(service?: ScheduledTaskService) {
  return new Hono()
    .onError((error, c) => {
      if (error instanceof z.ZodError)
        return c.json(
          { ok: false as const, error: error.issues.map((issue) => issue.message).join("; ") },
          400,
        );
      if (error instanceof ScheduledTaskRequestError)
        return c.json({ ok: false as const, error: error.message }, 409);
      throw error;
    })
    .use("*", async (c, next) => {
      if (!service)
        return c.json({ ok: false as const, error: "Scheduled tasks are unavailable" }, 503);
      await next();
    })
    .get("/", async (c) =>
      c.json({ ok: true as const, data: await service!.listForPanel(c.req.query("botId")) }),
    )
    .post("/", zValidator("json", source.extend({ plan: z.unknown() })), async (c) => {
      const body = c.req.valid("json");
      const plan = parseScheduledTaskPlan(body.plan);
      const data = await service!.propose(
        actor({ ...body, threadId: body.threadId ?? null }),
        plan,
      );
      return c.json({ ok: true as const, data }, 201);
    })
    .get("/:id/runs", async (c) => {
      const task = await service!.getForPanel(c.req.param("id"));
      if (!task) return c.json({ ok: false as const, error: "Task not found" }, 404);
      return c.json({ ok: true as const, data: await service!.runs(actor(task), task.id) });
    })
    .put("/:id/plan", zValidator("json", z.object({ plan: z.unknown() })), async (c) => {
      const task = await service!.getForPanel(c.req.param("id"));
      if (!task) return c.json({ ok: false as const, error: "Task not found" }, 404);
      const data = await service!.propose(
        actor(task),
        parseScheduledTaskPlan(c.req.valid("json").plan),
        task.id,
      );
      return c.json({ ok: true as const, data });
    })
    .post(
      "/:id/decision",
      zValidator(
        "json",
        z.object({
          version: z.number().int().positive(),
          action: z.enum(["approve", "trial", "cancel"]),
        }),
      ),
      async (c) => {
        const task = await service!.getForPanel(c.req.param("id"));
        if (!task) return c.json({ ok: false as const, error: "Task not found" }, 404);
        const data = await service!.decide(actor(task), { id: task.id, ...c.req.valid("json") });
        return c.json({ ok: true as const, data });
      },
    )
    .post(
      "/:id/manage",
      zValidator("json", z.object({ action: z.enum(["pause", "resume", "cancel"]) })),
      async (c) => {
        const task = await service!.getForPanel(c.req.param("id"));
        if (!task) return c.json({ ok: false as const, error: "Task not found" }, 404);
        return c.json({
          ok: true as const,
          data: await service!.manage(actor(task), task.id, c.req.valid("json").action),
        });
      },
    );
}
