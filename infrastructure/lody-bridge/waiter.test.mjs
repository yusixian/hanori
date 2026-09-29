import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArgs } from "./allowlist.mjs";
import { createBridgeServer } from "./server.mjs";
import { deliverTurnEnd, signTurnEnd } from "./waiter.mjs";

const SECRET = "s".repeat(40);
const FAKE = fileURLToPath(new URL("./test/fake-lody.mjs", import.meta.url));
const SESSION = "11111111-2222-4333-8444-555555555555";
const closers = [];
const listen = (server) =>
  new Promise((resolve) => {
    closers.push(() => new Promise((r) => server.close(r)));
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const name of ["FAKE_LODY_MODE", "FAKE_LODY_TURN_MS", "FAKE_LODY_RECORD_FILE"]) {
    delete process.env[name];
  }
});

/** A stand-in for the app's callback route that records what the bridge POSTs. */
async function appStub(status = 200) {
  const received = [];
  const port = await listen(
    createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end("{}");
      });
    }),
  );
  return { url: `http://127.0.0.1:${port}/api/harness/lody/turn`, received };
}

async function bridge(options = {}) {
  const logs = [];
  const port = await listen(
    createBridgeServer({
      secret: SECRET,
      command: [process.execPath, FAKE],
      log: (line) => logs.push(line),
      acceptMs: 5_000,
      deliver: (end, target) => deliverTurnEnd(end, { ...target, retryDelaysMs: [20, 20, 20] }),
      ...options,
    }),
  );
  const exec = (args, stdin = "do the task", turnId) =>
    fetch(`http://127.0.0.1:${port}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ args, stdin, timeoutMs: 10_000, turnId }),
    });
  return { logs, exec };
}

const CREATE = ["session", "create", "--machine", "m", "--prompt-file", "-"];
const WAIT = ["--wait", "--timeout", "7200"];
const CHAT = ["session", "chat", "s-1", "--prompt-file", "-", "--jsonl", ...WAIT];

describe("--wait allowlist", () => {
  it.each([[[...CREATE, ...WAIT]], [CHAT]])("allows %j", (args) => {
    expect(checkArgs(args)).toMatchObject({ ok: true, waits: true });
  });

  it.each([
    [[...CREATE, "--wait"], "--wait without --timeout"],
    [[...CREATE, "--timeout", "60"], "--timeout without --wait"],
    [[...CREATE, ...WAIT, "--json"], "create waits with human output only"],
    [["session", "chat", "s-1", "--json", ...WAIT], "chat waits with --jsonl only"],
    [["session", "chat", "s-1", "--jsonl"], "--jsonl without --wait"],
    [["session", "chat", "s-1", "--json", "--jsonl", ...WAIT], "both output modes"],
    [[...CREATE, "--wait", "--timeout", "90000"], "longer than a day"],
    [[...CREATE, "--wait", "--timeout", "5"], "under ten seconds"],
    [["session", "show", "s-1", ...WAIT], "wait on a read"],
  ])("rejects %j (%s)", (args) => {
    expect(checkArgs(args).ok).toBe(false);
  });
});

describe("waiting turns", () => {
  it("answers a create at acceptance and POSTs a signed turn end without transcript text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lody-wait-"));
    process.env.FAKE_LODY_RECORD_FILE = join(dir, "record.json");
    process.env.FAKE_LODY_TURN_MS = "400";
    process.env.LODY_CLI_TOKEN = "tok-should-not-leak";
    try {
      const app = await appStub();
      const { exec, logs } = await bridge({ callbackUrl: app.url });
      const result = await (await exec([...CREATE, ...WAIT])).json();
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, waiting: true });
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, sessionId: SESSION });
      expect(app.received).toEqual([]);

      await vi.waitFor(() => expect(app.received).toHaveLength(1), { timeout: 5_000 });
      const [{ headers, body }] = app.received;
      expect(headers["x-harness-signature"]).toBe(
        signTurnEnd(SECRET, headers["x-harness-timestamp"], body),
      );
      expect(Math.abs(Number(headers["x-harness-timestamp"]) - Date.now() / 1000)).toBeLessThan(5);
      expect(JSON.parse(body)).toMatchObject({
        sessionId: SESSION,
        command: "create",
        status: "completed",
        exitCode: 0,
      });
      expect(body).not.toContain("transcript-secret");
      const seen = JSON.parse(readFileSync(process.env.FAKE_LODY_RECORD_FILE, "utf8"));
      expect(seen).toMatchObject({ stdin: "do the task", token: null });
      await vi.waitFor(() => expect(logs.at(-1)).toMatch(/callback delivered after 1 attempt/));
      const printed = logs.join("\n");
      for (const secret of [SECRET, SESSION, "transcript-secret", "do the task"]) {
        expect(printed).not.toContain(secret);
      }
    } finally {
      delete process.env.LODY_CLI_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a chat at its first event, or once it outlives the accept window", async () => {
    const app = await appStub();
    const { exec } = await bridge({ callbackUrl: app.url, acceptMs: 100 });
    process.env.FAKE_LODY_TURN_MS = "300";
    const streamed = await (await exec(CHAT, "continue", "harness-turn-1")).json();
    expect(JSON.parse(streamed.stdout)).toEqual({ ok: true });
    // Turn ends are POSTed as they finish; if this child boots slowly the quiet turn can end first.
    await vi.waitFor(() => expect(app.received).toHaveLength(1), { timeout: 5_000 });

    process.env.FAKE_LODY_MODE = "quiet";
    const started = Date.now();
    const quiet = await (await exec(CHAT)).json();
    expect(quiet).toMatchObject({ exitCode: 0, waiting: true });
    expect(Date.now() - started).toBeLessThan(300);

    await vi.waitFor(() => expect(app.received).toHaveLength(2), { timeout: 5_000 });
    expect(app.received.map(({ body }) => JSON.parse(body))).toEqual([
      expect.objectContaining({
        sessionId: "s-1",
        command: "chat",
        status: "completed",
        turnId: "harness-turn-1",
      }),
      expect.objectContaining({ sessionId: "s-1", command: "chat", status: "completed" }),
    ]);
    expect(app.received[0].body).not.toContain("transcript-secret");
  });

  it("reports a cancelled turn and keeps dispatch failures definite without a callback", async () => {
    const app = await appStub();
    const { exec } = await bridge({ callbackUrl: app.url });
    process.env.FAKE_LODY_MODE = "turn-cancel";
    await exec([...CREATE, ...WAIT]);
    await exec(CHAT);
    await vi.waitFor(() => expect(app.received).toHaveLength(2), { timeout: 5_000 });
    expect(app.received.map(({ body }) => JSON.parse(body).status)).toEqual([
      "canceled",
      "canceled",
    ]);

    process.env.FAKE_LODY_MODE = "fail";
    const create = await (await exec([...CREATE, ...WAIT])).json();
    expect(create).toMatchObject({ exitCode: 1 });
    expect(JSON.parse(create.stdout)).toEqual({ ok: false, error: "Machine offline" });
    const chat = await (await exec(CHAT)).json();
    expect(JSON.parse(chat.stdout)).toEqual({ ok: false, error: "Session not found" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.received).toHaveLength(2);
  });

  it("bounds concurrent waiters with 429 and keeps plain commands working", async () => {
    const app = await appStub();
    const { exec, logs } = await bridge({ callbackUrl: app.url, maxWaiters: 1 });
    process.env.FAKE_LODY_TURN_MS = "500";
    expect((await exec([...CREATE, ...WAIT])).status).toBe(200);
    const busy = await exec(CHAT);
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ ok: false, error: "too many waiting turns" });
    expect((await exec(["session", "chat", "s-1", "--prompt-file", "-", "--json"])).status).toBe(
      200,
    );
    expect(logs).toContain("lody-bridge: rejected session chat --wait (1 turns already waiting)");
    await vi.waitFor(() => expect(app.received).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await exec(CHAT)).status).toBe(200));
  });

  it("gives up quietly when the app stays down", async () => {
    const down = await appStub();
    await closers.pop()();
    const { exec, logs } = await bridge({ callbackUrl: down.url });
    await exec(CHAT);
    await vi.waitFor(
      () => expect(logs.at(-1)).toMatch(/turn completed .*callback failed \(network\) after 4/),
      { timeout: 5_000 },
    );
  });
});

describe("deliverTurnEnd", () => {
  const end = { sessionId: "s-1", command: "chat", status: "completed" };
  const reply = (status) => new Response("{}", { status });

  it("retries network errors and 5xx, then stops at the app's answer", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(202));
    const sleep = vi.fn(async () => {});
    const outcome = await deliverTurnEnd(end, {
      url: "http://app",
      secret: SECRET,
      fetchImpl,
      sleep,
    });
    expect(outcome).toEqual({ attempts: 3, delivered: true, status: 202 });
    expect(sleep.mock.calls).toEqual([[2_000], [10_000]]);
  });

  it("does not retry a rejection and stops after the last delay", async () => {
    const sleep = async () => {};
    const rejected = vi.fn(async () => reply(401));
    expect(
      await deliverTurnEnd(end, { url: "http://app", secret: SECRET, fetchImpl: rejected, sleep }),
    ).toEqual({ attempts: 1, delivered: false, status: 401 });
    const failing = vi.fn(async () => reply(500));
    expect(
      await deliverTurnEnd(end, { url: "http://app", secret: SECRET, fetchImpl: failing, sleep }),
    ).toEqual({ attempts: 4, delivered: false, status: 500 });
  });
});
