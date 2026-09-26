// Runs a `session create|chat --wait` child so the caller gets an answer as soon as Lody accepted
// the turn, while the child keeps waiting for the turn to finish. Only the session id, the event
// type, and short CLI error lines are read from stdout; transcript text is discarded unread.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const BARE_ID = /^(?!-)[\w-]{8,128}$/;
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const HUMAN_ERROR = /^error:\s*(?:\[[^\]]*\]\s*)?(.+?)(?:\s+\{.*\})?$/i;
const MAX_LINE = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const LIFETIME_GRACE_MS = 30_000;
const END_STATUSES = new Set(["failed", "canceled", "timeout"]);

/** @param {string[]} args */
export function waitKind(args) {
  if (!args.includes("--wait")) return null;
  return args[0] === "session" && (args[1] === "create" || args[1] === "chat") ? args[1] : null;
}

function waitSeconds(args) {
  const value = Number(args[args.indexOf("--timeout") + 1]);
  return Number.isFinite(value) && value > 0 ? value : 600;
}

function statusFromError(message) {
  if (/cancel/i.test(message)) return "canceled";
  if (/timed out/i.test(message)) return "timeout";
  return "failed";
}

/**
 * `early` settles once: at acceptance (a create prints the session id; a chat prints its first
 * JSON Lines event or outlives `acceptMs`), at exit, or when `earlyTimeoutMs` passes, which
 * kills the child like any other timed-out command. `ended` resolves after an accepted turn
 * exits, and to null when the turn was never accepted.
 *
 * @param {string[]} command
 * @param {string[]} args
 * @param {{ stdin?: string; turnId?: string; env: NodeJS.ProcessEnv; acceptMs: number; earlyTimeoutMs: number; now?: () => Date }} options
 */
export function startTurn(command, args, options) {
  const kind = waitKind(args);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const [file, ...prefix] = command;
  let sessionId = kind === "chat" ? args[2] : null;
  let accepted = false;
  let lastError = null;
  let dispatchError = null;
  let endStatus = null;
  let expired = false;
  let abandoned = false;
  let resolveEarly;
  let resolveEnded;
  const early = new Promise((resolve) => (resolveEarly = resolve));
  const ended = new Promise((resolve) => (resolveEnded = resolve));
  let earlySettled = false;
  const answer = (result) => {
    if (earlySettled) return;
    earlySettled = true;
    clearTimeout(earlyTimer);
    clearTimeout(acceptTimer);
    resolveEarly(result);
  };
  const accept = () => {
    if (accepted || abandoned) return;
    accepted = true;
    const stdout = JSON.stringify(kind === "create" ? { ok: true, sessionId } : { ok: true });
    answer({ exitCode: 0, signal: null, timedOut: false, truncated: false, stdout, waiting: true });
  };

  const child = spawn(file, [...prefix, ...args], {
    stdio: ["pipe", "pipe", "ignore"],
    env: options.env,
  });
  const kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const earlyTimer = setTimeout(() => {
    if (accepted) return;
    abandoned = true;
    answer({ exitCode: null, signal: "SIGTERM", timedOut: true, truncated: false, stdout: "" });
    kill();
  }, options.earlyTimeoutMs);
  const acceptTimer = kind === "chat" ? setTimeout(accept, options.acceptMs) : undefined;
  const lifetime = setTimeout(
    () => {
      expired = true;
      kill();
    },
    waitSeconds(args) * 1000 + LIFETIME_GRACE_MS,
  );
  lifetime.unref();

  const onLine = (raw) => {
    const line = raw.replace(ANSI, "").trim();
    if (!line) return;
    if (kind === "create") {
      if (!sessionId && BARE_ID.test(line)) {
        sessionId = line;
        accept();
        return;
      }
      const error = HUMAN_ERROR.exec(line);
      if (error) lastError = error[1].slice(0, 300);
      return;
    }
    if (!line.startsWith("{")) return;
    if (line.startsWith('{"type":"update"')) {
      accept();
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event?.type === "done") {
      endStatus = "completed";
      accept();
    } else if (event?.type === "error") {
      if (typeof event.userTurnId === "string") {
        endStatus = END_STATUSES.has(event.code) ? event.code : "failed";
        accept();
      } else if (typeof event.error === "string") {
        dispatchError = event.error.slice(0, 300);
      }
    }
  };

  let pending = "";
  let overflow = false;
  child.stdout.on("data", (chunk) => {
    let text = pending + chunk.toString("utf8");
    let newline;
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
  child.stdin.on("error", () => {});
  child.stdin.end(options.stdin ?? "");

  let finished = false;
  const finish = (exitCode, signal, spawnError) => {
    if (finished) return;
    finished = true;
    clearTimeout(lifetime);
    if (pending && !overflow) onLine(pending);
    pending = "";
    if (!accepted && exitCode === 0 && kind === "chat") accept();
    if (!accepted) {
      if (spawnError) {
        answer({ spawnError });
      } else {
        const failure = kind === "create" ? lastError : dispatchError;
        const stdout = failure ? JSON.stringify({ ok: false, error: failure }) : "";
        answer({ exitCode, signal, timedOut: false, truncated: false, stdout });
      }
      resolveEnded(null);
      return;
    }
    const status = expired
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
  child.on("error", (error) => finish(null, null, error.code ?? "ESPAWN"));
  child.on("close", (exitCode, signal) => finish(exitCode, signal, null));
  return { early, ended };
}

export const DEFAULT_CALLBACK_URL = "http://app:3000/api/harness/lody/turn";
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const CALLBACK_TIMEOUT_MS = 10_000;

/** `sha256=` + hex HMAC of `<timestamp>.<body>` with the shared bridge secret. */
export function signTurnEnd(secret, timestamp, body) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * POSTs one turn end to the app. Network errors, 408/429, and 5xx are retried after each delay;
 * any other answer ends delivery. Returns the attempt count and whether the app accepted it.
 */
export async function deliverTurnEnd(end, options) {
  const {
    url,
    secret,
    fetchImpl = fetch,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const body = JSON.stringify(end);
  for (let attempt = 1; ; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    let status = 0;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harness-timestamp": timestamp,
          "x-harness-signature": signTurnEnd(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch {
      status = 0;
    }
    const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    if (!retryable) return { attempts: attempt, delivered: status >= 200 && status < 300, status };
    const delay = retryDelaysMs[attempt - 1];
    if (delay === undefined) return { attempts: attempt, delivered: false, status };
    await sleep(delay);
  }
}
