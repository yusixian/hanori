import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import type { ChatSummaryRecord } from "@cos-tool-bot/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GovernanceSubjectPicker } from "./governance-subject-picker";

const reviewErrors: Record<string, string> = {
  "Memory consolidation disabled": "disabled",
  "Group impressions disabled": "impressionsDisabled",
  "Memory review already running": "busy",
  "Memory consolidation quota exhausted": "quota",
  "Configured consolidation provider unavailable": "provider",
  "Consolidation model request timed out": "timeout",
  "Consolidation model request failed": "model",
};

function localDateTime(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function MemoryReview({
  botId,
  summary,
}: {
  botId: string;
  summary?: Pick<ChatSummaryRecord, "chatId" | "windowStart" | "windowEnd">;
}) {
  const { t, i18n } = useTranslation("aiSettings");
  const id = useId();
  const nextKey = useRef(1);
  const [groups, setGroups] = useState([{ key: 0, chatId: summary ? String(summary.chatId) : "" }]);
  const [start, setStart] = useState(() => localDateTime(Date.now() - 7 * 86_400_000));
  const [end, setEnd] = useState(() => localDateTime(Date.now()));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<
    Record<string, { message: string; failed: boolean; cursor: number | null }>
  >({});
  const pending = groups.filter(
    ({ chatId }) => !results[chatId] || results[chatId].failed || results[chatId].cursor !== null,
  );
  const more = groups.some(({ chatId }) => results[chatId]?.cursor != null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [lastRun, setLastRun] = useState("");
  const [lastError, setLastError] = useState("");

  useEffect(() => {
    if (summary) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await client.api.bots[":botId"].memory.review.$get(
          { param: { botId } },
          { init: { signal: controller.signal } },
        );
        const body = await res.json();
        if (!body.ok) throw new Error();
        if (controller.signal.aborted) return;
        const run = body.data.lastRun;
        setLastRun(
          run
            ? t("review.lastRun", {
                date: new Date(run.finishedAt).toLocaleString(i18n.resolvedLanguage),
                ...run,
              })
            : t("review.noRuns"),
        );
        setLastError(
          run?.error && reviewErrors[run.error]
            ? t(`review.errors.${reviewErrors[run.error]}`)
            : (run?.error ?? ""),
        );
      } catch {
        if (!controller.signal.aborted) setLastError(t("review.statusFailed"));
      }
    })();
    return () => controller.abort();
  }, [botId, summary, statusVersion, t, i18n.resolvedLanguage]);

  const loadGroups = useCallback(
    async (query: string, signal: AbortSignal) => {
      const res = await client.api.bots[":botId"].conversations.$get(
        {
          param: { botId },
          query: { page: "1", limit: "100", search: query.trim() || undefined },
        },
        { init: { signal } },
      );
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error();
      return body.data
        .filter((chat) => chat.chatType === "group")
        .map((chat) => ({
          value: String(chat.chatId),
          label: chat.userNames?.slice(0, 2).join(", ") || String(chat.chatId),
          detail: String(chat.chatId),
        }));
    },
    [botId],
  );
  const resolveGroup = useCallback(
    async (value: string, signal: AbortSignal) =>
      (await loadGroups(value, signal)).find((option) => option.value === value),
    [loadGroups],
  );

  function resetProgress() {
    setResults({});
  }

  function changeGroup(key: number, chatId: string) {
    setGroups(groups.map((group) => (group.key === key ? { key, chatId } : group)));
  }

  async function run() {
    setBusy(true);
    const targets = pending.length ? pending : groups;
    if (!pending.length) resetProgress();
    try {
      for (const { chatId } of targets) {
        const cursor = results[chatId]?.cursor ?? null;
        try {
          const res = await client.api.bots[":botId"].memory.review.$post({
            param: { botId },
            json: {
              chatId,
              start: summary?.windowStart ?? new Date(start).toISOString(),
              end: summary?.windowEnd ?? new Date(end).toISOString(),
              ...(cursor === null ? {} : { afterMessageId: cursor }),
            },
          });
          const body = await res.json();
          if (!body.ok) {
            const translation = reviewErrors[body.error];
            const reason = translation ? t(`review.errors.${translation}`) : body.error;
            throw new Error(reason);
          }
          setResults((prev) => ({
            ...prev,
            [chatId]: {
              message: t("review.result", body.data),
              cursor: body.data.nextAfterMessageId,
              failed: false,
            },
          }));
        } catch (error) {
          setResults((prev) => ({
            ...prev,
            [chatId]: {
              message: t("review.failed", {
                reason: error instanceof Error ? error.message : t("common:common.unknown"),
              }),
              failed: true,
              cursor,
            },
          }));
        }
      }
    } finally {
      setBusy(false);
      setStatusVersion((value) => value + 1);
    }
  }

  const datesValid =
    summary ||
    (Number.isFinite(Date.parse(start)) &&
      Date.parse(start) < Date.parse(end) &&
      Date.parse(end) <= Date.now());
  return (
    <section className="space-y-3 border-t pt-4">
      {summary && (
        <p className="text-muted-foreground text-xs">
          {t("review.summaryRange", {
            start: new Date(summary.windowStart).toLocaleString(i18n.resolvedLanguage),
            end: new Date(summary.windowEnd).toLocaleString(i18n.resolvedLanguage),
          })}
        </p>
      )}
      {!summary && (
        <>
          <h3 className="text-sm font-semibold">{t("review.title")}</h3>
          <p className="text-muted-foreground text-xs">{t("review.description")}</p>
          {lastRun && <p className="text-muted-foreground text-xs">{lastRun}</p>}
          {lastError && (
            <p role="alert" className="text-destructive text-xs">
              {lastError}
            </p>
          )}
          <fieldset disabled={busy} className="space-y-3">
            {groups.map(({ key, chatId }) => (
              <div key={key} className="space-y-2">
                <GovernanceSubjectPicker
                  label={t("review.group")}
                  value={chatId}
                  onValueChange={(value) => {
                    changeGroup(key, value);
                  }}
                  loadOptions={loadGroups}
                  resolveOption={resolveGroup}
                  placeholder={t("bots:form.cosInside.selectGroup")}
                  searchPlaceholder={t("review.searchGroup")}
                  emptyText={t("bots:form.cosInside.noGroups")}
                  unknownText={(value) => value}
                  loadErrorText={t("bots:form.cosInside.loadGroupsFailed")}
                />
                <details className="text-xs">
                  <summary className="cursor-pointer">
                    {t("bots:form.cosInside.manualEntry")}
                  </summary>
                  <Input
                    aria-label={t("review.groupId")}
                    className="mt-1"
                    value={chatId}
                    placeholder="-1001234567890"
                    onChange={(event) => {
                      changeGroup(key, event.target.value);
                    }}
                  />
                </details>
                {groups.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setGroups(groups.filter((group) => group.key !== key))}
                  >
                    {t("review.removeGroup")}
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setGroups([...groups, { key: nextKey.current++, chatId: "" }])}
            >
              {t("review.addGroup")}
            </Button>
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor={id + "-start"} className="space-y-1 text-sm">
                {t("review.start")}
                <Input
                  id={id + "-start"}
                  type="datetime-local"
                  value={start}
                  max={end}
                  onChange={(e) => {
                    setStart(e.target.value);
                    resetProgress();
                  }}
                />
              </label>
              <label htmlFor={id + "-end"} className="space-y-1 text-sm">
                {t("review.end")}
                <Input
                  id={id + "-end"}
                  type="datetime-local"
                  value={end}
                  min={start}
                  max={localDateTime(Date.now())}
                  onChange={(e) => {
                    setEnd(e.target.value);
                    resetProgress();
                  }}
                />
              </label>
            </div>
            {!datesValid && (
              <p role="alert" className="text-destructive text-xs">
                {t("review.invalidDates")}
              </p>
            )}
          </fieldset>
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          busy ||
          groups.some(
            ({ chatId }) => !/^-[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)),
          ) ||
          new Set(groups.map((group) => group.chatId)).size !== groups.length ||
          !datesValid
        }
        onClick={() => void run()}
      >
        {busy
          ? t("review.running")
          : more
            ? t("review.continue")
            : summary
              ? t("review.fromSummary")
              : t("review.run")}
      </Button>
      {groups.map(({ key, chatId }) => {
        const result = results[chatId];
        return (
          result && (
            <p
              key={key}
              role={result.failed ? "alert" : "status"}
              className={result.failed ? "text-destructive text-sm" : "text-sm"}
            >
              {groups.length > 1 && <strong>{chatId} · </strong>}
              {result.message}
            </p>
          )
        );
      })}
      {more && !busy && <p className="text-muted-foreground text-xs">{t("review.remaining")}</p>}
    </section>
  );
}
