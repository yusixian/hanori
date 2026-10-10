import { StringDecoder } from "node:string_decoder";
import { type ChildProcess, spawn } from "node:child_process";
import { type ExecFileLike, defaultExec } from "./lody.js";

export type TurnStatus = "completed" | "failed" | "canceled" | "timeout";

/** What the bridge POSTs (and the local waiter hands over) when a harness-started turn ends. */
export interface TurnEnd {
  sessionId: string;
  /** Harness-generated correlation; never inferred from timestamps on different machines. */
  turnId?: string;
  command: "create" | "chat";
  status: TurnStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
}

interface EarlyResult {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string;
  spawnError?: string;
}

const BARE_ID = /^(?!-)[\w-]{8,128}$/;
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const HUMAN_ERROR = /^error:\s*(?:\[[^\]]*\]\s*)?(.+?)(?:\s+\{.*\})?$/i;
const MAX_LINE = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const LIFETIME_GRACE_MS = 30_000;
const END_STATUSES = new Set<string>(["failed", "canceled", "timeout"]);
export const DEFAULT_ACCEPT_MS = 20_000;
export const DEFAULT_MAX_WAITERS = 8;

export function waitKind(args: readonly string[]): "create" | "chat" | null {
  if (!args.includes("--wait") || args[0] !== "session") return null;
  return args[1] === "create" || args[1] === "chat" ? args[1] : null;
}

function statusFromError(message: string): TurnStatus {
  if (/cancel/i.test(message)) return "canceled";
  if (/timed out/i.test(message)) return "timeout";
  return "failed";
}

export type SpawnLike = (file: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnLike = (file, args) =>
  spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

/**
 * Same protocol as the bridge's waiter.mjs: `early` settles at acceptance (a create prints its
 * session id; a chat prints its first JSON Lines event or outlives `acceptMs`), at exit, or at
 * `earlyTimeoutMs`, which kills the child. `ended` resolves after an accepted turn exits.
 */
export function startTurn(
  command: readonly string[],
  args: readonly string[],
  options: {
    stdin?: string;
    turnId?: string;
    acceptMs: number;
    earlyTimeoutMs: number;
    spawn?: SpawnLike;
    now?: () => Date;
  },
): { early: Promise<EarlyResult>; ended: Promise<TurnEnd | null> } {
  const kind = waitKind(args)!;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const [file, ...prefix] = command;
  let sessionId: string | null = kind === "chat" ? (args[2] ?? null) : null;
  let accepted = false;
  let abandoned = false;
  let expired = false;
  let lastError: string | null = null;
  let dispatchError: string | null = null;
  let endStatus: TurnStatus | null = null;
  let resolveEarly!: (result: EarlyResult) => void;
  let resolveEnded!: (end: TurnEnd | null) => void;
  const early = new Promise<EarlyResult>((resolve) => (resolveEarly = resolve));
  const ended = new Promise<TurnEnd | null>((resolve) => (resolveEnded = resolve));
  let earlySettled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const answer = (result: EarlyResult) => {
    if (earlySettled) return;
    earlySettled = true;
    timers.splice(0).forEach(clearTimeout);
    resolveEarly(result);
  };
  const accept = () => {
    if (accepted || abandoned) return;
    accepted = true;
    const stdout = JSON.stringify(kind === "create" ? { ok: true, sessionId } : { ok: true });
    answer({ exitCode: 0, signal: null, timedOut: false, stdout });
  };

  const child = (options.spawn ?? defaultSpawn)(file!, [...prefix, ...args]);
  const kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  };
  timers.push(
    setTimeout(() => {
      if (accepted) return;
      abandoned = true;
      answer({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" });
      kill();
    }, options.earlyTimeoutMs),
  );
  if (kind === "chat") timers.push(setTimeout(accept, options.acceptMs));
  const seconds = Number(args[args.indexOf("--timeout") + 1]) || 600;
  const lifetime = setTimeout(
    () => {
      expired = true;
      kill();
    },
    seconds * 1000 + LIFETIME_GRACE_MS,
  );
  lifetime.unref();

  const onLine = (raw: string) => {
    if (raw.length > MAX_LINE) {
      if (kind === "chat" && raw.startsWith('{"type":"update"')) accept();
      return;
    }
    const line = raw.replace(ANSI, "").trim();
    if (!line) return;
    if (kind === "create") {
      if (!sessionId && BARE_ID.test(line)) {
        sessionId = line;
        accept();
        return;
      }
      const error = HUMAN_ERROR.exec(line);
      if (error) lastError = error[1]!.slice(0, 300);
      return;
    }
    if (!line.startsWith("{")) return;
    if (line.startsWith('{"type":"update"')) return accept();
    let event: { type?: unknown; userTurnId?: unknown; code?: unknown; error?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "done") {
      endStatus = "completed";
      accept();
    } else if (event.type === "error") {
      if (typeof event.userTurnId === "string") {
        endStatus = END_STATUSES.has(String(event.code)) ? (event.code as TurnStatus) : "failed";
        accept();
      } else if (typeof event.error === "string") {
        dispatchError = event.error.slice(0, 300);
      }
    }
  };

  const decoder = new StringDecoder("utf8");
  let pending = "";
  let overflow = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    let text = pending + decoder.write(chunk);
    let newline: number;
    while ((newline = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (overflow) overflow = false;
      else onLine(line);
    }
    if (text.length > MAX_LINE) {
      if (!overflow && kind === "chat" && text.startsWith('{"type":"update"')) accept();
      overflow = true;
      text = "";
    }
    pending = text;
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.stdin ?? "");

  let finished = false;
  const finish = (exitCode: number | null, signal: string | null, spawnError: string | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(lifetime);
    pending += decoder.end();
    if (pending && !overflow) onLine(pending);
    pending = "";
    if (!accepted && exitCode === 0 && kind === "chat") accept();
    if (!accepted || !sessionId) {
      if (spawnError) answer({ spawnError });
      else {
        const failure = kind === "create" ? lastError : dispatchError;
        answer({
          exitCode,
          signal,
          stdout: failure ? JSON.stringify({ ok: false, error: failure }) : "",
        });
      }
      resolveEnded(null);
      return;
    }
    const status: TurnStatus = expired
      ? "timeout"
      : (endStatus ??
        (exitCode === 0 ? "completed" : lastError ? statusFromError(lastError) : "failed"));
    resolveEnded({
      sessionId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      command: kind,
      status,
      exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: now().toISOString(),
    });
  };
  child.on("error", (error: NodeJS.ErrnoException) => finish(null, null, error.code ?? "ESPAWN"));
  child.on("close", (exitCode, signal) => finish(exitCode, signal, null));
  return { early, ended };
}

function execError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("lody"), fields);
}

