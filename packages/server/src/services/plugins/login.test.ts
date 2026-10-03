import { randomUUID } from "node:crypto";
import type { PluginBotState, PluginLoginResult } from "@cos-tool-bot/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLoginService, type PluginLoginServiceOptions } from "./login.js";

const BOT = randomUUID();
const PLUGIN = "hanori.bilibili";
const OWNER = "synthetic-auth-session:42:org";
const START = { expectedRevision: 7, manifestHash: "a".repeat(64) };
const TOKEN = "synthetic-private-cookie";
const AUTHORIZED: PluginLoginResult = {
  status: "authorized",
  secrets: { cookie: TOKEN },
  account: { name: "Synthetic account" },
};
const services: PluginLoginService[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function botState(): PluginBotState {
  return {
    configuration: { values: { model: "synthetic" }, configuredSecrets: ["cookie"] },
    revision: 8,
    manifestHash: START.manifestHash,
    configuredVersion: "1.0.0",
    enabled: true,
    needsReview: false,
    updatedAt: "2030-01-01T00:00:00.000Z",
    runtime: { status: "ready", error: null },
  };
}
function fixture() {
  const attempt = {
    qrUrl: "https://passport.example/qr?code=synthetic-session",
    poll: vi.fn<(signal: AbortSignal) => Promise<PluginLoginResult>>(async () => ({
      status: "waiting",
    })),
    dispose: vi.fn(async () => {}),
  };
  const commit = vi.fn<Awaited<ReturnType<PluginLoginServiceOptions["open"]>>["commit"]>(async () =>
    botState(),
  );
  const assertCurrent = vi.fn(async () => {});
  const opened = { attempt, commit, assertCurrent };
  const open = vi.fn<PluginLoginServiceOptions["open"]>(async () => opened);
  const reportError = vi.fn<NonNullable<PluginLoginServiceOptions["reportError"]>>();
  const service = new PluginLoginService({ open, reportError });
  services.push(service);
  const start = () => service.start(OWNER, PLUGIN, BOT, START);
  const poll = (id: string) => service.poll(OWNER, PLUGIN, BOT, id);
  const settled = async (id: string) => {
    await poll(id);
    await flush();
    return poll(id);
  };
  const cancel = (id: string) => service.cancel(OWNER, PLUGIN, BOT, id);
  return {
    service,
    attempt,
    commit,
    assertCurrent,
    opened,
    open,
    reportError,
    start,
    poll,
    settled,
    cancel,
  };
}

beforeEach(() => vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z") }));
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.useRealTimers();
});

