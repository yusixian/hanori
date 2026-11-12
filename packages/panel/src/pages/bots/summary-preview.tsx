import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import type { SummaryToolResult } from "@cos-tool-bot/shared";
import { Loader2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

export function SummaryPreview({
  botId,
  onGenerated,
}: {
  botId: string;
  onGenerated?: () => void;
}) {
  const { t, i18n } = useTranslation("bots");
  const checkboxId = useId();
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [since, setSince] = useState(() => localDateTime(new Date(Date.now() - 86_400_000)));
  const [until, setUntil] = useState(() => localDateTime(new Date()));
  const [maxMessages, setMaxMessages] = useState("1000");
  const [instructions, setInstructions] = useState("");
  const [originalOnly, setOriginalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SummaryToolResult | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatTime = (value: string) =>
    new Date(value).toLocaleString(i18n.resolvedLanguage, { timeZone: timezone, hour12: false });
  const clearResult = () => {
    setResult(null);
    setError("");
  };

  function failure(reason?: string) {
    switch (reason) {
      case "too_few_messages":
        return t("summary.preview.tooFew");
      case "disabled":
        return t("summary.preview.disabled");
      case "no_access":
        return t("summary.preview.noAccess");
      case "cooldown":
        return t("summary.preview.cooldown");
      case "no_provider":
        return t("summary.preview.noProvider");
      case "invalid_time_range":
        return t("summary.preview.invalidRange");
      default:
        return t("summary.preview.failed");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    clearResult();
    const start = new Date(since),
      end = new Date(until);
    if (
      !Number.isSafeInteger(Number(chatId)) ||
      Number(chatId) === 0 ||
      (threadId !== "" && (!Number.isSafeInteger(Number(threadId)) || Number(threadId) <= 0)) ||
      !Number.isInteger(Number(maxMessages)) ||
      Number(maxMessages) < 1 ||
      Number(maxMessages) > 2000
    ) {
      setError(t("summary.preview.invalidNumbers"));
      return;
    }
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start ||
      end.getTime() - start.getTime() > 72 * 3_600_000
    ) {
      setError(t("summary.preview.invalidRange"));
      return;
    }
    setBusy(true);
    try {
      const response = await client.api.bots[":botId"].summary.preview.$post({
        param: { botId },
        json: {
          chatId: Number(chatId),
          ...(threadId === "" ? {} : { threadId: Number(threadId) }),
          since: start.toISOString(),
          until: end.toISOString(),
          maxMessages: Number(maxMessages),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          ...(originalOnly ? { sourceRoles: "original" as const } : {}),
        },
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setError(t("summary.preview.failed"));
        return;
      }
      setResult(body.data);
      if (!body.data.ok) setError(failure(body.data.reason));
      if (body.data.summaryId !== undefined) onGenerated?.();
    } catch {
      setError(t("summary.preview.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <details>
          <summary className="cursor-pointer text-base font-semibold">
            {t("summary.preview.title")}
          </summary>
          <p className="text-muted-foreground mt-3 max-w-prose text-sm leading-6">
            {t("summary.preview.description")}
          </p>
          <form onSubmit={submit} onChange={clearResult} className="mt-4 space-y-4">
            <fieldset disabled={busy} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1.5 text-sm">
                  {" "}
                  <span>{t("summary.preview.chatId")}</span>
                  <Input
                    required
                    type="number"
                    step="1"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                  />
                </label>
                <label className="min-w-0 space-y-1.5 text-sm">
                  <span>{t("summary.preview.threadId")}</span>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={threadId}
                    onChange={(e) => setThreadId(e.target.value)}
                  />
                  <span className="text-muted-foreground block text-xs">
                    {t("summary.preview.topicHint")}
                  </span>
                </label>
                <label className="min-w-0 space-y-1.5 text-sm">
                  <span>{t("summary.preview.since")}</span>
                  <Input
                    className="min-w-0"
                    required
                    type="datetime-local"
                    step="0.001"
                    value={since}
                    onChange={(e) => setSince(e.target.value)}
                  />
                </label>
                <label className="min-w-0 space-y-1.5 text-sm">
                  <span>{t("summary.preview.until")}</span>
                  <Input
                    className="min-w-0"
                    required
                    type="datetime-local"
                    step="0.001"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </label>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("summary.preview.timezone", { timezone })}
              </p>
              <label className="block max-w-xs space-y-1.5 text-sm">
                <span>{t("summary.preview.maxMessages")}</span>
                <Input
                  required
                  type="number"
                  min="1"
                  max="2000"
                  step="1"
                  value={maxMessages}
                  onChange={(e) => setMaxMessages(e.target.value)}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>{t("summary.preview.instructions")}</span>
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                />
              </label>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={originalOnly}
                  onCheckedChange={(value) => {
                    setOriginalOnly(value === true);
                    clearResult();
                  }}
                />
                <label htmlFor={checkboxId} className="text-sm leading-5">
                  {t("summary.preview.originalOnly")}
                </label>
              </div>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {busy ? t("summary.preview.generating") : t("summary.preview.generate")}
              </Button>
            </fieldset>
          </form>
          {busy && (
            <p role="status" className="text-muted-foreground mt-3 text-sm">
              {t("summary.preview.wait")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive mt-4 text-sm">
              {error}
            </p>
          )}
          {result?.coverage && (
            <section
              aria-label={t("summary.preview.coverage")}
              className="mt-5 space-y-2 rounded-lg border p-4 text-sm [overflow-wrap:anywhere]"
            >
              <h3 className="font-semibold">{t("summary.preview.coverage")}</h3>
              <p>
                {result.coverage.truncated
                  ? t("summary.preview.truncated")
                  : t("summary.preview.complete")}
              </p>
              <p>
                {t("summary.preview.count", {
                  count: result.coverage.returnedCount,
                  limit: result.coverage.scope.limit,
                })}
              </p>
              <p>
                {t("summary.preview.scope", {
                  chatId: result.coverage.scope.chatId,
                  topic: result.coverage.scope.threadId ?? t("summary.preview.mainTopic"),
                })}
              </p>
              <p>
                {formatTime(result.coverage.scope.since)} —{" "}
                {formatTime(result.coverage.scope.until)} · {timezone}
              </p>
              <p className="text-muted-foreground text-xs leading-5">
                {t("summary.preview.collectionBoundary")}
              </p>
            </section>
          )}
          {result?.ok && result.contentRaw && (
            <section aria-label={t("summary.preview.result")} className="mt-5 space-y-2">
              <h3 className="font-semibold">{t("summary.preview.result")}</h3>
              <p className="text-sm leading-7 [overflow-wrap:anywhere] whitespace-pre-wrap">
                {result.contentRaw}
              </p>
            </section>
          )}
        </details>
      </CardContent>
    </Card>
  );
}
