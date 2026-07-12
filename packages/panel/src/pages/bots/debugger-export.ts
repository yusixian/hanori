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

export function buildDebugRunMarkdown(run: DebugRunExport) {
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

- Level: ${event.level}
- Timestamp: ${event.createdAt}

${CODE_FENCE}json
${json(event.data)}
${CODE_FENCE}`,
  );

  return `# AI Debug Run

> Analyze this run as a chronological diagnostic trace. Identify the first root-cause error, distinguish it from downstream/cascade errors, and cite event sequence numbers. The content was redacted before persistence, but may still contain operational metadata.

## Run summary

${CODE_FENCE}json
${json(summary)}
${CODE_FENCE}

## Input and configuration snapshot

${CODE_FENCE}json
${json({ input: run.input, config: run.configSnapshot })}
${CODE_FENCE}

## Event timeline

${eventSections.length > 0 ? eventSections.join("\n\n") : "No events were recorded."}
`;
}

export function debugRunFilename(run: Pick<DebugRunExport, "id" | "createdAt">) {
  const date = new Date(run.createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? "unknown-date"
    : date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return `ai-debug-run-${run.id.slice(0, 8)}-${stamp}.md`;
}

export function downloadDebugRun(run: DebugRunExport) {
  const url = URL.createObjectURL(
    new Blob([buildDebugRunMarkdown(run)], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = debugRunFilename(run);
  anchor.click();
  URL.revokeObjectURL(url);
}
