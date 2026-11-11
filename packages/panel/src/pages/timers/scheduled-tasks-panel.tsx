import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { client } from "@/lib/client";
import type {
  ScheduledTaskPlan,
  ScheduledTaskRecord,
  ScheduledTaskRun,
} from "@cos-tool-bot/shared";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TaskPlanForm, type TaskPlanInput } from "./plan-form";

async function result<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error ?? String(response.status));
  return body.data;
}
function PlanSummary({ plan }: { plan: ScheduledTaskPlan }) {
  const { t } = useTranslation("admin");
  const schedule = plan.schedule;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground text-xs">
        {t("scheduledTasks.firstRun")}:{" "}
        {new Date(schedule.kind === "once" ? schedule.at : schedule.startsAt).toLocaleString()} ·{" "}
        {t("scheduledTasks.missedPolicy")}
      </p>
      <p className="break-words whitespace-pre-wrap">{plan.instructions}</p>
      <dl className="text-muted-foreground grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">{t("scheduledTasks.kind")}: </dt>
          <dd className="inline">
            {t(`scheduledTasks.${schedule.kind === "calendar" ? schedule.period : schedule.kind}`)}{" "}
            · {schedule.timezone}
            {schedule.kind === "interval"
              ? ` · ${schedule.everySeconds} ${t("scheduledTasks.secondsUnit")}`
              : schedule.kind === "calendar"
                ? ` · ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} · ${schedule.period === "week" ? t(`scheduledTasks.weekdays.${schedule.weekday ?? 0}`) : schedule.dayOfMonth}`
                : ` · ${new Date(schedule.at).toLocaleString()}`}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">{t("scheduledTasks.destination")}: </dt>
          <dd className="inline">
            {plan.destination.chatId}
            {plan.destination.threadId ? ` / ${plan.destination.threadId}` : ""}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">{t("scheduledTasks.scope")}: </dt>
          <dd className="inline">
            {t(
              plan.dataScope.kind === "none"
                ? "scheduledTasks.noHistory"
                : "scheduledTasks.chatHistory",
            )}
            {plan.dataScope.kind === "chat"
              ? ` · ${plan.dataScope.lookbackHours ?? 24}h · ${plan.dataScope.maxMessages ?? 100}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">{t("scheduledTasks.agent")}: </dt>
          <dd className="inline">
            {plan.agentName ?? t("scheduledTasks.defaultAgent")}
            {plan.agent.modelId ? ` · ${plan.agent.modelId}` : ""}
          </dd>
        </div>
      </dl>
      <details>
        <summary className="cursor-pointer text-xs">{t("scheduledTasks.snapshot")}</summary>
        <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded p-3 text-xs">
          {JSON.stringify(plan, null, 2)}
        </pre>
      </details>
    </div>
  );
}
export function ScheduledTasksPanel() {
  const { t } = useTranslation("admin");
  const [tasks, setTasks] = useState<ScheduledTaskRecord[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ScheduledTaskRecord | "new" | null>(null);
  const [logs, setLogs] = useState<{ id: string; rows: ScheduledTaskRun[] } | null>(null);
  const reload = useCallback(async () => {
    const rows = await result<ScheduledTaskRecord[]>(
      await client.api["scheduled-tasks"].$get({ query: {} }),
    );
    setTasks(rows);
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const allBots: { id: string; name: string }[] = [];
        for (let page = 1; ; page++) {
          const response = await client.api.bots.$get({
            query: { page: String(page), limit: "100" },
          });
          const body = await response.json();
          if (!body.ok)
            throw new Error("error" in body ? String(body.error) : String(response.status));
          allBots.push(...body.data);
          if (allBots.length >= body.total || body.data.length === 0) break;
        }
        if (active) setBots(allBots);
        await reload();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    const timer = setInterval(() => {
      void reload().catch((e) => {
        if (active) setError(String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reload]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (input: TaskPlanInput) =>
    act(async () => {
      if (editing && editing !== "new")
        await result(
          await client.api["scheduled-tasks"][":id"].plan.$put({
            param: { id: editing.id },
            json: { plan: input.plan },
          }),
        );
      else await result(await client.api["scheduled-tasks"].$post({ json: input }));
      setEditing(null);
    });
  const decision = (task: ScheduledTaskRecord, action: "approve" | "trial" | "cancel") =>
    act(async () =>
      result(
        await client.api["scheduled-tasks"][":id"].decision.$post({
          param: { id: task.id },
          json: { version: task.pendingVersion!, action },
        }),
      ),
    );
  const manage = (task: ScheduledTaskRecord, action: "pause" | "resume" | "cancel") =>
    act(async () =>
      result(
        await client.api["scheduled-tasks"][":id"].manage.$post({
          param: { id: task.id },
          json: { action },
        }),
      ),
    );
  return (
    <section className="space-y-4" aria-label={t("scheduledTasks.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("scheduledTasks.title")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("scheduledTasks.description")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void act(reload)}>
            {t("timers.refresh")}
          </Button>
          <Button onClick={() => setEditing("new")} disabled={busy}>
            {t("scheduledTasks.create")}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-destructive rounded-lg border p-3 text-sm">
          {error}
        </p>
      )}
      {editing && (
        <Card>
          <CardContent className="p-5">
            <h3 className="mb-4 font-semibold">
              {t(editing === "new" ? "scheduledTasks.create" : "scheduledTasks.edit")}
            </h3>
            <TaskPlanForm
              key={editing === "new" ? "new" : editing.id}
              task={editing === "new" ? undefined : editing}
              bots={bots}
              busy={busy}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          </CardContent>
        </Card>
      )}
      {loading ? (
        <p className="text-muted-foreground text-sm">{t("timers.loading")}</p>
      ) : tasks.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground p-6 text-sm">
            {t("scheduledTasks.empty")}
          </CardContent>
        </Card>
      ) : (
        tasks.map((task) => (
          <Card key={task.id}>
            <CardContent className="space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold break-words">
                    {(task.activePlan ?? task.pendingPlan)?.name ?? task.id}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {bots.find((bot) => bot.id === task.botId)?.name ?? task.botId} · {task.chatId}
                    {task.threadId ? ` / ${task.threadId}` : ""}
                  </p>
                </div>
                <Badge variant="muted">{t(`scheduledTasks.status.${task.status}`)}</Badge>
              </div>
              {task.activePlan && <PlanSummary plan={task.activePlan} />}
              <p className="text-muted-foreground text-xs">
                {t("timers.nextRun")}:{" "}
                {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}
                {task.runningRunId ? ` · ${t("scheduledTasks.status.running")}` : ""}
              </p>
              {task.pendingPlan && (
                <div className="bg-muted/40 space-y-3 rounded-lg border p-4">
                  <h4 className="font-medium">
                    {t("scheduledTasks.pendingVersion", { version: task.pendingVersion })} ·{" "}
                    {task.pendingPlan.name}
                  </h4>
                  <PlanSummary plan={task.pendingPlan} />
                  <p className="text-muted-foreground text-xs">
                    {t("scheduledTasks.proposer")}: {task.proposerName} ·{" "}
                    {t("scheduledTasks.expires")}:{" "}
                    {task.expiresAt ? new Date(task.expiresAt).toLocaleString() : "—"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["approve", "trial", "cancel"] as const).map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "approve" ? "default" : "outline"}
                        disabled={
                          busy ||
                          !!task.runningRunId ||
                          !task.expiresAt ||
                          new Date(task.expiresAt) <= new Date()
                        }
                        onClick={() => void decision(task, action)}
                      >
                        {t(`scheduledTasks.${action === "cancel" ? "reject" : action}`)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {task.status !== "cancelled" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditing(task)}
                  >
                    {t("scheduledTasks.edit")}
                  </Button>
                )}
                {task.activePlan && task.status === "active" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void manage(task, "pause")}
                  >
                    {t("scheduledTasks.pause")}
                  </Button>
                )}
                {task.status === "paused" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void manage(task, "resume")}
                  >
                    {t("scheduledTasks.resume")}
                  </Button>
                )}
                {task.activePlan && task.status !== "cancelled" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t("scheduledTasks.cancelConfirm")))
                        void manage(task, "cancel");
                    }}
                  >
                    {t("scheduledTasks.cancel")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setLogs({
                        id: task.id,
                        rows: await result<ScheduledTaskRun[]>(
                          await client.api["scheduled-tasks"][":id"].runs.$get({
                            param: { id: task.id },
                          }),
                        ),
                      }),
                    )
                  }
                >
                  {t("scheduledTasks.logs")}
                </Button>
              </div>
              {logs?.id === task.id && (
                <div className="space-y-3 border-t pt-4">
                  <h4 className="font-medium">{t("scheduledTasks.logs")}</h4>
                  {logs.rows.length === 0 ? (
                    <p className="text-muted-foreground text-sm">{t("scheduledTasks.noRuns")}</p>
                  ) : (
                    logs.rows.map((run) => (
                      <details key={run.id} className="rounded border p-3">
                        <summary className="cursor-pointer text-sm">
                          {new Date(run.startedAt).toLocaleString()} ·{" "}
                          {t(`scheduledTasks.status.${run.status}`)}
                          {run.trial ? ` · ${t("scheduledTasks.trial")}` : ""}
                        </summary>
                        <div className="mt-3 space-y-3">
                          <p className="text-muted-foreground text-xs">
                            {t("scheduledTasks.scheduledFor")}:{" "}
                            {new Date(run.scheduledFor).toLocaleString()}
                          </p>
                          <pre className="max-h-80 overflow-auto text-sm break-words whitespace-pre-wrap">
                            {run.error ?? run.output ?? t("scheduledTasks.status.running")}
                          </pre>
                          <PlanSummary plan={{ ...run.plan, agent: run.agent }} />
                        </div>
                      </details>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}
