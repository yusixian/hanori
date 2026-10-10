import { EventEmitter } from "node:events";
import { simpleParser } from "mailparser";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LarkWebhookClient } from "./lark-webhook-client.js";
import { ImapEmailMonitor, type ImapEmailMonitorConfig } from "./imap-email-monitor.js";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      return createClient();
    }
  },
}));
vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    from: { text: "sender@example.com" },
    subject: "Notification",
    text: "Body",
  }),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("retries an incomplete initial snapshot without forwarding existing mail", async () => {
  vi.useFakeTimers();
  const source = Buffer.from("From: sender@example.com\r\nSubject: Notification\r\n\r\nBody");
  let attempts = 0;
  const client = {
    mailbox: { uidValidity: 1n, uidNext: 1 },
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("snapshot interrupted");
      return attempts === 2 ? [1, 2] : [1, 2, 3];
    }),
    fetchAll: vi.fn(async (uids: number[]) => uids.map((uid) => ({ uid, source }))),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  createClient.mockReturnValue(client);
  const sendCard = vi.fn().mockResolvedValue({ ok: true });
  const monitor = new ImapEmailMonitor(
    {
      host: "mail.example.com",
      port: 993,
      secure: true,
      auth: { user: "test", pass: "test" },
      pollIntervalSec: 60,
      filters: [],
    },
    { sendCard } as unknown as LarkWebhookClient,
    { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
  );
  try {
    await monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(sendCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendCard).toHaveBeenCalledOnce();
    expect(client.messageFlagsAdd).toHaveBeenCalledExactlyOnceWith({ uid: 3 }, ["\\Seen"], {
      uid: true,
    });
  } finally {
    await monitor.stop();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function connection() {
  const fetch = vi.fn(async function* () {});
  return Object.assign(new EventEmitter(), {
    mailbox: { uidValidity: 1n, uidNext: 1 },
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    idle: vi.fn(() => new Promise<boolean>(() => {})),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([1]),
    fetch,
    fetchAll: vi.fn(async (uids: number[], _query?: unknown, _options?: { uid: boolean }) => {
      const messages: Array<{ uid: number; source: Buffer }> = [];
      for await (const message of fetch()) {
        const item = message as { uid: number; source: Buffer };
        if (uids.includes(item.uid)) messages.push(item);
      }
      return messages;
    }),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
  });
}
function fixture(overrides: Partial<ImapEmailMonitorConfig> = {}) {
  const first = connection();
  const second = connection();
  createClient.mockReset().mockReturnValueOnce(first).mockReturnValue(second);
  const sendCard = vi.fn().mockResolvedValue({ ok: true });
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const monitor = new ImapEmailMonitor(
    {
      host: "mail.example.com",
      port: 993,
      secure: true,
      auth: { user: "test", pass: "test" },
      pollIntervalSec: 60,
      filters: [],
      ...overrides,
    },
    { sendCard } as unknown as LarkWebhookClient,
    logger as unknown as Logger,
  );
  return { monitor, first, second, sendCard, logger };
}
beforeEach(() => {
  vi.mocked(simpleParser).mockResolvedValue({
    from: { text: "sender@example.com" },
    subject: "Notification",
    text: "Body",
  } as never);
});

it("handles SDK error and close events with one recoverable polling schedule", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, logger } = fixture();
  await monitor.start();
  const failure = new Error("socket failed");
  try {
    expect(() => first.emit("error", failure)).not.toThrow();
    first.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(failure, expect.any(String));
    expect(second.connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await monitor.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true, undefined])(
  "treats IDLE result %s according to the SDK success flag",
  async (result) => {
    vi.useFakeTimers();
    const { monitor, first, second } = fixture();
    first.idle.mockResolvedValueOnce(result as boolean);
    await monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(second.connect).toHaveBeenCalledTimes(result === false ? 1 : 0);
      expect(vi.getTimerCount()).toBe(result === false ? 1 : 0);
    } finally {
      await monitor.stop();
    }
  },
);

it("does not start delivery after stop while mail parsing is pending", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  const parsed = deferred<never>();
  vi.mocked(simpleParser).mockReturnValueOnce(parsed.promise);
  first.fetch.mockImplementationOnce(async function* () {
    yield { uid: 1, source: Buffer.from("mail") } as never;
  });
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(simpleParser).toHaveBeenCalledOnce();
  await monitor.stop();
  parsed.resolve({
    from: { text: "sender@example.com" },
    subject: "Notification",
    text: "Body",
  } as never);
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).not.toHaveBeenCalled();
});

