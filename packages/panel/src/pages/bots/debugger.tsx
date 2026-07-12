import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import { Bug, Copy, Download, Pin, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { downloadDebugRun } from "./debugger-export";

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
  const { botId } = useParams<{ botId: string }>();
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [selected, setSelected] = useState<BotRun | null>(null);
  const [mode, setMode] = useState<"message" | "raw">("message");
  const [channel, setChannel] = useState<"telegram" | "lark-webhook">("telegram");
  const [message, setMessage] = useState("");
  const [rawEvent, setRawEvent] = useState(
    JSON.stringify(
      {
        update_id: 1,
        message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "你好" },
      },
      null,
      2,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    if (!botId) return;
    const response = await authFetch(`/api/bots/${botId}/runs`);
    const json = (await response.json()) as { ok: boolean; data?: BotRun[]; error?: string };
    if (json.ok && json.data) setRuns(json.data);
  }, [botId]);

  const loadRun = useCallback(
    async (runId: string) => {
      if (!botId) return;
      const response = await authFetch(`/api/bots/${botId}/runs/${runId}`);
      const json = (await response.json()) as { ok: boolean; data?: BotRun; error?: string };
      if (json.ok && json.data) setSelected(json.data);
    },
    [botId],
  );

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!botId || !selected || selected.status !== "running") return;
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
    source.onerror = () => source.close();
    return () => source.close();
  }, [botId, selected?.id, selected?.status, loadRun, loadRuns]);

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
        if (!json.ok || !json.data) throw new Error(json.error ?? "Replay failed");
        setSelected(json.data);
        await loadRuns();
        return;
      }
      if (mode === "raw") {
        body = { channelEvent: JSON.parse(rawEvent) as unknown, channel };
      } else {
        body = { text: message, channel };
      }
      const response = await authFetch(`/api/bots/${botId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as { ok: boolean; data?: BotRun; error?: string };
      if (!json.ok || !json.data) throw new Error(json.error ?? "Run failed to start");
      setSelected(json.data);
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    await authFetch(`/api/bots/${botId}/runs/${selected.id}/${action}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    await loadRun(selected.id);
    await loadRuns();
  };

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100dvh-5rem)] xl:min-h-0 xl:flex-col xl:space-y-0 xl:overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 xl:shrink-0 xl:pb-6">
        <div>
          <p className="text-primary mb-1 text-sm font-medium">Bot operations</p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            <Bug className="size-7" /> AI Debugger
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Dry-run 当前 Bot 配置，检查模型流事件、错误链与可重放运行记录。
          </p>
        </div>
        <Badge variant="muted">Owner only · no external side effects</Badge>
      </div>

      <div className="grid gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(28rem,1.2fr)]">
        <div className="space-y-5 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New Run</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === "message" ? "default" : "outline"}
                  onClick={() => setMode("message")}
                >
                  Message
                </Button>
                <Button
                  size="sm"
                  variant={mode === "raw" ? "default" : "outline"}
                  onClick={() => setMode("raw")}
                >
                  Raw Channel Event
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs font-medium uppercase">Channel</span>
                <Button
                  size="sm"
                  variant={channel === "telegram" ? "default" : "outline"}
                  onClick={() => setChannel("telegram")}
                >
                  Telegram
                </Button>
                <Button
                  size="sm"
                  variant={channel === "lark-webhook" ? "default" : "outline"}
                  onClick={() => setChannel("lark-webhook")}
                >
                  Lark
                </Button>
              </div>
              {mode === "message" ? (
                <Textarea
                  aria-label="Debug message"
                  rows={6}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="输入一条模拟用户消息…"
                />
              ) : (
                <Textarea
                  aria-label="Raw channel event"
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
                <Play className="size-4" /> {busy ? "Starting…" : "Run dry-run"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Runs</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Refresh runs"
                onClick={() => void loadRuns()}
              >
                <RefreshCw className="size-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {runs.length === 0 && (
                <p className="text-muted-foreground text-sm">No Bot Runs yet.</p>
              )}
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => void loadRun(run.id)}
                  className="hover:bg-muted/60 w-full rounded-lg border p-3 text-left transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
                    <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
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
              <CardTitle className="text-base">Run Detail</CardTitle>
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
              <div className="flex flex-wrap gap-2 border-t pt-4" aria-label="Run actions">
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  title="Export this run as an AI-friendly Markdown file"
                  onClick={() => downloadDebugRun(selected)}
                >
                  <Download className="size-4" /> Export
                </Button>
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  onClick={() => void mutateRun("pin", { pinned: !selected.pinned })}
                >
                  <Pin className="size-4" /> {selected.pinned ? "Unpin" : "Pin"}
                </Button>
                {selected.status === "running" && (
                  <Button
                    className="transition-transform active:scale-[0.96]"
                    size="sm"
                    variant="destructive"
                    onClick={() => void mutateRun("cancel")}
                  >
                    <Square className="size-4" /> Cancel
                  </Button>
                )}
                <Button
                  className="transition-transform active:scale-[0.96]"
                  size="sm"
                  variant="outline"
                  title="Replay with the bot's current configuration"
                  onClick={() => void start(selected.id)}
                >
                  <RotateCcw className="size-4" /> Replay
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
            {!selected ? (
              <p className="text-muted-foreground py-12 text-center text-sm">
                Select or start a run.
              </p>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>
                  <Badge variant="muted">{selected.channel}</Badge>
                  <Badge variant="muted">{selected.mode}</Badge>
                  {selected.failureReason && (
                    <Badge variant="destructive">{selected.failureReason}</Badge>
                  )}
                </div>
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Input & config snapshot
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
                            aria-label="Copy event"
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
