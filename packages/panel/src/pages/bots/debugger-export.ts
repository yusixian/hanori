import type { TFunction } from "i18next";

interface DebugEventExport {
  sequence: number;
  kind: string;
  level: string;
  data: Record<string, unknown>;
  createdAt: string;
}

interface DebugRunExport {
  id: string;
  source: string;
  channel: string;
  mode: string;
  status: string;
  failureReason: string | null;
  input: Record<string, unknown>;
  configSnapshot: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: string;
  events?: DebugEventExport[];
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

const CODE_FENCE = "````";

export function buildDebugRunMarkdown(run: DebugRunExport, t: TFunction<"botData">) {
  const events = [...(run.events ?? [])].sort((a, b) => a.sequence - b.sequence);
  const summary = {
    runId: run.id,
    status: run.status,
    failureReason: run.failureReason,
    source: run.source,
    channel: run.channel,
    mode: run.mode,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
    eventCount: events.length,
  };
  const eventSections = events.map(
    (event) => `### ${event.sequence}. ${event.kind}

- ${t("debugger.markdown.level")}: ${event.level}
- ${t("debugger.markdown.timestamp")}: ${event.createdAt}

${CODE_FENCE}json
${json(event.data)}
${CODE_FENCE}`,
  );

  return `# ${t("debugger.markdown.title")}

> ${t("debugger.markdown.analysisPrompt")}

## ${t("debugger.markdown.runSummary")}

${CODE_FENCE}json
${json(summary)}
${CODE_FENCE}

## ${t("debugger.markdown.inputSnapshot")}

${CODE_FENCE}json
${json({ input: run.input, config: run.configSnapshot })}
${CODE_FENCE}

## ${t("debugger.markdown.eventTimeline")}

${eventSections.length > 0 ? eventSections.join("\n\n") : t("debugger.markdown.noEvents")}
`;
}

export function debugRunFilename(run: Pick<DebugRunExport, "id" | "createdAt">) {
  const date = new Date(run.createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? "unknown-date"
    : date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return `ai-debug-run-${run.id.slice(0, 8)}-${stamp}.md`;
}

export function downloadDebugRun(run: DebugRunExport, t: TFunction<"botData">) {
  const url = URL.createObjectURL(
    new Blob([buildDebugRunMarkdown(run, t)], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = debugRunFilename(run);
  anchor.click();
  URL.revokeObjectURL(url);
}
