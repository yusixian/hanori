import { execFile } from "node:child_process";
import { isPlainObject } from "./config/layers.js";

export const FIVE_HOUR_SECONDS = 18_000;
export const WEEK_SECONDS = 604_800;

export interface LodyWindow {
  durationSeconds: number;
  usedPercent: number;
  resetsAt: Date | null;
  label: string | null;
  /** A reset time in the past means the number is stale until the agent runs again. */
  expired: boolean;
  span: "fiveHour" | "week" | "other";
}

export interface LodyLimit {
  key: string;
  providerId: string;
  limitName: string | null;
  planName: string | null;
  windows: LodyWindow[];
}

export interface LodyMachine {
  id: string;
  name: string;
  online: boolean;
  os: string | null;
  cliVersion: string | null;
  limits: LodyLimit[];
}

export interface LodySession {
  id: string;
  title: string | null;
  status: string | null;
  machineId: string | null;
  model: { id: string | null; name: string | null } | null;
  context: { size: number; used: number; percent: number } | null;
  lastMessageAt: Date | null;
  archived: boolean;
}

export type LodyResult<T> =
  | { ok: true; value: T }
  /** `unknown`: the CLI may have acted (timeout, crash, unreadable output); never retry blindly. */
  | { ok: false; reason: "unavailable" | "failed" | "unknown"; message: string };

/** The CLI prints transport log lines before the JSON document on stdout. */
export function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to line scanning
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.trimStart().startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      // keep scanning
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown, now: Date): LodyWindow | null {
  if (!isPlainObject(value)) return null;
  const durationSeconds = asNumber(value.windowDurationSeconds);
  const usedPercent = asNumber(value.usedPercent);
  if (durationSeconds === null || usedPercent === null) return null;
  const resetsAtSeconds = asNumber(value.resetsAtEpochSeconds);
  const resetsAt = resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000);
  return {
    durationSeconds,
    usedPercent,
    resetsAt,
    label: asString(value.label),
    expired: resetsAt === null || resetsAt.getTime() <= now.getTime(),
    span:
      durationSeconds === FIVE_HOUR_SECONDS
        ? "fiveHour"
        : durationSeconds === WEEK_SECONDS
          ? "week"
          : "other",
  };
}

function parseLimits(value: unknown, now: Date): LodyLimit[] {
  if (!isPlainObject(value)) return [];
  const limits: LodyLimit[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const scope = isPlainObject(entry.scope) ? entry.scope : {};
    const windows = Array.isArray(entry.windows)
      ? entry.windows
          .map((window) => parseWindow(window, now))
          .filter((window): window is LodyWindow => window !== null)
          .sort((a, b) => a.durationSeconds - b.durationSeconds)
      : [];
    limits.push({
      key,
      providerId: asString(scope.providerId) ?? key.split("::", 1)[0] ?? key,
      limitName: asString(entry.limitName),
      planName: asString(entry.planName),
      windows,
    });
  }
  return limits.sort((a, b) => a.key.localeCompare(b.key));
}

export function parseMachineList(json: unknown, now: Date): LodyMachine[] {
  if (!isPlainObject(json) || !Array.isArray(json.machines)) {
    throw new Error("lody machine list 输出缺少 machines");
  }
  return json.machines.filter(isPlainObject).map((machine) => ({
    id: asString(machine.id) ?? "",
    name: asString(machine.name) ?? asString(machine.id) ?? "unknown",
    online: machine.online === true || machine.onlineStatus === "online",
    os: asString(machine.os),
    cliVersion: asString(machine.cliVersion),
    // `raceLimits` is what CLI 0.100.0 prints; `rateLimits` is accepted for a future rename.
    limits: parseLimits(machine.raceLimits ?? machine.rateLimits, now),
  }));
}

export function parseSession(json: unknown): LodySession {
  const session = isPlainObject(json) && isPlainObject(json.session) ? json.session : null;
  if (!session) throw new Error("lody session show 输出缺少 session");
  const usage = isPlainObject(session.contextWindowUsage) ? session.contextWindowUsage : null;
  const size = asNumber(usage?.size);
  const used = asNumber(usage?.used);
  const model = isPlainObject(session.lastModel) ? session.lastModel : null;
  const status = isPlainObject(session.status) ? asString(session.status.type) : null;
  return {
    id: asString(session.id) ?? "",
    title: asString(session.title),
    status,
    machineId: asString(session.machineId),
    model: model ? { id: asString(model.modelId), name: asString(model.name) } : null,
    context:
      size && used !== null ? { size, used, percent: Math.round((used / size) * 100) } : null,
    lastMessageAt: epochMs(session.lastMessageAt),
    archived: session.isArchived === true,
  };
}