describe("isolated plugin QR login coordinator", () => {
  it.each(["start", "poll", "save"] as const)(
    "reports only a safe code and correlation fields for %s failures",
    async (phase) => {
      const f = fixture();
      const error = Object.assign(new Error(TOKEN), {
        code: "invalid_response",
        url: `https://passport.example/?ticket=${TOKEN}`,
        cookie: TOKEN,
      });
      let state;
      if (phase === "start") {
        f.open.mockRejectedValue(error);
        state = await f.start();
      } else {
        state = await f.start();
        if (phase === "poll") f.attempt.poll.mockRejectedValue(error);
        else {
          f.attempt.poll.mockResolvedValue(AUTHORIZED);
          f.commit.mockRejectedValue(error);
        }
        state = await f.settled(state.id);
      }
      expect(state.status).toBe(phase === "save" ? "save_unknown" : "failed");
      expect(f.reportError).toHaveBeenCalledExactlyOnceWith({
        pluginId: PLUGIN,
        botId: BOT,
        sessionId: state.id,
        phase,
        code: "invalid_response",
      });
      expect(JSON.stringify(f.reportError.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    },
  );

  it("redacts unrecognized error codes and tolerates diagnostic sink failures", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockRejectedValue({ code: TOKEN, message: TOKEN });
    f.reportError.mockImplementation(() => {
      throw new Error("Synthetic log sink failure");
    });
    expect(await f.poll(state.id)).toMatchObject({ status: "failed" });
    expect(f.reportError).toHaveBeenCalledExactlyOnceWith({
      pluginId: PLUGIN,
      botId: BOT,
      sessionId: state.id,
      phase: "poll",
      code: "login_failed",
    });
    expect(JSON.stringify(f.reportError.mock.calls)).not.toContain(TOKEN);
  });

  it("starts a waiting session without polling or modifying existing credentials", async () => {
    const f = fixture();
    const state = await f.start();
    expect(state).toEqual({
      id: expect.any(String),
      status: "waiting",
      expiresAt: "2030-01-01T00:05:00.000Z",
      qrUrl: f.attempt.qrUrl,
    });
    expect(f.open).toHaveBeenCalledWith(PLUGIN, BOT, START, expect.any(AbortSignal));
    expect(f.attempt.poll).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    const signal = f.open.mock.calls[0]![3];
    await vi.advanceTimersByTimeAsync(16_000);
    expect(signal.aborted).toBe(false);
    expect(await f.poll(state.id)).toMatchObject({ status: "waiting" });
  });

  it("accepts the provider's official HTTP QR format as well as HTTPS", async () => {
    const f = fixture();
    f.attempt.qrUrl = "http://music.163.com/login?code=synthetic";
    expect(await f.start()).toMatchObject({ status: "waiting", qrUrl: f.attempt.qrUrl });
  });

  it.each([
    "javascript:alert(1)",
    "file:///secret",
    "https://user:password@passport.example/qr",
    "https://passport.example/qr\n",
    "https://passport.example/\\qr",
    "x".repeat(4097),
    `https://passport.example/${"字".repeat(1000)}`,
  ])("rejects unsafe QR URLs without returning provider diagnostics: %s", async (url) => {
    const f = fixture();
    f.attempt.qrUrl = url;
    const state = await f.start();
    expect(state).toMatchObject({ status: "failed" });
    expect(state).not.toHaveProperty("qrUrl");
    expect(f.commit).not.toHaveBeenCalled();
    await flush();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("binds both poll and cancellation to the exact owner, plugin and Bot", async () => {
    const f = fixture();
    const state = await f.start();
    for (const [owner, pluginId, botId] of [
      ["another-auth-session:42:org", PLUGIN, BOT],
      [OWNER, "hanori.netease", BOT],
      [OWNER, PLUGIN, randomUUID()],
    ]) {
      await expect(f.service.poll(owner!, pluginId!, botId!, state.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(f.service.cancel(owner!, pluginId!, botId!, state.id)).rejects.toMatchObject({
        code: "not_found",
      });
    }
    expect(f.attempt.poll).not.toHaveBeenCalled();
    expect(await f.poll(state.id)).toMatchObject({ status: "waiting" });
  });

  it("throttles repeated requests while exposing waiting and scanned states", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockResolvedValueOnce({ status: "scanned" }).mockResolvedValueOnce(AUTHORIZED);
    expect(await f.poll(state.id)).toMatchObject({ status: "scanned", qrUrl: f.attempt.qrUrl });
    for (let index = 0; index < 5; index++)
      expect(await f.poll(state.id)).toMatchObject({ status: "scanned" });
    expect(f.attempt.poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1999);
    expect(await f.poll(state.id)).toMatchObject({ status: "scanned" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.poll(state.id)).toMatchObject({ status: "saving" });
    expect(await f.settled(state.id)).toMatchObject({ status: "connected" });
    expect(f.attempt.poll).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent polls and commits verified credentials exactly once", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    const released = deferred<PluginLoginResult>();
    f.attempt.poll.mockImplementation(async () => {
      entered.resolve();
      return released.promise;
    });
    const polling = Array.from({ length: 8 }, () => f.poll(state.id));
    await entered.promise;
    released.resolve(AUTHORIZED);
    const states = await Promise.all(polling);
    expect(states.every((value) => value.status === "saving")).toBe(true);
    await flush();
    expect(f.attempt.poll).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith({ cookie: TOKEN }, expect.any(AbortSignal));
    expect(await f.poll(state.id)).toMatchObject({ status: "connected" });
    expect(f.commit).toHaveBeenCalledOnce();
    await flush();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("projects public fields, strips private fields and does not share mutable output", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockResolvedValue({ ...AUTHORIZED, privateDebug: TOKEN } as PluginLoginResult);
    f.commit.mockResolvedValue({
      ...botState(),
      privateDebug: TOKEN,
      configuration: {
        values: { cookie: TOKEN, accidental: TOKEN, model: "safe" },
        configuredSecrets: ["cookie"],
      },
      runtime: { status: "error", error: TOKEN },
    } as PluginBotState);
    const connected = await f.settled(state.id);
    expect(connected).toMatchObject({
      status: "connected",
      account: { name: "Synthetic account" },
      botState: {
        configuration: { values: { model: "safe" } },
        runtime: { error: "plugin_failed" },
      },
    });
    expect(connected).not.toHaveProperty("qrUrl");
    expect(connected).not.toHaveProperty("secrets");
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    connected.botState!.configuration.values.model = "changed";
    connected.account!.name = "changed";
    expect(await f.poll(state.id)).toMatchObject({
      account: { name: "Synthetic account" },
      botState: { configuration: { values: { model: "safe" } } },
    });
  });

  it.each<Record<string, unknown>>([
    { secrets: null },
    { secrets: {} },
    { secrets: { cookie: null } },
    { secrets: { cookie: "" } },
    { secrets: { cookie: "a\r\nInjected: true" } },
    { secrets: { cookie: "x".repeat(16_385) } },
    { secrets: { constructor: TOKEN } },
    { secrets: { "bad-key": TOKEN } },
    { secrets: { cookie: 123 } },
    { account: { name: " " } },
    { account: { name: "x".repeat(129) } },
    { account: { name: TOKEN } },
  ])("fails invalid authorization without saving any credentials: %j", async (override) => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockResolvedValue({ ...AUTHORIZED, ...override } as PluginLoginResult);
    const result = await f.poll(state.id);
    expect(result).toMatchObject({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("never saves a late authorized response after cancellation", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<AbortSignal>();
    const released = deferred<PluginLoginResult>();
    f.attempt.poll.mockImplementation(async (signal) => {
      entered.resolve(signal);
      return released.promise;
    });
    const polling = f.poll(state.id);
    const signal = await entered.promise;
    expect(await f.cancel(state.id)).toMatchObject({ status: "cancelled" });
    expect(await polling).toMatchObject({ status: "cancelled" });
    expect(signal.aborted).toBe(true);
    released.resolve(AUTHORIZED);
    await flush();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
    expect(await f.cancel(state.id)).toMatchObject({ status: "cancelled" });
  });

  it.each(["cancel", "invalidate", "expiry"])(
    "keeps a pending save visible during %s and confirms it only after persistence",
    async (event) => {
      const f = fixture();
      const state = await f.start();
      if (event === "expiry") await vi.advanceTimersByTimeAsync(299_000);
      const entered = deferred<AbortSignal>();
      const released = deferred<void>();
      let persisted = false;
      f.attempt.poll.mockResolvedValue(AUTHORIZED);
      f.commit.mockImplementation(async (_secrets, signal) => {
        entered.resolve(signal);
        await released.promise;
        signal.throwIfAborted();
        persisted = true;
        return botState();
      });
      const polling = f.poll(state.id);
      const signal = await entered.promise;
      expect(await polling).toMatchObject({ status: "saving" });
      expect(await f.poll(state.id)).toMatchObject({ status: "saving" });
      expect(await f.poll(state.id)).not.toHaveProperty("qrUrl");
      if (event === "cancel") expect(await f.cancel(state.id)).toMatchObject({ status: "saving" });
      else if (event === "invalidate") f.service.invalidate(PLUGIN, BOT);
      else await vi.advanceTimersByTimeAsync(1000);
      expect(signal.aborted).toBe(false);
      expect(await f.poll(state.id)).toMatchObject({ status: "saving" });
      expect(persisted).toBe(false);
      released.resolve();
      expect(await f.settled(state.id)).toMatchObject({ status: "connected" });
      await flush();
      expect(signal.aborted).toBe(true);
      expect(persisted).toBe(true);
      expect(f.commit).toHaveBeenCalledOnce();
      expect(f.attempt.dispose).toHaveBeenCalledOnce();
    },
  );

  it("reports an unknown save after its deadline and never presents a late commit as cancelled", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<AbortSignal>();
    const released = deferred<PluginBotState>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockImplementation(async (_secrets, signal) => {
      entered.resolve(signal);
      return released.promise;
    });
    const polling = f.poll(state.id);
    const signal = await entered.promise;
    expect(await polling).toMatchObject({ status: "saving" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await f.poll(state.id)).toMatchObject({ status: "save_unknown" });
    expect(signal.aborted).toBe(true);
    expect(await f.cancel(state.id)).toMatchObject({ status: "save_unknown" });
    f.service.invalidate(PLUGIN, BOT);
    released.resolve(botState());
    await flush();
    expect(await f.poll(state.id)).toMatchObject({ status: "save_unknown" });
    expect(await f.poll(state.id)).not.toHaveProperty("botState");
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("maps a non-CAS host save rejection to unknown without revealing credentials", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockRejectedValue(new Error(TOKEN));
    const result = await f.settled(state.id);
    expect(result).toMatchObject({ status: "save_unknown" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("does not start a second attempt while this owner's first save is unresolved", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    const released = deferred<PluginBotState>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockImplementation(async () => {
      entered.resolve();
      return released.promise;
    });
    const polling = f.poll(state.id);
    await entered.promise;
    expect(await polling).toMatchObject({ status: "saving" });
    expect(await f.start()).toMatchObject({ id: state.id, status: "saving" });
    expect(f.open).toHaveBeenCalledOnce();
    released.resolve(botState());
    expect(await f.settled(state.id)).toMatchObject({ status: "connected" });
  });

  it("waits for a bounded pending save during close without claiming cancellation", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<AbortSignal>();
    const released = deferred<PluginBotState>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockImplementation(async (_secrets, signal) => {
      entered.resolve(signal);
      return released.promise;
    });
    const polling = f.poll(state.id);
    const signal = await entered.promise;
    expect(await polling).toMatchObject({ status: "saving" });
    const closing = f.service.close();
    expect(signal.aborted).toBe(false);
    expect(await f.poll(state.id)).toMatchObject({ status: "saving" });
    released.resolve(botState());
    await closing;
    expect(signal.aborted).toBe(true);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("bounds shutdown of an unresponsive save after exposing saving to the initiating caller", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockImplementation(async () => {
      entered.resolve();
      return new Promise(() => {});
    });
    const polling = f.poll(state.id);
    await entered.promise;
    expect(await polling).toMatchObject({ status: "saving" });
    const closing = f.service.close();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(closing).resolves.toBeUndefined();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("still cancels authorization validation before saving has begun", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    const released = deferred<void>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.assertCurrent.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      entered.resolve();
      return released.promise;
    });
    const polling = f.poll(state.id);
    await entered.promise;
    expect(await f.cancel(state.id)).toMatchObject({ status: "cancelled" });
    expect(await polling).toMatchObject({ status: "cancelled" });
    released.resolve();
    await flush();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("keeps unresolved saves counted against the global session limit", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    const released = deferred<PluginBotState>();
    f.attempt.poll.mockResolvedValue(AUTHORIZED);
    f.commit.mockImplementation(async () => {
      entered.resolve();
      return released.promise;
    });
    const polling = f.poll(state.id);
    await entered.promise;
    await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        f.service.start(`other-${index}`, PLUGIN, BOT, START),
      ),
    );
    await expect(f.service.start("overflow-owner", PLUGIN, BOT, START)).rejects.toMatchObject({
      code: "session_limit",
    });
    expect(await f.poll(state.id)).toMatchObject({ status: "saving" });
    released.resolve(botState());
    expect(await polling).toMatchObject({ status: "saving" });
    expect(await f.settled(state.id)).toMatchObject({ status: "connected" });
  });

  it("expires without a poll request and rejects late provider authorization", async () => {
    const f = fixture();
    const state = await f.start();
    const entered = deferred<void>();
    const released = deferred<PluginLoginResult>();
    f.attempt.poll.mockImplementation(async () => {
      entered.resolve();
      return released.promise;
    });
    await vi.advanceTimersByTimeAsync(299_000);
    const polling = f.poll(state.id);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await polling).toMatchObject({ status: "expired" });
    released.resolve(AUTHORIZED);
    await flush();
    expect(await f.poll(state.id)).toMatchObject({ status: "expired" });
    expect(f.commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(f.poll(state.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("handles a provider-expired QR as a terminal state", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockResolvedValue({ status: "expired" });
    expect(await f.poll(state.id)).toMatchObject({ status: "expired" });
    expect(await f.poll(state.id)).toMatchObject({ status: "expired" });
    expect(f.attempt.poll).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(["stale_revision", "manifest_changed"])(
    "maps %s to conflict without exposing diagnostics",
    async (code) => {
      const f = fixture();
      const state = await f.start();
      f.attempt.poll.mockResolvedValue(AUTHORIZED);
      f.commit.mockRejectedValue(Object.assign(new Error(TOKEN), { code }));
      const result = await f.settled(state.id);
      expect(result).toMatchObject({ status: "conflict" });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(await f.poll(state.id)).toMatchObject({ status: "conflict" });
      expect(f.commit).toHaveBeenCalledOnce();
    },
  );

  it("rechecks current revisions before polling and before committing authorization", async () => {
    const f = fixture();
    const state = await f.start();
    f.assertCurrent.mockRejectedValueOnce({ code: "stale_revision" });
    expect(await f.poll(state.id)).toMatchObject({ status: "conflict" });
    expect(f.attempt.poll).not.toHaveBeenCalled();
    const second = fixture();
    const next = await second.start();
    second.attempt.poll.mockImplementation(async () => {
      second.assertCurrent.mockRejectedValueOnce({ code: "manifest_changed" });
      return AUTHORIZED;
    });
    expect(await second.poll(next.id)).toMatchObject({ status: "conflict" });
    expect(second.commit).not.toHaveBeenCalled();
  });

  it("invalidates pending starts and disposes their late attempts exactly once", async () => {
    const f = fixture();
    const entered = deferred<AbortSignal>();
    const released = deferred<typeof f.opened>();
    f.open.mockImplementation(async (_plugin, _bot, _start, signal) => {
      entered.resolve(signal);
      return released.promise;
    });
    const starting = f.start();
    const signal = await entered.promise;
    f.service.invalidate(PLUGIN, BOT);
    expect(await starting).toMatchObject({ status: "conflict" });
    expect(signal.aborted).toBe(true);
    released.resolve(f.opened);
    await flush();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("invalidates only the selected plugin/Bot scope", async () => {
    const f = fixture();
    const state = await f.start();
    f.service.invalidate("hanori.netease");
    f.service.invalidate(PLUGIN, randomUUID());
    expect(await f.poll(state.id)).toMatchObject({ status: "waiting" });
    f.service.invalidate(PLUGIN);
    expect(await f.poll(state.id)).toMatchObject({ status: "conflict" });
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("times out a stalled opening and disposes an uncooperative late attempt", async () => {
    const f = fixture();
    const released = deferred<typeof f.opened>();
    f.open.mockImplementation(async () => released.promise);
    const starting = f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await starting).toMatchObject({ status: "failed" });
    expect(f.open.mock.calls[0]![3].aborted).toBe(true);
    released.resolve(f.opened);
    await flush();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
  });

  it("times out a stalled poll without committing a late authorized result", async () => {
    const f = fixture();
    const state = await f.start();
    const released = deferred<PluginLoginResult>();
    f.attempt.poll.mockImplementation(async () => released.promise);
    const polling = f.poll(state.id);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await polling).toMatchObject({ status: "failed" });
    released.resolve(AUTHORIZED);
    await flush();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("reserves capacity before awaiting opens so concurrent starts cannot exceed 32", async () => {
    const f = fixture();
    const released = deferred<typeof f.opened>();
    f.open.mockImplementation(async () => released.promise);
    const starting = Array.from({ length: 32 }, (_, index) =>
      f.service.start(`owner-${index}`, PLUGIN, BOT, START),
    );
    await expect(f.service.start("overflow-owner", PLUGIN, BOT, START)).rejects.toMatchObject({
      code: "session_limit",
    });
    released.resolve(f.opened);
    expect(await Promise.all(starting)).toHaveLength(32);
    expect(f.open).toHaveBeenCalledTimes(32);
  });

  it("a fresh start replaces this owner's pending attempt and frees its slot", async () => {
    const f = fixture();
    const released = deferred<typeof f.opened>();
    const previousOpened = {
      ...f.opened,
      attempt: { ...f.attempt, dispose: vi.fn(async () => {}) },
    };
    f.open.mockImplementationOnce(async () => released.promise);
    const previous = f.start();
    await flush();
    const next = await f.start();
    expect(next.status).toBe("waiting");
    expect(await previous).toMatchObject({ status: "cancelled" });
    expect(f.open.mock.calls[0]![3].aborted).toBe(true);
    released.resolve(previousOpened);
    await flush();
    expect(previousOpened.attempt.dispose).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[1]![3].aborted).toBe(false);
  });

  it("closes without leaking rejected disposal or orphaning late provider attempts", async () => {
    const f = fixture();
    const released = deferred<typeof f.opened>();
    f.open.mockImplementation(async () => released.promise);
    f.attempt.dispose.mockRejectedValue(new Error(TOKEN));
    const starting = f.start();
    await flush();
    await f.service.close();
    expect(await starting).toMatchObject({ status: "cancelled" });
    released.resolve(f.opened);
    await flush();
    await expect(f.service.close()).resolves.toBeUndefined();
    expect(f.attempt.dispose).toHaveBeenCalledOnce();
    await expect(f.start()).rejects.toMatchObject({ code: "login_closed" });
  });

  it("bounds a hanging dispose so shutdown does not wait forever", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.dispose.mockImplementation(async () => new Promise(() => {}));
    await f.cancel(state.id);
    const closing = f.service.close();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(closing).resolves.toBeUndefined();
  });

  it("exposes no upstream exception contents and leaves credentials unchanged on provider failure", async () => {
    const f = fixture();
    const state = await f.start();
    f.attempt.poll.mockRejectedValue(new Error(`provider ${TOKEN}`));
    const result = await f.poll(state.id);
    expect(result).toMatchObject({ status: "failed" });
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "id", "status"]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("rejects malformed host requests without opening a provider", async () => {
    const f = fixture();
    for (const start of [
      { ...START, expectedRevision: -1 },
      { ...START, expectedRevision: 1.5 },
      { ...START, manifestHash: "bad" },
    ])
      await expect(f.service.start(OWNER, PLUGIN, BOT, start)).rejects.toMatchObject({
        code: "invalid_request",
      });
    await expect(f.service.start("", PLUGIN, BOT, START)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(f.service.start(OWNER, "bad", BOT, START)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(f.open).not.toHaveBeenCalled();
  });
});
