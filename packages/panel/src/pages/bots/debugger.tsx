import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import type {
  BotWithStatus,
  TelegramRichMessageFormat,
  TelegramRichMessageReceipt,
} from "@cos-tool-bot/shared";
import { Bug, Copy, Download, Pin, Play, RefreshCw, RotateCcw, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router";
import { downloadDebugRun } from "./debugger-export";
import { EngagementSamplesSection } from "./ai-settings/sections/engagement-samples-section";

interface BotRunEvent {
  id: number;
  sequence: number;
  kind: string;
  level: string;
  data: Record<string, unknown>;
  createdAt: string;
}

interface BotRun {
  id: string;
  source: string;
  channel: string;
  mode: string;
  status: string;
  failureReason: string | null;
  input: Record<string, unknown>;
  configSnapshot: Record<string, unknown> | null;
  durationMs: number | null;
  pinned?: boolean;
  createdAt: string;
  events?: BotRunEvent[];
}

function statusVariant(status: string) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "destructive" as const;
  return "muted" as const;
}

export function BotDebuggerPage() {
  const { t } = useTranslation("botData");
  const { botId } = useParams<{ botId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "engagement" ? "engagement" : "runs";
  const activeTabRef = useRef(activeTab);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [selected, setSelected] = useState<BotRun | null>(null);
  const [mode, setMode] = useState<"message" | "raw">("message");
  const [channel, setChannel] = useState<"telegram" | "lark-webhook">("telegram");
  const [message, setMessage] = useState("");
  const [rawEvent, setRawEvent] = useState(() =>
    JSON.stringify(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private" },
          text: t("debugger.sampleMessage"),
        },
      },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [richChatId, setRichChatId] = useState("");
  const [richFormat, setRichFormat] = useState<TelegramRichMessageFormat>("markdown");
  const [richContent, setRichContent] = useState(() => t("debugger.richMessage.sampleMarkdown"));
  const [richBusy, setRichBusy] = useState(false);
  const [richError, setRichError] = useState<string | null>(null);
  const [richReceipt, setRichReceipt] = useState<TelegramRichMessageReceipt | null>(null);
  const [loadedBot, setLoadedBot] = useState<{
    id: string;
    platform: BotWithStatus["platform"];
  } | null>(null);
  const activeBotIdRef = useRef(botId);
  const previousBotIdRef = useRef(botId);
  const botLoadRequestRef = useRef(0);
  const runsLoadRequestRef = useRef(0);
  const richSendRequestRef = useRef(0);
  activeBotIdRef.current = botId;
  activeTabRef.current = activeTab;
  const statusLabels = useMemo<Record<string, string>>(
    () => ({
      running: t("debugger.statuses.running"),
      succeeded: t("debugger.statuses.succeeded"),
      failed: t("debugger.statuses.failed"),
      cancelled: t("debugger.statuses.cancelled"),
    }),
    [t],
  );
  const modeLabels = useMemo<Record<string, string>>(
    () => ({
      message: t("debugger.modes.message"),
      raw: t("debugger.modes.raw"),
      "dry-run": t("debugger.modes.dryRun"),
    }),
    [t],
  );
  const channelLabels = useMemo<Record<string, string>>(
    () => ({
      telegram: t("debugger.telegram"),
      "lark-webhook": t("debugger.lark"),
    }),
    [t],
  );

  useEffect(() => {
    if (previousBotIdRef.current === botId) return;
    previousBotIdRef.current = botId;
    botLoadRequestRef.current += 1;
    richSendRequestRef.current += 1;
    setRichChatId("");
    setRichFormat("markdown");
    setRichContent(t("debugger.richMessage.sampleMarkdown"));
    setRichBusy(false);
    setRichError(null);
    setRichReceipt(null);
    setLoadedBot(null);
  }, [botId, t]);

  const loadRuns = useCallback(async () => {
    if (!botId || activeTabRef.current !== "runs") return;
    const requestedBotId = botId;
    const requestId = ++runsLoadRequestRef.current;
    try {
      const response = await authFetch(`/api/bots/${requestedBotId}/runs`);
      const json = (await response.json()) as { ok: boolean; data?: BotRun[]; error?: string };
      if (!json.ok || !json.data) throw new Error(json.error ?? t("debugger.errors.loadRuns"));
      if (
        activeBotIdRef.current !== requestedBotId ||
        activeTabRef.current !== "runs" ||
        runsLoadRequestRef.current !== requestId
      ) {
        return;
      }
      setRuns(json.data);
    } catch (cause) {
      if (
        activeBotIdRef.current !== requestedBotId ||
        activeTabRef.current !== "runs" ||
        runsLoadRequestRef.current !== requestId
      ) {
        return;
      }
      setError(cause instanceof Error ? cause.message : t("debugger.errors.loadRuns"));
    }
  }, [botId, t]);

  const loadBot = useCallback(async () => {
    if (!botId || activeTabRef.current !== "runs") return;
    const requestedBotId = botId;
    const requestId = ++botLoadRequestRef.current;
    try {
      const response = await authFetch(`/api/bots/${requestedBotId}`);
      const json = (await response.json()) as {
        ok: boolean;
        data?: BotWithStatus;
        error?: string;
      };
      if (!json.ok || !json.data) throw new Error(json.error ?? t("debugger.errors.loadBot"));
      if (
        activeBotIdRef.current !== requestedBotId ||
        activeTabRef.current !== "runs" ||
        botLoadRequestRef.current !== requestId
      ) {
        return;
      }
      setLoadedBot({ id: requestedBotId, platform: json.data.platform });
    } catch (cause) {
      if (
        activeBotIdRef.current !== requestedBotId ||
        activeTabRef.current !== "runs" ||
        botLoadRequestRef.current !== requestId
      ) {
        return;
      }
      setError(cause instanceof Error ? cause.message : t("debugger.errors.loadBot"));
    }
  }, [botId, t]);

  const loadRun = useCallback(
    async (runId: string) => {
      if (!botId) return;
      try {
        const response = await authFetch(`/api/bots/${botId}/runs/${runId}`);
        const json = (await response.json()) as { ok: boolean; data?: BotRun; error?: string };
        if (!json.ok || !json.data) throw new Error(json.error ?? t("debugger.errors.loadRun"));
        setSelected(json.data);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("debugger.errors.loadRun"));
      }
    },
    [botId, t],
  );

  useEffect(() => {
    if (activeTab !== "runs") {
      botLoadRequestRef.current += 1;
      runsLoadRequestRef.current += 1;
      setError(null);
      return;
    }
    void loadBot();
    void loadRuns();
  }, [activeTab, loadBot, loadRuns]);

  useEffect(() => {
    if (activeTab !== "runs" || !botId || !selected || selected.status !== "running") return;
    const source = new EventSource(`/api/bots/${botId}/runs/${selected.id}/stream`);
    const appendEvent = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as BotRunEvent;
      setSelected((current) => {
        if (!current || current.id !== selected.id) return current;
        if (current.events?.some((item) => item.sequence === event.sequence)) return current;
        return { ...current, events: [...(current.events ?? []), event] };
      });
    };
    source.addEventListener("bot-run-event", appendEvent);
    source.addEventListener("bot-run-complete", () => {
      void loadRun(selected.id);
      void loadRuns();
      source.close();
    });
    return () => source.close();
  }, [activeTab, botId, selected?.id, selected?.status, loadRun, loadRuns]);

  const start = async (replayId?: string) => {
    if (!botId) return;
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (replayId) {
        const response = await authFetch(`/api/bots/${botId}/runs/${replayId}/replay`, {
          method: "POST",
        });
        const json = (await response.json()) as { ok: boolean; data?: BotRun; error?: string };
        if (!json.ok || !json.data) throw new Error(json.error ?? t("debugger.errors.replay"));
        setSelected(json.data);
        await loadRuns();
        return;
      }
      if (mode === "raw") {
        try {
          body = { channelEvent: JSON.parse(rawEvent) as unknown, channel };
        } catch {
          throw new Error(t("debugger.errors.invalidJson"));
        }
      } else {
        body = { text: message, channel };
      }
      const response = await authFetch(`/api/bots/${botId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as { ok: boolean; data?: BotRun; error?: string };
      if (!json.ok || !json.data) throw new Error(json.error ?? t("debugger.errors.start"));
      setSelected(json.data);
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debugger.errors.unknown"));
    } finally {
      setBusy(false);
    }
  };

  const sortedEvents = useMemo(
    () => [...(selected?.events ?? [])].sort((a, b) => a.sequence - b.sequence),
    [selected?.events],
  );

  const mutateRun = async (action: "cancel" | "pin", body?: Record<string, unknown>) => {
    if (!botId || !selected) return;
    setError(null);
    try {
      const response = await authFetch(`/api/bots/${botId}/runs/${selected.id}/${action}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? t("debugger.errors.mutate"));
      }
      await loadRun(selected.id);
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debugger.errors.mutate"));
    }
  };

  const sendRichMessage = async () => {
    if (!botId) return;
    const requestedBotId = botId;
    const requestId = ++richSendRequestRef.current;
    setRichBusy(true);
    setRichError(null);
    setRichReceipt(null);
    try {
      const response = await authFetch(`/api/bots/${requestedBotId}/debug/rich-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: richChatId,
          format: richFormat,
          content: richContent,
        }),
      });
      const json = (await response.json()) as {
        ok: boolean;
        data?: TelegramRichMessageReceipt;
        error?: string;
      };
      if (!response.ok || !json.ok || !json.data) {
        throw new Error(json.error ?? t("debugger.richMessage.errors.send"));
      }
      if (activeBotIdRef.current !== requestedBotId || richSendRequestRef.current !== requestId) {
        return;
      }
      setRichReceipt(json.data);
    } catch (cause) {
      if (activeBotIdRef.current !== requestedBotId || richSendRequestRef.current !== requestId) {
        return;
      }
      setRichError(cause instanceof Error ? cause.message : t("debugger.richMessage.errors.send"));
    } finally {
      if (activeBotIdRef.current === requestedBotId && richSendRequestRef.current === requestId) {
        setRichBusy(false);
      }
    }
  };

  return (
    <div
      className={
        activeTab === "runs"
          ? "space-y-6 xl:flex xl:h-[calc(100dvh-5rem)] xl:min-h-0 xl:flex-col xl:gap-5 xl:space-y-0 xl:overflow-hidden"
          : "min-w-0 space-y-5"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3 xl:shrink-0">
        <div>
          <p className="text-primary mb-1 text-sm font-medium">{t("debugger.eyebrow")}</p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            <Bug className="size-7" /> {t("debugger.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("debugger.description")}</p>
        </div>
        <Badge variant="muted">
          {t(activeTab === "runs" ? "debugger.ownerOnly" : "debugger.ownerOrAdmin")}
        </Badge>
      </div>

      <div
        role="tablist"
        aria-label={t("debugger.tabs.ariaLabel")}
        className="flex w-fit max-w-full gap-1 rounded-lg bg-slate-100 p-1 xl:shrink-0"
      >
        {(["runs", "engagement"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`debugger-tab-${tab}`}
            aria-controls={`debugger-panel-${tab}`}
            aria-selected={activeTab === tab}
            className="focus-visible:ring-ring rounded-md px-3 py-2 text-sm font-medium transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:outline-none aria-selected:bg-white aria-selected:text-slate-950 aria-selected:shadow-sm"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (tab === "runs") next.delete("tab");
              else next.set("tab", "engagement");
              setSearchParams(next, { replace: true });
            }}
          >
            {t(`debugger.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === "engagement" && botId && (
        <div
          id="debugger-panel-engagement"
          role="tabpanel"
          aria-labelledby="debugger-tab-engagement"
        >
          <EngagementSamplesSection botId={botId} />
        </div>
      )}

      <div
        id="debugger-panel-runs"
        role="tabpanel"
        aria-labelledby="debugger-tab-runs"
        hidden={activeTab !== "runs"}
        className="grid gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(28rem,1.2fr)]"
      >
        <div className="space-y-5 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("debugger.newRun")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === "message" ? "default" : "outline"}
                  onClick={() => setMode("message")}
                >
                  {t("debugger.messageMode")}
                </Button>
                <Button
                  size="sm"
                  variant={mode === "raw" ? "default" : "outline"}
                  onClick={() => setMode("raw")}
                >
                  {t("debugger.rawMode")}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs font-medium uppercase">
                  {t("debugger.channel")}
                </span>
                <Button
                  size="sm"
                  variant={channel === "telegram" ? "default" : "outline"}
                  onClick={() => setChannel("telegram")}
                >
                  {t("debugger.telegram")}
                </Button>
                <Button
                  size="sm"
                  variant={channel === "lark-webhook" ? "default" : "outline"}
                  onClick={() => setChannel("lark-webhook")}
                >
                  {t("debugger.lark")}
                </Button>
              </div>
              {mode === "message" ? (
                <Textarea
                  aria-label={t("debugger.messageAria")}
                  rows={6}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t("debugger.messagePlaceholder")}
                />
              ) : (
                <Textarea
                  aria-label={t("debugger.rawEventAria")}
                  className="font-mono text-xs"
                  rows={14}
                  value={rawEvent}
                  onChange={(event) => setRawEvent(event.target.value)}
                />
              )}
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || (mode === "message" && !message.trim())}
                onClick={() => void start()}
              >
                <Play className="size-4" />
                {busy ? t("debugger.starting") : t("debugger.runDryRun")}
              </Button>
            </CardContent>
          </Card>

          {loadedBot !== null && loadedBot.id === botId && loadedBot.platform === "telegram" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("debugger.richMessage.title")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">
                  {t("debugger.richMessage.description")}
                </p>
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {t("debugger.richMessage.warning")}
                </p>
                <label className="space-y-1.5">
                  <span className="text-sm font-medium">{t("debugger.richMessage.chatId")}</span>
                  <Input
                    inputMode="numeric"
                    value={richChatId}
                    onChange={(event) => setRichChatId(event.target.value)}
                    placeholder={t("debugger.richMessage.chatIdPlaceholder")}
                  />
                </label>
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">{t("debugger.richMessage.format")}</span>
                  <div
                    role="group"
                    aria-label={t("debugger.richMessage.format")}
                    className="flex gap-2"
                  >
                    <Button
                      size="sm"
                      aria-pressed={richFormat === "markdown"}
                      variant={richFormat === "markdown" ? "default" : "outline"}
                      onClick={() => {
                        setRichFormat("markdown");
                        setRichContent(t("debugger.richMessage.sampleMarkdown"));
                      }}
                    >
                      Markdown
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={richFormat === "html"}
                      variant={richFormat === "html" ? "default" : "outline"}
                      onClick={() => {
                        setRichFormat("html");
                        setRichContent(t("debugger.richMessage.sampleHtml"));
                      }}
                    >
                      HTML
                    </Button>
                  </div>
                </div>
                <Textarea
                  aria-label={t("debugger.richMessage.contentAria")}
                  className="font-mono text-xs"
                  rows={12}
                  value={richContent}
                  onChange={(event) => setRichContent(event.target.value)}
                />
                {richError && (
                  <p role="alert" className="text-destructive text-sm">
                    {richError}
                  </p>
                )}
                {richReceipt && (
                  <p role="status" className="text-sm text-emerald-700">
                    {t("debugger.richMessage.success", {
                      messageId: richReceipt.messageId,
                      chatId: richReceipt.chatId,
                      format: richReceipt.format,
                    })}
                  </p>
                )}
                <Button
                  disabled={richBusy || !richChatId.trim() || !richContent.trim()}
                  onClick={() => void sendRichMessage()}
                >
                  <Send className="size-4" />
                  {richBusy ? t("debugger.richMessage.sending") : t("debugger.richMessage.send")}
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">{t("debugger.runs")}</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("debugger.refreshRuns")}
                onClick={() => void loadRuns()}
              >
                <RefreshCw className="size-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {runs.length === 0 && (
                <p className="text-muted-foreground text-sm">{t("debugger.noRuns")}</p>
              )}
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => void loadRun(run.id)}
                  className="hover:bg-muted/60 w-full rounded-lg border p-3 text-left transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
                    <Badge variant={statusVariant(run.status)}>
                      {statusLabels[run.status] ?? run.status}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-1 truncate text-xs">
                    {String(run.input["text"] ?? run.source)}
                  </p>
                  {run.failureReason && (
                    <p className="text-destructive mt-1 text-xs">{run.failureReason}</p>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0 xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
          <CardHeader className="gap-4 space-y-0 xl:shrink-0">
            <div className="min-w-0">
              <CardTitle className="text-base">{t("debugger.runDetail")}</CardTitle>
              {selected && (
                <p
                  className="text-muted-foreground mt-1 truncate font-mono text-xs tabular-nums"
                  title={selected.id}
                >
                  {selected.id}
                </p>
              )}
            </div>
            {selected && (
              <div
                className="flex flex-wrap gap-2 border-t pt-4"
                aria-label={t("debugger.runActions")}
              >
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  title={t("debugger.exportTitle")}
                  onClick={() => downloadDebugRun(selected, t)}
                >
                  <Download className="size-4" /> {t("debugger.export")}
                </Button>
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  onClick={() => void mutateRun("pin", { pinned: !selected.pinned })}
                >
                  <Pin className="size-4" />
                  {selected.pinned ? t("debugger.unpin") : t("debugger.pin")}
                </Button>
                {selected.status === "running" && (
                  <Button
                    className="transition-transform active:scale-[0.96]"
                    size="sm"
                    variant="destructive"
                    onClick={() => void mutateRun("cancel")}
                  >
                    <Square className="size-4" /> {t("debugger.cancel")}
                  </Button>
                )}
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  title={t("debugger.replayTitle")}
                  onClick={() => void start(selected.id)}
                >
                  <RotateCcw className="size-4" /> {t("debugger.replay")}
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
            {!selected ? (
              <p className="text-muted-foreground py-12 text-center text-sm">
                {t("debugger.selectRun")}
              </p>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={statusVariant(selected.status)}>
                    {statusLabels[selected.status] ?? selected.status}
                  </Badge>
                  <Badge variant="muted">
                    {channelLabels[selected.channel] ?? selected.channel}
                  </Badge>
                  <Badge variant="muted">{modeLabels[selected.mode] ?? selected.mode}</Badge>
                  {selected.failureReason && (
                    <Badge variant="destructive">{selected.failureReason}</Badge>
                  )}
                </div>
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("debugger.inputSnapshot")}
                  </summary>
                  <pre className="mt-3 max-h-80 overflow-auto text-xs whitespace-pre-wrap">
                    {JSON.stringify(
                      { input: selected.input, config: selected.configSnapshot },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <div className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-slate-200">
                  {sortedEvents.map((event) => (
                    <div key={event.id} className="relative pl-7">
                      <span
                        className={`absolute top-1.5 left-0 size-3.5 rounded-full border-2 border-white ${event.level === "error" ? "bg-red-500" : "bg-blue-500"}`}
                      />
                      <div className="rounded-lg border bg-white p-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-xs font-semibold">
                            {event.sequence}. {event.kind}
                          </span>
                          <button
                            aria-label={t("debugger.copyEvent")}
                            onClick={() =>
                              void navigator.clipboard.writeText(
                                JSON.stringify(event.data, null, 2),
                              )
                            }
                          >
                            <Copy className="text-muted-foreground size-3.5" />
                          </button>
                        </div>
                        <pre className="mt-2 overflow-x-auto text-xs break-all whitespace-pre-wrap">
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