it("recovers from a later close after the original IDLE promise succeeded", async () => {
  vi.useFakeTimers();
  const { monitor, first, second } = fixture();
  first.idle.mockResolvedValueOnce(true);
  await monitor.start();
  first.emit("close");
  await vi.advanceTimersByTimeAsync(0);
  expect(second.connect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  await monitor.stop();
});

it("releases a failed connection and retries without leaking schedules", async () => {
  vi.useFakeTimers();
  const { monitor, first, second } = fixture();
  first.connect.mockRejectedValueOnce(new Error("connect failed"));
  await monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.connect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  await monitor.stop();
  expect(second.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not send a suspended old fetch after stop and restart", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, sendCard } = fixture();
  await monitor.start();
  const fetched = deferred<void>();
  first.fetch.mockImplementationOnce(async function* () {
    await fetched.promise;
    yield { uid: 1, source: Buffer.from("old") } as never;
  });
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  await monitor.stop();
  await monitor.start();
  const parsed = deferred<never>();
  vi.mocked(simpleParser).mockReturnValueOnce(parsed.promise);
  second.search.mockResolvedValue([2]);
  second.fetch.mockImplementationOnce(async function* () {
    yield { uid: 2, source: Buffer.from("new") } as never;
  });
  second.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  fetched.resolve();
  await vi.advanceTimersByTimeAsync(0);
  second.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(second.fetch).toHaveBeenCalledTimes(1);
  expect(second.search).toHaveBeenCalledTimes(2);
  expect(sendCard).not.toHaveBeenCalled();
  parsed.resolve({ subject: "new", text: "Body" } as never);
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("keeps successful delivery deduplicated across connection loss without marking a new connection", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, sendCard } = fixture();
  await monitor.start();
  const delivered = deferred<{ ok: boolean }>();
  sendCard.mockReturnValueOnce(delivered.promise);
  const messages = async function* () {
    yield { uid: 1, source: Buffer.from("mail") } as never;
  };
  first.fetch.mockImplementationOnce(messages);
  second.fetch.mockImplementation(messages);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  first.emit("close");
  delivered.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(second.connect).toHaveBeenCalledOnce();
  expect(sendCard).toHaveBeenCalledOnce();
  expect(first.messageFlagsAdd).not.toHaveBeenCalled();
  expect(second.messageFlagsAdd).not.toHaveBeenCalled();
  await monitor.stop();
});

it("does not let an old logout or delivery completion alter a restarted monitor", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, sendCard } = fixture();
  await monitor.start();
  const delivered = deferred<{ ok: boolean }>();
  const logout = deferred<void>();
  sendCard.mockReturnValueOnce(delivered.promise);
  first.logout.mockReturnValueOnce(logout.promise);
  const messages = async function* () {
    yield { uid: 1, source: Buffer.from("mail") } as never;
  };
  first.fetch.mockImplementationOnce(messages);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  const stopping = monitor.stop();
  await monitor.start();
  logout.resolve();
  await stopping;
  delivered.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  second.fetch.mockImplementationOnce(messages);
  second.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledTimes(2);
  expect(second.messageFlagsAdd).toHaveBeenCalledOnce();
  expect(first.messageFlagsAdd).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();
  await monitor.stop();
});

