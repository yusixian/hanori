import { randomUUID } from "node:crypto";
import type {
  PluginBotState,
  PluginLoginAttempt,
  PluginLoginResult,
  PluginLoginStart,
  PluginLoginState,
} from "@cos-tool-bot/shared";

export interface PluginLoginServiceOptions {
  open(
    pluginId: string,
    botId: string,
    start: PluginLoginStart,
    signal: AbortSignal,
  ): Promise<{
    attempt: PluginLoginAttempt;
    /** Host must check cancellation and revisions atomically before persisting credentials. */
    commit(secrets: Record<string, string>, signal: AbortSignal): Promise<PluginBotState>;
    assertCurrent(): Promise<void>;
  }>;
  now?(): number;
}

export class PluginLoginError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "session_limit" | "login_closed") {
    super(code);
    this.name = "PluginLoginError";
  }
}

type OpenedLogin = Awaited<ReturnType<PluginLoginServiceOptions["open"]>>;
interface LoginSession {
  id: string;
  owner: string;
  pluginId: string;
  botId: string;
  expiresAt: number;
  status: PluginLoginState["status"];
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  opened?: OpenedLogin;
  qrUrl?: string;
  account?: { name: string };
  botState?: PluginBotState;
  lastPollAt?: number;
  polling?: Promise<PluginLoginState>;
  saving?: Promise<void>;
}

const SESSION_MS = 5 * 60_000;
const POLL_MS = 2_000;
const MAX_SESSIONS = 32;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SECRET_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const ACTIVE = new Set<PluginLoginState["status"]>(["waiting", "scanned"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return false;
  for (const char of value)
    if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) return false;
  return true;
}
function conflict(error: unknown) {
  return record(error) && (error.code === "stale_revision" || error.code === "manifest_changed");
}
function qrUrl(value: unknown): string {
  if (!text(value, 4096) || /[\s\\]/u.test(value)) throw new PluginLoginError("invalid_request");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.length > 4096
  )
    throw new PluginLoginError("invalid_request");
  return url.href;
}
function credentials(value: unknown): Record<string, string> {
  if (!record(value)) throw new PluginLoginError("invalid_request");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 64) throw new PluginLoginError("invalid_request");
  let chars = 0;
  for (const [key, secret] of entries) {
    if (!SECRET_KEY.test(key) || RESERVED.has(key) || !text(secret, 16_384))
      throw new PluginLoginError("invalid_request");
    chars += key.length + secret.length;
    if (chars > 65_536) throw new PluginLoginError("invalid_request");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** The host supplies an already-public configuration. Project it again, excluding new secrets. */
function publicBotState(state: PluginBotState, secrets: Record<string, string>): PluginBotState {
  const secretValues = new Set(Object.values(secrets));
  const values = Object.fromEntries(
    Object.entries(state.configuration.values).filter(
      ([key, value]) =>
        !Object.hasOwn(secrets, key) &&
        ((typeof value === "string" && value.length <= 16_384 && !secretValues.has(value)) ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))),
    ),
  );
  if (
    Object.keys(values).length > 64 ||
    state.configuration.configuredSecrets.length > 64 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !text(state.manifestHash, 64) ||
    (state.configuredVersion !== null && !text(state.configuredVersion, 64)) ||
    (state.updatedAt !== null && !text(state.updatedAt, 64)) ||
    typeof state.enabled !== "boolean" ||
    typeof state.needsReview !== "boolean" ||
    !["disabled", "ready", "needs_review", "error"].includes(state.runtime.status) ||
    state.configuration.configuredSecrets.some((key) => !SECRET_KEY.test(key) || RESERVED.has(key))
  )
    throw new PluginLoginError("invalid_request");
  return {
    configuration: { values, configuredSecrets: [...state.configuration.configuredSecrets] },
    revision: state.revision,
    manifestHash: state.manifestHash,
    configuredVersion: state.configuredVersion,
    enabled: state.enabled,
    needsReview: state.needsReview,
    updatedAt: state.updatedAt,
    runtime: {
      status: state.runtime.status,
      error: state.runtime.error === null ? null : "plugin_failed",
    },
  };
}