function epochMs(value: unknown): Date | null {
  const ms = asNumber(value);
  return ms === null ? null : new Date(ms);
}

export interface LodySessionStatus {
  status: string | null;
  running: boolean;
  machineOnline: boolean | null;
  archived: boolean;
}

export function parseSessionStatus(json: unknown): LodySessionStatus {
  if (!isPlainObject(json)) throw new Error("lody session status 输出不是对象");
  const status = isPlainObject(json.status) ? asString(json.status.type) : null;
  const live = isPlainObject(json.liveStatus) ? asString(json.liveStatus.state) : null;
  return {
    status: live ?? status,
    running: (live ?? status) === "running",
    machineOnline: typeof json.machineOnline === "boolean" ? json.machineOnline : null,
    archived: json.archived === true,
  };
}

/** CLI 0.100.0's create output is undocumented; accept the id wherever it appears. */
export function parseCreatedSessionId(json: unknown): string | null {
  if (!isPlainObject(json)) return null;
  const session = isPlainObject(json.session) ? json.session : null;
  return asString(session?.id) ?? asString(json.sessionId) ?? asString(json.id);
}

export function normalizeMachineName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "");
}

export function findMachine(machines: readonly LodyMachine[], ref: string): LodyMachine | null {
  const wanted = normalizeMachineName(ref);
  return (
    machines.find((machine) => machine.id === ref) ??
    machines.find((machine) => normalizeMachineName(machine.name) === wanted) ??
    null
  );
}

export interface QuotaBreach {
  providerId: string;
  limitName: string | null;
  span: "fiveHour" | "week";
  usedPercent: number;
  threshold: number;
}

/** Expired windows carry stale numbers and never trip a guardrail. */
export function quotaBreaches(
  machine: LodyMachine,
  thresholds: { fiveHour: number; week: number },
): QuotaBreach[] {
  const breaches: QuotaBreach[] = [];
  for (const limit of machine.limits) {
    for (const window of limit.windows) {
      if (window.expired || window.span === "other") continue;
      const threshold = thresholds[window.span];
      if (window.usedPercent >= threshold) {
        breaches.push({
          providerId: limit.providerId,
          limitName: window.label ?? limit.limitName,
          span: window.span,
          usedPercent: window.usedPercent,
          threshold,
        });
      }
    }
  }
  return breaches;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; input?: string },
) => Promise<{ stdout: string }>;

/** Prompts travel on stdin (`--prompt-file -`) so owner text never becomes an argv entry. */
const defaultExec: ExecFileLike = (file, args, { input, ...options }) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { ...options, windowsHide: true }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout) }));
      else resolve({ stdout: String(stdout) });
    });
    child.stdin?.end(input ?? "");
  });

export interface CreateSessionInput {
  machine: string;
  localProject: string;
  worktree: boolean;
  agent: string;
  model: string | null;
  title: string;
  prompt: string;
  workspace: string | null;
}

const SESSION_ID = /^[\w-]{1,128}$/;
const CREATE_TIMEOUT_MS = 120_000;

const MACHINE_CACHE_MS = 30_000;

/** Wrapper around the `lody` CLI. Every call is bounded by a timeout and returns a result. */
export class LodyCli {
  private machineCache: { at: number; value: LodyResult<LodyMachine[]> } | null = null;