it("does not reconnect or install timers when stop interrupts connection establishment", async () => {
  vi.useFakeTimers();
  const { monitor, first, second } = fixture();
  const connected = deferred<void>();
  first.connect.mockReturnValueOnce(connected.promise);
  const starting = monitor.start();
  await monitor.stop();
  connected.resolve();
  await starting;
  first.emit("close");
  expect(() => first.emit("error", new Error("late error"))).not.toThrow();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(first.getMailboxLock).not.toHaveBeenCalled();
  expect(second.connect).not.toHaveBeenCalled();
  expect(first.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores late close and error events from an older connection", async () => {
  vi.useFakeTimers();
  const { monitor, first, second } = fixture();
  await monitor.start();
  await monitor.stop();
  await monitor.start();
  first.emit("close");
  expect(() => first.emit("error", new Error("late error"))).not.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(second.close).not.toHaveBeenCalled();
  expect(second.connect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await monitor.stop();
});

it("does not resend successful delivery when marking seen fails", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  first.fetch.mockImplementation(async function* () {
    yield { uid: 1, source: Buffer.from("mail") } as never;
  });
  first.messageFlagsAdd.mockRejectedValueOnce(new Error("flags failed"));
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  expect(first.messageFlagsAdd).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("limits unsuccessful delivery retries without marking mail seen", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  first.fetch.mockImplementation(async function* () {
    yield { uid: 1, source: Buffer.from("mail") } as never;
  });
  sendCard.mockResolvedValue({ ok: false, error: "unavailable" });
  for (let attempt = 0; attempt < 7; attempt++) {
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(sendCard).toHaveBeenCalledTimes(5);
  expect(first.messageFlagsAdd).not.toHaveBeenCalled();
  await monitor.stop();
});

it.each(["historical", "filtered", "disabled"])(
  "advances past 50 %s unread messages in one notification",
  async (mode) => {
    vi.useFakeTimers();
    const { monitor, first, sendCard } = fixture({
      filters: mode === "filtered" ? [{ senderPattern: "wanted@example.com" }] : [],
      disabledEventTypes: mode === "disabled" ? ["generic"] : [],
    });
    let uids = mode === "historical" ? Array.from({ length: 50 }, (_, i) => i + 1) : [];
    const message = (uid: number) => ({
      uid,
      source: Buffer.from(uid === 51 ? "target" : "blocked"),
    });
    const search = vi.fn(async () => [...uids]);
    const fetchAll = vi.fn(async (batch: number[]) => batch.map(message));
    Object.assign(first, { search, fetchAll });
    first.fetch.mockImplementation(async function* () {
      for (const uid of uids) yield message(uid) as never;
    });
    vi.mocked(simpleParser).mockImplementation(
      async (source: unknown) =>
        (mode === "disabled" && String(source) === "target"
          ? {
              from: { text: "notifications@github.com" },
              subject: "[owner/repo] Fix (PR #1)",
              text: "opened this pull request https://github.com/owner/repo/pull/1",
            }
          : {
              from: {
                text: String(source) === "target" ? "wanted@example.com" : "other@example.com",
              },
              subject: String(source),
              text: "body",
            }) as never,
    );
    await monitor.start();
    uids = Array.from({ length: 51 }, (_, i) => i + 1);
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(simpleParser).mock.calls.some(([source]) => String(source) === "target")).toBe(
      true,
    );
    expect(sendCard).toHaveBeenCalledOnce();
    expect(fetchAll.mock.calls.every(([batch]) => batch.length === 1)).toBe(true);
    await monitor.stop();
  },
);

it("finishes FETCH before parsing, sending, or issuing flag commands", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  let uids: number[] = [];
  let fetchActive = false;
  const source = Buffer.from("mail");
  Object.assign(first, {
    search: vi.fn(async () => [...uids]),
    fetchAll: vi.fn(async () => {
      fetchActive = true;
      await Promise.resolve();
      fetchActive = false;
      return [{ uid: 1, source }];
    }),
  });
  first.fetch.mockImplementation(async function* () {
    fetchActive = true;
    try {
      for (const uid of uids) yield { uid, source } as never;
    } finally {
      fetchActive = false;
    }
  });
  first.messageFlagsAdd.mockImplementation(async () => {
    expect(fetchActive).toBe(false);
  });
  await monitor.start();
  uids = [1];
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  expect(first.messageFlagsAdd).toHaveBeenCalledOnce();
  await expect(first.messageFlagsAdd.mock.results[0]?.value).resolves.toBeUndefined();
  await monitor.stop();
});

it.each([false, undefined])(
  "does not commit a failed initial SEARCH result %s",
  async (failure) => {
    vi.useFakeTimers();
    const { monitor, first, sendCard } = fixture();
    first.search
      .mockReset()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce([1])
      .mockResolvedValue([1, 2]);
    first.fetchAll.mockImplementation(async (uids) =>
      uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
    );
    await monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.search).toHaveBeenCalledTimes(2);
    expect(sendCard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendCard).toHaveBeenCalledOnce();
    expect(first.fetchAll).toHaveBeenCalledExactlyOnceWith(
      [2],
      { source: true, envelope: true },
      { uid: true },
    );
    await monitor.stop();
  },
);