/**
 * The local-CLI counterpart of the bridge: `--wait` commands run through `startTurn` and report
 * their end in-process; everything else, and a full waiter pool (`EWAIT_REFUSED`, so LodyCli
 * re-runs without waiting), behaves like `execFile`.
 */
export function createLocalExec(
  onTurnEnd: (end: TurnEnd) => void,
  options: { maxWaiters?: number; acceptMs?: number; spawn?: SpawnLike } = {},
): ExecFileLike {
  const maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
  let waiters = 0;
  return async (file, argv, execOptions) => {
    // argv still carries the configured command prefix (e.g. `npx -y lody`).
    const at = argv.findIndex((arg, index) => arg === "session" && waitKind(argv.slice(index)));
    if (at === -1) return defaultExec(file, argv, execOptions);
    if (waiters >= maxWaiters) throw execError({ code: "EWAIT_REFUSED" });
    waiters++;
    const turn = startTurn([file, ...argv.slice(0, at)], argv.slice(at), {
      stdin: execOptions.input,
      turnId: execOptions.turnId,
      acceptMs: options.acceptMs ?? DEFAULT_ACCEPT_MS,
      earlyTimeoutMs: execOptions.timeout,
      spawn: options.spawn,
    });
    void turn.ended
      .then((end) => end && onTurnEnd(end))
      .catch(() => {})
      .finally(() => waiters--);
    const result = await turn.early;
    if (result.spawnError) throw execError({ code: result.spawnError });
    const stdout = result.stdout ?? "";
    if (result.timedOut || result.signal) {
      throw execError({ killed: true, signal: result.signal ?? "SIGKILL", stdout });
    }
    if (result.exitCode !== 0) throw execError({ code: result.exitCode ?? "exit", stdout });
    return { stdout };
  };
}