  constructor(
    private readonly command: readonly string[],
    private readonly timeoutMs: number,
    private readonly exec: ExecFileLike = defaultExec,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async run(
    args: string[],
    options: { input?: string; timeoutMs?: number } = {},
  ): Promise<LodyResult<Record<string, unknown>>> {
    const [file, ...prefix] = this.command;
    if (!file) return { ok: false, reason: "unavailable", message: "未配置 lody CLI" };
    try {
      const { stdout } = await this.exec(file, [...prefix, ...args], {
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        input: options.input,
      });
      const json = extractJson(stdout);
      if (!isPlainObject(json)) return { ok: false, reason: "unknown", message: "输出不是 JSON" };
      if (json.ok === false) {
        return { ok: false, reason: "failed", message: asString(json.error) ?? "lody 返回失败" };
      }
      return { ok: true, value: json };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") {
        return { ok: false, reason: "unavailable", message: `未找到 lody CLI（${file}）` };
      }
      const { killed, signal, stdout } = error as {
        killed?: boolean;
        signal?: string | null;
        stdout?: unknown;
      };
      if (killed || signal)
        return { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" };
      // A non-zero exit is definite only when the CLI explains itself.
      const json = typeof stdout === "string" ? extractJson(stdout) : null;
      const explained = isPlainObject(json) && json.ok === false ? asString(json.error) : null;
      if (explained) return { ok: false, reason: "failed", message: explained };
      return { ok: false, reason: "unknown", message: `lody CLI 失败（${code ?? "exit"}）` };
    }
  }

  async listMachines(): Promise<LodyResult<LodyMachine[]>> {
    const at = this.now().getTime();
    if (this.machineCache && at - this.machineCache.at < MACHINE_CACHE_MS) {
      return this.machineCache.value;
    }
    const result = await this.run(["machine", "list", "--json"]);
    let value: LodyResult<LodyMachine[]>;
    if (!result.ok) value = result;
    else {
      try {
        value = { ok: true, value: parseMachineList(result.value, this.now()) };
      } catch (error) {
        value = { ok: false, reason: "failed", message: (error as Error).message };
      }
    }
    this.machineCache = { at, value };
    return value;
  }

  async showSession(sessionId: string): Promise<LodyResult<LodySession>> {
    return this.parsed(sessionId, ["session", "show", sessionId, "--json"], parseSession);
  }

  async sessionStatus(sessionId: string): Promise<LodyResult<LodySessionStatus>> {
    return this.parsed(sessionId, ["session", "status", sessionId, "--json"], parseSessionStatus);
  }

  async createSession(input: CreateSessionInput): Promise<LodyResult<{ sessionId: string }>> {
    const args = [
      "session",
      "create",
      ...(input.workspace ? ["--workspace", input.workspace] : []),
      "--machine",
      input.machine,
      "--local-project",
      input.localProject,
      ...(input.worktree ? ["--worktree"] : []),
      "--agent",
      input.agent,
      ...(input.model ? ["--model", input.model] : []),
      "--title",
      input.title,
      "--prompt-file",
      "-",
      "--json",
    ];
    const result = await this.run(args, {
      input: input.prompt,
      timeoutMs: Math.max(this.timeoutMs, CREATE_TIMEOUT_MS),
    });
    if (!result.ok) return result;
    const sessionId = parseCreatedSessionId(result.value);
    if (!sessionId || !SESSION_ID.test(sessionId)) {
      return { ok: false, reason: "unknown", message: "输出中没有会话 ID" };
    }
    return { ok: true, value: { sessionId } };
  }

  async chat(sessionId: string, prompt: string): Promise<LodyResult<void>> {
    return this.sessionCommand(
      sessionId,
      ["session", "chat", sessionId, "--prompt-file", "-", "--json"],
      {
        input: prompt,
        timeoutMs: Math.max(this.timeoutMs, CREATE_TIMEOUT_MS),
      },
    );
  }

  async cancelSession(sessionId: string): Promise<LodyResult<void>> {
    return this.sessionCommand(sessionId, ["session", "cancel", sessionId, "--json"]);
  }

  async archiveSession(sessionId: string): Promise<LodyResult<void>> {
    return this.sessionCommand(sessionId, ["session", "archive", sessionId, "--json"]);
  }

  private async sessionCommand(
    sessionId: string,
    args: string[],
    options?: { input?: string; timeoutMs?: number },
  ): Promise<LodyResult<void>> {
    if (!SESSION_ID.test(sessionId)) return invalidSession();
    const result = await this.run(args, options);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  private async parsed<T>(
    sessionId: string,
    args: string[],
    parse: (json: unknown) => T,
  ): Promise<LodyResult<T>> {
    if (!SESSION_ID.test(sessionId)) return invalidSession();
    const result = await this.run(args);
    if (!result.ok) return result;
    try {
      return { ok: true, value: parse(result.value) };
    } catch (error) {
      return { ok: false, reason: "failed", message: (error as Error).message };
    }
  }
}

function invalidSession(): { ok: false; reason: "failed"; message: string } {
  return { ok: false, reason: "failed", message: "会话 ID 格式不正确" };
}
