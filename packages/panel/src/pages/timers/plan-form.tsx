import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { TaskAgentFields } from "@/pages/bots/ai-settings/sections/task-agent-fields";
import { client } from "@/lib/client";
import type {
  AgentExecutionConfig,
  ScheduledTaskPlan,
  ScheduledTaskRecord,
  TaskSchedule,
} from "@cos-tool-bot/shared";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface TaskPlanInput {
  botId: string;
  chatId: number;
  threadId?: number;
  plan: ScheduledTaskPlan;
}
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function TaskPlanForm({
  task,
  bots,
  busy,
  onSave,
  onCancel,
}: {
  task?: ScheduledTaskRecord;
  bots: { id: string; name: string }[];
  busy: boolean;
  onSave: (input: TaskPlanInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("admin");
  const id = useId();
  const initial = task?.pendingPlan ?? task?.activePlan;
  const [botId, setBotId] = useState(task?.botId ?? bots[0]?.id ?? "");
  const [chatId, setChatId] = useState(String(task?.chatId ?? ""));
  const [threadId, setThreadId] = useState(String(task?.threadId ?? ""));
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [scope, setScope] = useState(initial?.dataScope.kind ?? "none");
  const [lookback, setLookback] = useState(String(initial?.dataScope.lookbackHours ?? 24));
  const [maxMessages, setMaxMessages] = useState(String(initial?.dataScope.maxMessages ?? 100));
  const [destination, setDestination] = useState(String(initial?.destination.chatId ?? ""));
  const [destinationThread, setDestinationThread] = useState(
    String(initial?.destination.threadId ?? ""),
  );
  const schedule = initial?.schedule;
  const [kind, setKind] = useState<"once" | "interval" | "week" | "month" | "quarter">(
    schedule?.kind === "calendar" ? schedule.period : (schedule?.kind ?? "once"),
  );
  const [startsAt, setStartsAt] = useState(
    localDate(
      schedule?.kind === "once"
        ? schedule.at
        : (schedule?.startsAt ?? new Date(Date.now() + 3600000).toISOString()),
    ),
  );
  const [timezone, setTimezone] = useState(
    schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [seconds, setSeconds] = useState(
    String(schedule?.kind === "interval" ? schedule.everySeconds : 3600),
  );
  const [time, setTime] = useState(
    schedule?.kind === "calendar"
      ? `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`
      : "09:00",
  );
  const [day, setDay] = useState(
    String(schedule?.kind === "calendar" ? (schedule.dayOfMonth ?? 1) : 1),
  );
  const [weekday, setWeekday] = useState(
    String(schedule?.kind === "calendar" ? (schedule.weekday ?? 1) : 1),
  );
  const [agentName, setAgentName] = useState(initial?.agentName ?? "");
  const [agent, setAgent] = useState<AgentExecutionConfig>(initial?.agent ?? {});
  const [agents, setAgents] = useState<string[]>([]);
  const [providers, setProviders] = useState<{ id: string; label: string; defaultModel: string }[]>(
    [],
  );
  const [configError, setConfigError] = useState("");
  useEffect(() => {
    if (!botId) return;
    let active = true;
    setConfigError("");
    setAgents([]);
    setProviders([]);
    void (async () => {
      try {
        const response = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
        const json = await response.json();
        if (!json.ok)
          throw new Error("error" in json ? String(json.error) : String(response.status));
        if (active) {
          setAgents(Object.keys(json.data.agentToolsConfig?.agents ?? {}));
          setProviders(json.data.providers ?? []);
        }
      } catch (error) {
        if (active) setConfigError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [botId]);
  const field = (key: string, children: ReactNode) => (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
        {t(`scheduledTasks.${key}`)}
      </label>
      {children}
    </div>
  );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const start = new Date(startsAt).toISOString();
        const [hour, minute] = time.split(":").map(Number);
        const nextSchedule: TaskSchedule =
          kind === "once"
            ? { kind, at: start, timezone }
            : kind === "interval"
              ? { kind, startsAt: start, timezone, everySeconds: Number(seconds) }
              : {
                  kind: "calendar",
                  startsAt: start,
                  timezone,
                  period: kind,
                  hour: hour!,
                  minute: minute!,
                  ...(kind === "week" ? { weekday: Number(weekday) } : { dayOfMonth: Number(day) }),
                };
        void onSave({
          botId,
          chatId: Number(chatId),
          ...(threadId ? { threadId: Number(threadId) } : {}),
          plan: {
            name,
            instructions,
            dataScope:
              scope === "none"
                ? { kind: "none" }
                : {
                    kind: "chat",
                    lookbackHours: Number(lookback),
                    maxMessages: Number(maxMessages),
                  },
            destination: {
              chatId: Number(destination || chatId),
              ...(destinationThread ? { threadId: Number(destinationThread) } : {}),
            },
            schedule: nextSchedule,
            agent,
            ...(agentName ? { agentName } : {}),
          },
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {field(
          "bot",
          <Select
            id={`${id}-bot`}
            value={botId}
            disabled={!!task}
            onChange={(e) => setBotId(e.target.value)}
            required
          >
            <option value="">{t("scheduledTasks.chooseBot")}</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </Select>,
        )}
        {field(
          "sourceChat",
          <Input
            id={`${id}-sourceChat`}
            type="number"
            required
            disabled={!!task}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />,
        )}
        {field(
          "sourceTopic",
          <Input
            id={`${id}-sourceTopic`}
            type="number"
            min={1}
            disabled={!!task}
            value={threadId}
            onChange={(e) => setThreadId(e.target.value)}
          />,
        )}
      </div>
      {field(
        "name",
        <Input
          id={`${id}-name`}
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />,
      )}
      {field(
        "instructions",
        <Textarea
          id={`${id}-instructions`}
          required
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />,
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "kind",
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {(["once", "interval", "week", "month", "quarter"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`scheduledTasks.${value}`)}
              </option>
            ))}
          </Select>,
        )}
        {field(
          "startsAt",
          <Input
            id={`${id}-startsAt`}
            type="datetime-local"
            required
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />,
        )}
        {field(
          "timezone",
          <Input
            id={`${id}-timezone`}
            required
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />,
        )}
        {kind === "interval" &&
          field(
            "seconds",
            <Input
              id={`${id}-seconds`}
              type="number"
              min={1}
              required
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />,
          )}
        {kind !== "once" &&
          kind !== "interval" &&
          field(
            "time",
            <Input
              id={`${id}-time`}
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />,
          )}
        {kind === "week" &&
          field(
            "weekday",
            <Select
              id={`${id}-weekday`}
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
            >
              {Array.from({ length: 7 }, (_, value) => (
                <option key={value} value={value}>
                  {t(`scheduledTasks.weekdays.${value}`)}
                </option>
              ))}
            </Select>,
          )}
        {(kind === "month" || kind === "quarter") &&
          field(
            "day",
            <Input
              id={`${id}-day`}
              type="number"
              min={1}
              max={31}
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />,
          )}
      </div>
      <p className="text-muted-foreground text-xs">{t("scheduledTasks.calendarHelp")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "destination",
          <Input
            id={`${id}-destination`}
            type="number"
            placeholder={chatId}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />,
        )}
        {field(
          "destinationTopic",
          <Input
            id={`${id}-destinationTopic`}
            type="number"
            min={1}
            value={destinationThread}
            onChange={(e) => setDestinationThread(e.target.value)}
          />,
        )}
        {field(
          "scope",
          <Select
            id={`${id}-scope`}
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="none">{t("scheduledTasks.noHistory")}</option>
            <option value="chat">{t("scheduledTasks.chatHistory")}</option>
          </Select>,
        )}
        {scope === "chat" && (
          <>
            {field(
              "lookback",
              <Input
                id={`${id}-lookback`}
                type="number"
                min={1}
                required
                value={lookback}
                onChange={(e) => setLookback(e.target.value)}
              />,
            )}
            {field(
              "maxMessages",
              <Input
                id={`${id}-maxMessages`}
                type="number"
                min={1}
                max={1000}
                required
                value={maxMessages}
                onChange={(e) => setMaxMessages(e.target.value)}
              />,
            )}
          </>
        )}
      </div>
      {field(
        "agent",
        <Select id={`${id}-agent`} value={agentName} onChange={(e) => setAgentName(e.target.value)}>
          <option value="">{t("scheduledTasks.defaultAgent")}</option>
          {[...new Set([...agents, ...(agentName ? [agentName] : [])])].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>,
      )}
      {configError && (
        <p role="alert" className="text-destructive text-sm">
          {t("scheduledTasks.configError")}: {configError}
        </p>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("scheduledTasks.overrides")}
        </summary>
        <div className="mt-4">
          <TaskAgentFields
            config={agent}
            onUpdate={(updates) => setAgent((previous) => ({ ...previous, ...updates }))}
            providers={providers}
          />
        </div>
      </details>
      <p className="text-muted-foreground text-sm">{t("scheduledTasks.approvalHelp")}</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !botId}>
          {t("scheduledTasks.save")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t("scheduledTasks.close")}
        </Button>
      </div>
    </form>
  );
}