it("does not FETCH an empty unseen UID set", async () => {
  vi.useFakeTimers();
  const { monitor, first } = fixture();
  first.search.mockReset().mockResolvedValue([]);
  await monitor.start();
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenCalledTimes(2);
  expect(first.fetchAll).not.toHaveBeenCalled();
  expect(first.messageFlagsAdd).not.toHaveBeenCalled();
  await monitor.stop();
});

it("drains a finite UID snapshot while fetching one email body at a time", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  const uids = Array.from({ length: 123 }, (_, index) => index + 1);
  first.search.mockResolvedValue(uids);
  first.fetchAll.mockImplementation(async (batch) =>
    batch.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledTimes(123);
  expect(first.fetchAll.mock.calls.map(([batch]) => batch)).toEqual(uids.map((uid) => [uid]));
  expect(first.fetchAll.mock.calls.every(([, , options]) => options?.uid === true)).toBe(true);
  await monitor.stop();
});

it("coalesces EXISTS received during delivery into a fresh UID search", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  first.search.mockResolvedValue([1]);
  first.fetchAll.mockImplementation(async (batch) =>
    batch.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  const delivered = deferred<{ ok: boolean }>();
  sendCard.mockReturnValueOnce(delivered.promise);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  first.search.mockResolvedValue([1, 2]);
  first.emit("exists");
  first.emit("exists");
  delivered.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenCalledTimes(3);
  expect(first.fetchAll.mock.calls.map(([batch]) => batch)).toEqual([[1], [2]]);
  expect(sendCard).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await monitor.stop();
});

it("drops a pending EXISTS rerun when stopped during delivery", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  first.search.mockResolvedValue([1, 2]);
  first.fetchAll.mockImplementation(async (batch) =>
    batch.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  const delivered = deferred<{ ok: boolean }>();
  sendCard.mockReturnValueOnce(delivered.promise);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  first.emit("exists");
  await monitor.stop();
  delivered.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenCalledTimes(2);
  expect(first.fetchAll).toHaveBeenCalledOnce();
  expect(sendCard).toHaveBeenCalledOnce();
  expect(first.messageFlagsAdd).not.toHaveBeenCalled();
});

it("warns when marking seen returns false without resending delivered mail", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard, logger } = fixture();
  await monitor.start();
  first.fetchAll.mockResolvedValue([{ uid: 1, source: Buffer.from("mail") }]);
  first.messageFlagsAdd.mockResolvedValue(false);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  expect(logger.warn).toHaveBeenCalledWith({ uid: 1 }, "Failed to mark email as seen");
  await monitor.stop();
});