/** Ephemeral, single-process login state. A restart deliberately requires a fresh QR scan. */
export class PluginLoginService {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly disposed = new WeakSet<PluginLoginAttempt>();
  private readonly cleanups = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly options: PluginLoginServiceOptions) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }
  private active(session: LoginSession) {
    if (ACTIVE.has(session.status) && this.now() >= session.expiresAt)
      this.finish(session, "expired");
    return ACTIVE.has(session.status) && !session.controller.signal.aborted;
  }
  private state(session: LoginSession): PluginLoginState {
    return {
      id: session.id,
      status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(ACTIVE.has(session.status) && session.qrUrl ? { qrUrl: session.qrUrl } : {}),
      ...(session.account ? { account: { ...session.account } } : {}),
      ...(session.botState ? { botState: structuredClone(session.botState) } : {}),
    };
  }
  private dispose(attempt: PluginLoginAttempt) {
    if (!record(attempt)) return;
    if (this.disposed.has(attempt)) return;
    this.disposed.add(attempt);
    const cleanup = this.call(
      async () => {
        await attempt.dispose?.();
      },
      new AbortController().signal,
      5_000,
    ).catch(() => undefined);
    this.cleanups.add(cleanup);
    void cleanup.then(() => this.cleanups.delete(cleanup));
  }
  private finish(session: LoginSession, status: PluginLoginState["status"]) {
    if (
      !ACTIVE.has(session.status) &&
      !(session.status === "saving" && ["connected", "conflict", "save_unknown"].includes(status))
    )
      return;
    session.status = status;
    session.qrUrl = undefined;
    session.controller.abort();
    if (session.opened) this.dispose(session.opened.attempt);
    session.opened = undefined;
    if (this.now() >= session.expiresAt) {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => this.remove(session), 60_000);
      session.timer.unref();
    }
  }
  private remove(session: LoginSession) {
    clearTimeout(session.timer);
    this.sessions.delete(session.id);
  }
  private validate(owner: string, pluginId: string, botId: string) {
    if (
      !text(owner, 512) ||
      !text(pluginId, 100) ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(pluginId) ||
      !UUID.test(botId)
    )
      throw new PluginLoginError("invalid_request");
  }
  private find(owner: string, pluginId: string, botId: string, id: string) {
    this.validate(owner, pluginId, botId);
    const session = this.sessions.get(id);
    if (
      !session ||
      session.owner !== owner ||
      session.pluginId !== pluginId ||
      session.botId !== botId
    )
      throw new PluginLoginError("not_found");
    this.active(session);
    return session;
  }
  private call<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent: AbortSignal,
    ms = 15_000,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ms);
    timer.unref();
    const signal = AbortSignal.any([parent, timeout.signal]);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        done();
        reject(new PluginLoginError("login_closed"));
      };
      const done = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation(signal);
        })
        .then(
          (value) => {
            done();
            if (signal.aborted) abort();
            else resolve(value);
          },
          (error) => {
            done();
            reject(error);
          },
        );
    }).finally(() => clearTimeout(timer));
  }

  async start(
    owner: string,
    pluginId: string,
    botId: string,
    start: PluginLoginStart,
  ): Promise<PluginLoginState> {
    this.validate(owner, pluginId, botId);
    if (this.closed) throw new PluginLoginError("login_closed");
    if (
      !start ||
      !Number.isSafeInteger(start.expectedRevision) ||
      start.expectedRevision < 0 ||
      !/^[a-f0-9]{64}$/i.test(start.manifestHash)
    )
      throw new PluginLoginError("invalid_request");
    const request = { expectedRevision: start.expectedRevision, manifestHash: start.manifestHash };
    for (const previous of this.sessions.values()) {
      this.active(previous);
      if (previous.owner === owner && previous.pluginId === pluginId && previous.botId === botId) {
        if (previous.status === "saving") return this.state(previous);
        this.finish(previous, "cancelled");
        this.remove(previous);
      } else if (!ACTIVE.has(previous.status) && previous.status !== "saving")
        this.remove(previous);
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new PluginLoginError("session_limit");
    const session: LoginSession = {
      id: randomUUID(),
      owner,
      pluginId,
      botId,
      expiresAt: this.now() + SESSION_MS,
      status: "waiting",
      controller: new AbortController(),
    };
    // Reserve synchronously so concurrent starts/invalidation include an opening provider attempt.
    this.sessions.set(session.id, session);
    session.timer = setTimeout(() => {
      if (ACTIVE.has(session.status)) {
        this.finish(session, "expired");
      } else if (session.status !== "saving") this.remove(session);
    }, SESSION_MS);
    session.timer.unref();
    try {
      const opened = await this.call(async (signal) => {
        // The attempt retains this lifetime signal; the open deadline must not expire a live QR.
        const value = await this.options.open(pluginId, botId, request, session.controller.signal);
        if (signal.aborted || !this.active(session)) {
          this.dispose(value.attempt);
          throw new PluginLoginError("login_closed");
        }
        session.opened = value;
        return value;
      }, session.controller.signal);
      if (!this.active(session)) return this.state(session);
      if (
        !opened.attempt ||
        typeof opened.attempt.poll !== "function" ||
        (opened.attempt.dispose !== undefined && typeof opened.attempt.dispose !== "function") ||
        typeof opened.commit !== "function" ||
        typeof opened.assertCurrent !== "function"
      )
        throw new PluginLoginError("invalid_request");
      session.qrUrl = qrUrl(opened.attempt.qrUrl);
      await this.call(() => opened.assertCurrent(), session.controller.signal);
      this.active(session);
    } catch (error) {
      this.finish(session, conflict(error) ? "conflict" : "failed");
    }
    return this.state(session);
  }

  async poll(
    owner: string,
    pluginId: string,
    botId: string,
    id: string,
  ): Promise<PluginLoginState> {
    const session = this.find(owner, pluginId, botId, id);
    if (!this.active(session) || !session.opened) return this.state(session);
    if (session.polling) return session.polling;
    if (session.lastPollAt !== undefined && this.now() - session.lastPollAt < POLL_MS)
      return this.state(session);
    session.lastPollAt = this.now();
    const opened = session.opened;
    session.polling = (async () => {
      try {
        await this.call(() => opened.assertCurrent(), session.controller.signal);
        if (!this.active(session)) return this.state(session);
        const result: PluginLoginResult = await this.call(
          (signal) => opened.attempt.poll(signal),
          session.controller.signal,
        );
        if (!this.active(session)) return this.state(session);
        if (!record(result)) throw new PluginLoginError("invalid_request");
        if (result.status === "expired") this.finish(session, "expired");
        else if (result.status === "waiting" || result.status === "scanned") {
          await this.call(() => opened.assertCurrent(), session.controller.signal);
          if (this.active(session)) session.status = result.status;
        } else if (result.status === "authorized") {
          const secrets = credentials(result.secrets);
          if (!record(result.account) || !text(result.account.name, 128))
            throw new PluginLoginError("invalid_request");
          const name = result.account.name.trim();
          if (Object.values(secrets).includes(name)) throw new PluginLoginError("invalid_request");
          await this.call(() => opened.assertCurrent(), session.controller.signal);
          if (!this.active(session)) return this.state(session);
          // COMMIT may outlive cancellation. Once saving begins, only the host can confirm its result.
          session.status = "saving";
          session.qrUrl = undefined;
          session.saving = this.save(session, opened, secrets, name);
        } else throw new PluginLoginError("invalid_request");
      } catch (error) {
        this.finish(session, conflict(error) ? "conflict" : "failed");
      }
      return this.state(session);
    })();
    try {
      return await session.polling;
    } finally {
      session.polling = undefined;
    }
  }

  private async save(
    session: LoginSession,
    opened: OpenedLogin,
    secrets: Record<string, string>,
    name: string,
  ): Promise<void> {
    try {
      const saved = await this.call(
        (signal) => opened.commit(secrets, signal),
        session.controller.signal,
      );
      session.botState = publicBotState(saved, secrets);
      session.account = { name };
      this.finish(session, "connected");
    } catch (error) {
      this.finish(session, conflict(error) ? "conflict" : "save_unknown");
    } finally {
      session.saving = undefined;
    }
  }

  async cancel(
    owner: string,
    pluginId: string,
    botId: string,
    id: string,
  ): Promise<PluginLoginState> {
    const session = this.find(owner, pluginId, botId, id);
    this.finish(session, "cancelled");
    return this.state(session);
  }
  invalidate(pluginId: string, botId?: string): void {
    for (const session of this.sessions.values())
      if (
        session.status !== "saving" &&
        session.pluginId === pluginId &&
        (botId === undefined || session.botId === botId)
      )
        this.finish(session, "conflict");
  }
  async close(): Promise<void> {
    this.closed = true;
    const saving: LoginSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === "saving") {
        saving.push(session);
        continue;
      }
      this.finish(session, "cancelled");
      this.remove(session);
    }
    await Promise.allSettled(saving.map((session) => session.saving));
    for (const session of saving) this.remove(session);
    await Promise.allSettled(this.cleanups);
  }
}
