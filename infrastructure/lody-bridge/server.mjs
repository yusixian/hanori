// Dependency-free HTTP bridge that lets the harness run allowlisted `lody` commands in a
// glibc sidecar with a local Lody daemon. Logs carry only the subcommand, exit status, and
// duration: never argv values, stdin (prompts), tokens, or stdout.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { checkArgs } from "./allowlist.mjs";
import { DEFAULT_CALLBACK_URL, deliverTurnEnd, startTurn } from "./waiter.mjs";
import { createRuntime, RuntimeError } from "./runtime.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TIMEOUT_MS = 180_000;
const MIN_SECRET_LENGTH = 32;
const KILL_GRACE_MS = 2_000;
const DEFAULT_WATCH_MS = 60_000;
const DEFAULT_MAX_WAITERS = 8;
/** A chat prints nothing until the agent streams; still running after this means Lody took it. */
const DEFAULT_ACCEPT_MS = 20_000;

function childEnv() {
  return { ...process.env, LODY_CLI_TOKEN: undefined, HARNESS_LODY_BRIDGE_SECRET: undefined };
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

/** Compares fixed-length digests so neither content nor length leaks through timing. */
export function authorized(header, secret) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Runs one command. The result mirrors what `execFile` would report so the harness keeps one
 * classification: exit code, signal, timeout, output overflow, or a spawn error code.
 */
export function runLody(command, args, { stdin, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const [file, ...prefix] = typeof command === "function" ? command() : command;
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const child = spawn(file, [...prefix, ...args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: childEnv(),
    });
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        truncated = true;
        kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ spawnError: error.code ?? "ESPAWN" }));
    child.on("close", (exitCode, signal) =>
      finish({ exitCode, signal, timedOut, truncated, stdout: truncated ? "" : stdout }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

/** Exit code only; stdio is ignored so a detached daemon cannot hold a pipe open. */
function runQuiet(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const [file, ...prefix] = typeof command === "function" ? command() : command;
    const child = spawn(file, [...prefix, ...args], { stdio: "ignore", env: childEnv() });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Restarts the daemon when `lody daemon status` says it is gone. `daemon start` reuses the login
 * saved in ~/.lody, so the watchdog never needs the CLI token. Logs only state transitions.
 */
export function watchDaemon({
  command,
  machineName,
  intervalMs = DEFAULT_WATCH_MS,
  log,
  paused = () => false,
}) {
  const state = { daemon: "unknown" };
  let busy = false;
  const idleWaiters = [];
  const set = (next, line) => {
    if (state.daemon !== next) log(line);
    state.daemon = next;
  };
  const tick = async () => {
    if (busy || paused()) return;
    busy = true;
    try {
      if ((await runQuiet(command, ["daemon", "status"], 20_000)) === 0) {
        set("running", "lody-bridge: daemon running");
        return;
      }
      if (paused()) return;
      const started = await runQuiet(
        command,
        ["daemon", "start", "--machine-name", machineName],
        120_000,
      );
      if (started === 0) {
        log("lody-bridge: daemon was down and has been restarted");
        state.daemon = "running";
      } else {
        set("down", "lody-bridge: daemon is down and restart failed; retrying");
      }
    } finally {
      busy = false;
      idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  };
  const timer = intervalMs > 0 ? setInterval(tick, intervalMs) : null;
  timer?.unref();
  return {
    state,
    tick,
    idle: () => (busy ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve()),
    stop: () => timer && clearInterval(timer),
  };
}

export function createBridgeServer(options) {
  const {
    secret,
    command = ["lody"],
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    daemon = null,
    log = (line) => process.stdout.write(`${line}\n`),
    callbackUrl = DEFAULT_CALLBACK_URL,
    maxWaiters = DEFAULT_MAX_WAITERS,
    acceptMs = DEFAULT_ACCEPT_MS,
    deliver = deliverTurnEnd,
    runtime = null,
  } = options;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`HARNESS_LODY_BRIDGE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!/^https?:\/\//.test(callbackUrl)) {
    throw new Error("HARNESS_LODY_CALLBACK_URL must be an http(s) URL");
  }
  let version = null;
  let waiters = 0;
  let executions = 0;

  /** Answers at acceptance; the child keeps running and its end is POSTed to the app. */
  const runWaiting = (args, stdin, timeoutMs, checked, turnId) => {
    waiters++;
    const started = Date.now();
    const turn = startTurn(typeof command === "function" ? command() : command, args, {
      stdin,
      turnId,
      env: childEnv(),
      acceptMs,
      earlyTimeoutMs: timeoutMs,
    });
    void turn.ended
      .then(async (end) => {
        if (!end) return;
        const outcome = await deliver(end, { url: callbackUrl, secret });
        log(
          `lody-bridge: ${checked.command} turn ${end.status} in ${Date.now() - started}ms; callback ${
            outcome.delivered ? "delivered" : `failed (${outcome.status || "network"})`
          } after ${outcome.attempts} attempt(s)`,
        );
      })
      .catch(() => log(`lody-bridge: ${checked.command} turn callback crashed`))
      .finally(() => {
        waiters--;
      });
    return turn.early;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    if (req.method === "GET" && url.pathname === "/health") {
      version = await runLody(command, ["--version"], {
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
      }).then((result) => (result.exitCode === 0 ? result.stdout.trim().slice(0, 40) : null));
      const state = daemon?.daemon;
      if (state === "down") send(res, 503, { ok: false, lody: version, daemon: state });
      else send(res, 200, { ok: true, lody: version, ...(state ? { daemon: state } : {}) });
      return;
    }
    const runtimeRequest = url.pathname === "/runtime" && ["GET", "POST"].includes(req.method);
    if (!runtimeRequest && (req.method !== "POST" || url.pathname !== "/exec")) {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (!authorized(req.headers.authorization, secret)) {
      log("lody-bridge: rejected unauthenticated request");
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (runtimeRequest) {
      if (!runtime) {
        send(res, 503, {
          ok: false,
          code: "lody_unavailable",
          error: "此 bridge 不支持 CLI 更新。",
        });
        return;
      }
      if (req.method === "POST" && (waiters > 0 || executions > 0 || runtime.updating)) {
        send(res, 409, {
          ok: false,
          code: "conflict",
          error: "Lody 正在执行命令或更新，请稍后重试。",
        });
        return;
      }
      try {
        const result = req.method === "GET" ? await runtime.status() : await runtime.update();
        if (req.method === "POST" && result.updated && daemon) daemon.daemon = "running";
        log(`lody-bridge: runtime ${req.method === "GET" ? "status" : "update"} -> ok`);
        send(res, 200, { ok: true, runtime: result });
      } catch (error) {
        const code = error instanceof RuntimeError ? error.code : "lody_unavailable";
        log(`lody-bridge: runtime update -> ${code}`);
        send(res, code === "conflict" ? 409 : 503, {
          ok: false,
          code,
          error: error instanceof RuntimeError ? error.message : "Lody CLI 更新失败。",
        });
      }
      return;
    }
    if (runtime?.updating) {
      send(res, 409, { ok: false, error: "Lody CLI 正在更新，请稍后重试。" });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      send(res, error.status ?? 400, { ok: false, error: "invalid body" });
      return;
    }
    const checked = checkArgs(body?.args);
    if (!checked.ok) {
      log(`lody-bridge: rejected args (${checked.error})`);
      send(res, 400, { ok: false, error: checked.error });
      return;
    }
    const stdin = typeof body.stdin === "string" ? body.stdin : undefined;
    const turnId = body.turnId;
    if (turnId !== undefined && (typeof turnId !== "string" || !/^[\w-]{1,128}$/.test(turnId))) {
      send(res, 400, { ok: false, error: "invalid turnId" });
      return;
    }
    if (
      stdin !== undefined &&
      (!checked.readsStdin || Buffer.byteLength(stdin) > MAX_STDIN_BYTES)
    ) {
      send(res, 400, { ok: false, error: "stdin only with --prompt-file - and at most 256 KiB" });
      return;
    }
    const requested = Number(body.timeoutMs);
    const timeoutMs = Math.min(
      maxTimeoutMs,
      Math.max(1_000, Number.isFinite(requested) ? requested : maxTimeoutMs),
    );
    if (checked.waits && waiters >= maxWaiters) {
      log(`lody-bridge: rejected ${checked.command} --wait (${waiters} turns already waiting)`);
      send(res, 429, { ok: false, error: "too many waiting turns" });
      return;
    }
    const started = Date.now();
    if (runtime?.updating) {
      send(res, 409, { ok: false, error: "Lody CLI 正在更新，请稍后重试。" });
      return;
    }
    executions++;
    let result;
    try {
      result = checked.waits
        ? await runWaiting(body.args, stdin, timeoutMs, checked, turnId)
        : await runLody(command, body.args, { stdin, timeoutMs, maxOutputBytes });
    } finally {
      executions--;
    }
    if (checked.command === "agent-config list" && typeof result.stdout === "string") {
      result.stdout = redactAgentConfigs(result.stdout);
    }
    if (checked.command === "session history" && typeof result.stdout === "string") {
      result.stdout = trimHistory(result.stdout);
    }
    log(
      `lody-bridge: ${checked.command} -> ${
        result.spawnError ??
        (result.waiting
          ? "accepted, waiting"
          : result.timedOut
            ? "timeout"
            : (result.signal ?? result.exitCode))
      } in ${Date.now() - started}ms`,
    );
    send(res, 200, result);
  });
}

const AGENT_CONFIG_FIELDS = ["id", "name", "agentType", "machineId"];

/** The CLI prints transport log lines before the JSON document. */
function parseJsonOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trimStart().startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * `agent-config list` includes each config's `env`, which may hold API keys. Only the fields the
 * harness reads leave the sidecar; anything unparseable is replaced rather than passed through.
 */
export function redactAgentConfigs(stdout) {
  const json = parseJsonOutput(stdout);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return JSON.stringify({ ok: false, error: "unreadable agent-config output" });
  }
  if (!Array.isArray(json.agentConfigs)) {
    return JSON.stringify({
      ok: json.ok === true,
      error: typeof json.error === "string" ? json.error : undefined,
    });
  }
  return JSON.stringify({
    ok: json.ok !== false,
    ...(typeof json.hasMore === "boolean" ? { hasMore: json.hasMore } : {}),
    ...(typeof json.nextCursor === "string" ? { nextCursor: json.nextCursor } : {}),
    agentConfigs: json.agentConfigs
      .filter((config) => config && typeof config === "object")
      .map((config) => ({
        ...Object.fromEntries(
          AGENT_CONFIG_FIELDS.filter((key) => key in config).map((key) => [key, config[key]]),
        ),
        ...(config.runConfig && Array.isArray(config.runConfig.models)
          ? {
              runConfig: {
                models: config.runConfig.models
                  .filter(
                    (model) => model && typeof model.id === "string" && model.id.length <= 120,
                  )
                  .slice(0, 500)
                  .map((model) => ({
                    id: model.id,
                    name: typeof model.name === "string" ? model.name.slice(0, 200) : model.id,
                    reasoningEffortValues: (Array.isArray(model.reasoningEffortValues)
                      ? model.reasoningEffortValues
                      : Array.isArray(config.runConfig.reasoningEffortValues)
                        ? config.runConfig.reasoningEffortValues
                        : []
                    )
                      .filter((effort) => typeof effort === "string" && effort.length <= 32)
                      .slice(0, 20),
                  })),
              },
            }
          : {}),
      })),
  });
}

const HISTORY_FIELDS = ["index", "role", "timestamp"];
const HISTORY_TEXT_LIMIT = 4000;

/** Only what the harness reads leaves the sidecar: role, time, and the start of each turn. */
export function trimHistory(stdout) {
  const json = parseJsonOutput(stdout);
  if (!json || typeof json !== "object" || !Array.isArray(json.entries)) {
    return JSON.stringify({
      ok: false,
      error: typeof json?.error === "string" ? json.error : "unreadable session history output",
    });
  }
  return JSON.stringify({
    ok: json.ok !== false,
    entries: json.entries
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        ...Object.fromEntries(
          HISTORY_FIELDS.filter((key) => key in entry).map((key) => [key, entry[key]]),
        ),
        text: typeof entry.text === "string" ? entry.text.slice(0, HISTORY_TEXT_LIMIT) : null,
      })),
  });
}

function commandFromEnv(value) {
  if (!value) return ["lody"];
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((s) => typeof s === "string")
  ) {
    throw new Error("LODY_BRIDGE_COMMAND must be a JSON array of strings");
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.LODY_BRIDGE_PORT ?? 43190);
  const machineName = process.env.LODY_MACHINE_NAME || "cos-tool-bot-server";
  let watch;
  const runtime = createRuntime({
    machineName,
    fallback: commandFromEnv(process.env.LODY_BRIDGE_COMMAND),
    beforeUpdate: () => watch?.idle(),
  });
  const command = runtime.command;
  watch = watchDaemon({
    command,
    machineName,
    paused: () => runtime.updating,
    intervalMs: Number(process.env.LODY_DAEMON_WATCH_MS ?? DEFAULT_WATCH_MS),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const server = createBridgeServer({
    secret: process.env.HARNESS_LODY_BRIDGE_SECRET,
    command,
    daemon: watch.state,
    runtime,
    callbackUrl: process.env.HARNESS_LODY_CALLBACK_URL || DEFAULT_CALLBACK_URL,
    maxWaiters: Number(process.env.LODY_BRIDGE_MAX_WAITERS || DEFAULT_MAX_WAITERS),
  });
  delete process.env.HARNESS_LODY_BRIDGE_SECRET;
  void watch.tick();
  server.listen(port, "0.0.0.0", () => process.stdout.write(`lody-bridge: listening on ${port}\n`));
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