it("catches an EXISTS arriving during the initial UID snapshot", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  const snapshot = deferred<number[]>();
  first.mailbox.uidNext = 2;
  first.search.mockReset().mockReturnValueOnce(snapshot.promise).mockResolvedValue([1, 2]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  const starting = monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  first.mailbox.uidNext = 3;
  first.emit("exists");
  snapshot.resolve([1]);
  await starting;
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenCalledTimes(2);
  expect(first.fetchAll).toHaveBeenCalledExactlyOnceWith(
    [2],
    { source: true, envelope: true },
    { uid: true },
  );
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it.each([5001, 8000])(
  "never forwards a %s-message historical prefix after cache pruning",
  async (count) => {
    vi.useFakeTimers();
    const { monitor, first, sendCard } = fixture();
    const history = Array.from({ length: count }, (_, index) => index + 1);
    first.mailbox.uidNext = count + 1;
    first.search
      .mockReset()
      .mockResolvedValueOnce(history)
      .mockResolvedValue([...history, count + 1]);
    first.fetchAll.mockImplementation(async (uids) =>
      uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
    );
    await monitor.start();
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
    expect(first.fetchAll).toHaveBeenCalledExactlyOnceWith(
      [count + 1],
      { source: true, envelope: true },
      { uid: true },
    );
    expect(sendCard).toHaveBeenCalledOnce();
    await monitor.stop();
  },
);

it("excludes older mail marked unread later using the pre-search UIDNEXT", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  first.mailbox.uidNext = 100;
  first.search.mockReset().mockResolvedValueOnce([]).mockResolvedValue([20, 99, 100]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  await monitor.start();
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(first.fetchAll).toHaveBeenCalledExactlyOnceWith(
    [100],
    { source: true, envelope: true },
    { uid: true },
  );
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("preserves history, sent UIDs, and exhausted retries on same-epoch reconnect", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, sendCard } = fixture();
  first.mailbox.uidNext = 11;
  first.search.mockReset().mockResolvedValueOnce([10]).mockResolvedValue([10, 11, 12]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from(String(uid)) })),
  );
  vi.mocked(simpleParser).mockImplementation(
    async (source: unknown) => ({ subject: String(source), text: "body" }) as never,
  );
  sendCard.mockImplementation(async (card) => ({
    ok: !JSON.stringify(card).includes("Subject:** 12"),
  }));
  await monitor.start();
  for (let i = 0; i < 5; i++) {
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(sendCard).toHaveBeenCalledTimes(6);
  second.mailbox.uidNext = 100;
  second.search.mockReset().mockResolvedValue([10, 11, 12, 13]);
  second.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from(String(uid)) })),
  );
  first.emit("close");
  await vi.advanceTimersByTimeAsync(0);
  expect(second.fetchAll).toHaveBeenCalledOnce();
  expect(second.fetchAll.mock.calls[0]?.[0]).toEqual([13]);
  expect(sendCard).toHaveBeenCalledTimes(7);
  await monitor.stop();
});

it("establishes a new history baseline and forgets exhausted UIDs after UIDVALIDITY changes", async () => {
  vi.useFakeTimers();
  const { monitor, first, second, sendCard } = fixture();
  first.search.mockReset().mockResolvedValueOnce([]).mockResolvedValue([2]);
  first.fetchAll.mockResolvedValue([{ uid: 2, source: Buffer.from("mail") }]);
  sendCard.mockResolvedValue({ ok: false });
  await monitor.start();
  for (let i = 0; i < 5; i++) {
    first.emit("exists");
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(sendCard).toHaveBeenCalledTimes(5);
  second.mailbox.uidValidity = 2n;
  second.mailbox.uidNext = 2;
  second.search.mockReset().mockResolvedValueOnce([1]).mockResolvedValue([1, 2]);
  second.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  sendCard.mockResolvedValue({ ok: true });
  first.emit("close");
  await vi.advanceTimersByTimeAsync(0);
  expect(second.fetchAll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(second.fetchAll).toHaveBeenCalledOnce();
  expect(second.fetchAll.mock.calls[0]?.[0]).toEqual([2]);
  expect(sendCard).toHaveBeenCalledTimes(6);
  await monitor.stop();
});

it("does not advance the initial high-water mark after newer successful delivery", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  await monitor.start();
  first.search.mockResolvedValue([1, 2]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  sendCard.mockResolvedValueOnce({ ok: false });
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(first.fetchAll.mock.calls.map(([uids]) => uids)).toEqual([[1], [2], [1]]);
  expect(sendCard).toHaveBeenCalledTimes(3);
  await monitor.stop();
});

it.each(["mailbox", "uidValidity"])(
  "refuses initialization when %s is unavailable",
  async (missing) => {
    vi.useFakeTimers();
    const { monitor, first, sendCard, logger } = fixture();
    if (missing === "mailbox") Object.assign(first, { mailbox: false });
    else Object.assign(first.mailbox, { [missing]: undefined });
    await monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalled();
    expect(first.search).not.toHaveBeenCalled();
    expect(first.fetchAll).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
    await monitor.stop();
  },
);

it("does not commit a snapshot from an obsolete mailbox epoch", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  const snapshot = deferred<number[]>();
  first.mailbox.uidNext = 101;
  first.search
    .mockReset()
    .mockReturnValueOnce(snapshot.promise)
    .mockResolvedValueOnce([1])
    .mockResolvedValue([1, 2]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  const starting = monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  first.mailbox.uidValidity = 2n;
  first.mailbox.uidNext = 2;
  first.emit("exists");
  snapshot.resolve([100]);
  await starting;
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).not.toHaveBeenCalled();
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(first.fetchAll).toHaveBeenCalledOnce();
  expect(first.fetchAll.mock.calls[0]?.[0]).toEqual([2]);
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("uses ALL mail to establish history when UIDNEXT is unavailable", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard, logger } = fixture();
  Object.assign(first.mailbox, { uidNext: undefined });
  first.search.mockReset().mockResolvedValueOnce([3, 100]).mockResolvedValue([3, 100, 101]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  await monitor.start();
  expect(first.search).toHaveBeenNthCalledWith(1, { all: true }, { uid: true });
  expect(logger.info).toHaveBeenCalledWith(
    { count: 2 },
    "Skipped existing mailbox emails on first connect",
  );
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenNthCalledWith(2, { seen: false }, { uid: true });
  expect(first.fetchAll).toHaveBeenCalledOnce();
  expect(first.fetchAll.mock.calls[0]?.[0]).toEqual([101]);
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("accepts an empty ALL result when UIDNEXT is invalid", async () => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  first.mailbox.uidNext = 0;
  first.search.mockReset().mockResolvedValueOnce([]).mockResolvedValue([1]);
  first.fetchAll.mockResolvedValue([{ uid: 1, source: Buffer.from("mail") }]);
  await monitor.start();
  expect(first.search).toHaveBeenNthCalledWith(1, { all: true }, { uid: true });
  first.emit("exists");
  await vi.advanceTimersByTimeAsync(0);
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});

it.each([false, undefined])("retries ALL result %s without forwarding history", async (failure) => {
  vi.useFakeTimers();
  const { monitor, first, sendCard } = fixture();
  Object.assign(first.mailbox, { uidNext: undefined });
  first.search
    .mockReset()
    .mockResolvedValueOnce(failure)
    .mockResolvedValueOnce([10])
    .mockResolvedValue([10, 11]);
  first.fetchAll.mockImplementation(async (uids) =>
    uids.map((uid) => ({ uid, source: Buffer.from("mail") })),
  );
  await monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.search).toHaveBeenNthCalledWith(1, { all: true }, { uid: true });
  expect(first.search).toHaveBeenNthCalledWith(2, { all: true }, { uid: true });
  expect(sendCard).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(first.fetchAll).toHaveBeenCalledOnce();
  expect(first.fetchAll.mock.calls[0]?.[0]).toEqual([11]);
  expect(sendCard).toHaveBeenCalledOnce();
  await monitor.stop();
});
