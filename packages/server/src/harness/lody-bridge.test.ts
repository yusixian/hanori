import { type IncomingMessage, type Server, createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LodyCli } from "./lody.js";
import { createBridgeExec, createBridgeRuntimeClient } from "./lody-bridge.js";
import { TEST_CHAT_ID, TEST_OWNER, createTestService, testConfigRaw } from "./test-fakes.js";

const SECRET = "b".repeat(40);
const NOW = new Date("2026-09-25T12:00:00Z");
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface Seen {
  auth?: string;
  body: { args: string[]; stdin?: string; timeoutMs: number; turnId?: string };
}

async function fakeBridge(
  respond: (seen: Seen) => { status?: number; body: unknown } | "hang",
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = { auth: req.headers.authorization, body: JSON.parse(raw) };
    seen.push(entry);
    const reply = respond(entry);
    if (reply === "hang") return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function cli(url: string, timeoutMs = 1_000, secret: string | undefined = SECRET) {
  return new LodyCli(["lody"], timeoutMs, createBridgeExec(url, secret), () => NOW);
}

const CREATE = {
  machine: "mac-0001",
  localProject: "koyori",
  worktree: true,
  agent: "Claude Code",
  model: "sonnet",
  title: "koyori #1 fix",
  prompt: "owner words",
  workspace: null,
};

describe("lody-bridge runtime transport", () => {
  it("authenticates maintenance and waits through installation and failed-start rollback", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const runtime = {
      version: "0.103.0",
      machineName: "server",
      updating: false,
      canUpdate: true,
      updated: true,
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true, runtime }));
    const client = createBridgeRuntimeClient("http://bridge", SECRET, fetchImpl);
    await expect(client.status()).resolves.toEqual(runtime);
    await expect(client.update()).resolves.toEqual(runtime);
    expect(
      fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method, init?.headers]),
    ).toEqual([
      ["http://bridge/runtime", "GET", { authorization: `Bearer ${SECRET}` }],
      ["http://bridge/runtime", "POST", { authorization: `Bearer ${SECRET}` }],
    ]);
    expect(timeout.mock.calls[0]?.[0]).toBe(15_000);
    const maximumRecovery =
      140_000 +
      15_000 +
      10_000 +
      180_000 +
      10_000 +
      15_000 +
      30_000 +
      30_000 +
      60_000 +
      30_000 +
      60_000;
    expect(timeout.mock.calls[1]?.[0]).toBeGreaterThan(maximumRecovery);
  });

  it("preserves an explicit maintenance conflict", async () => {
    const client = createBridgeRuntimeClient("http://bridge", SECRET, async () =>
      Response.json({ ok: false, code: "conflict", error: "busy" }, { status: 409 }),
    );
    await expect(client.update()).rejects.toMatchObject({ code: "conflict", message: "busy" });
  });
});

describe("lody-bridge transport", () => {
  it("sends argv, stdin, and the timeout with the bearer secret", async () => {
    const bridge = await fakeBridge(() => ({
      body: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '{"ok":true,"session":{"id":"s-9"}}',
      },
    }));
    const result = await cli(bridge.url).createSession(CREATE);
    expect(result).toEqual({ ok: true, value: { sessionId: "s-9" } });
    const [request] = bridge.seen;
    expect(request!.auth).toBe(`Bearer ${SECRET}`);
    expect(request!.body.args.slice(0, 2)).toEqual(["session", "create"]);
    expect(request!.body.args).not.toContain("owner words");
    expect(request!.body.stdin).toBe("owner words");
    expect(request!.body.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("keeps the local classification for failures", async () => {
    const replies: Array<{ status?: number; body: unknown }> = [
      {
        body: {
          exitCode: 3,
          signal: null,
          timedOut: false,
          stdout: '{"ok":false,"error":"machine offline"}',
        },
      },
      { body: { exitCode: 1, signal: null, timedOut: false, stdout: "boom" } },
      { body: { exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" } },
      { body: { exitCode: null, signal: "SIGTERM", truncated: true, stdout: "" } },
      { body: { spawnError: "ENOENT" } },
      { status: 401, body: { ok: false, error: "unauthorized" } },
      { status: 400, body: { ok: false, error: "command not allowed" } },
      { status: 502, body: {} },
    ];
    const bridge = await fakeBridge(() => replies.shift()!);
    const lody = cli(bridge.url);
    const outcomes = [];
    for (let index = 0; index < 8; index++) outcomes.push(await lody.cancelSession("s-1"));
    expect(outcomes).toEqual([
      { ok: false, reason: "failed", message: "machine offline" },
      { ok: false, reason: "unknown", message: "lody CLI 失败（1）" },
      { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" },
      { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" },
      { ok: false, reason: "unavailable", message: "未找到 lody CLI（lody）" },
      { ok: false, reason: "failed", message: "lody-bridge 拒绝了认证，请检查共享密钥" },
      { ok: false, reason: "failed", message: "lody-bridge 拒绝了参数：command not allowed" },
      { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" },
    ]);
  });

  it("treats a bridge that stops answering as an unknown outcome", async () => {
    const bridge = await fakeBridge(() => "hang");
    const exec = createBridgeExec(bridge.url, SECRET);
    await expect(
      exec("lody", ["session", "status", "s-1", "--json"], { timeout: 10, maxBuffer: 1024 }),
    ).rejects.toMatchObject({ killed: true });
  }, 10_000);

  it("reports an unreachable or unconfigured bridge as unavailable", async () => {
    const closed = await fakeBridge(() => ({ body: {} }));
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await cli(closed.url).listMachines()).toEqual({
      ok: false,
      reason: "unavailable",
      message: "无法连接 lody-bridge（ECONNREFUSED）",
    });
    expect(await cli("http://127.0.0.1:1", 1_000, "short").showSession("s-1")).toEqual({
      ok: false,
      reason: "unavailable",
      message: "lody-bridge 共享密钥未配置或少于 32 个字符",
    });
    expect(await cli("ftp://bridge", 1_000).showSession("s-1")).toMatchObject({
      reason: "unavailable",
      message: "lody-bridge 地址无效",
    });
  });
});

describe("lody-bridge turn waits", () => {
  const ok = (stdout: unknown) => ({
    body: { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify(stdout) },
  });
  const waiting = (url: string) =>
    new LodyCli(["lody"], 1_000, createBridgeExec(url, SECRET), () => NOW, 7_200);

  it("sends create and chat with --wait and reads the id the bridge relays", async () => {
    const bridge = await fakeBridge(() => ok({ ok: true, sessionId: "s-9" }));
    expect(await waiting(bridge.url).createSession(CREATE)).toEqual({
      ok: true,
      value: { sessionId: "s-9" },
    });
    expect(await waiting(bridge.url).chat("s-9", "more", "harness-turn-1")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(bridge.seen[1]!.body.turnId).toBe("harness-turn-1");
    const [create, chat] = bridge.seen.map((seen) => seen.body.args);
    expect(create!.slice(-5)).toEqual(["--prompt-file", "-", "--wait", "--timeout", "7200"]);
    expect(create).not.toContain("--json");
    expect(chat).toEqual([
      "session",
      "chat",
      "s-9",
      "--prompt-file",
      "-",
      "--jsonl",
      "--wait",
      "--timeout",
      "7200",
    ]);
  });

  it.each([
    [{ status: 429, body: { ok: false, error: "too many waiting turns" } }],
    [{ status: 400, body: { ok: false, error: "option not allowed: --wait" } }],
  ])("runs the plain command when the bridge refuses to wait (%j)", async (refusal) => {
    const bridge = await fakeBridge(({ body }) =>
      body.args.includes("--wait") ? refusal : ok({ ok: true, sessionId: "s-3" }),
    );
    expect(await waiting(bridge.url).createSession(CREATE)).toEqual({
      ok: true,
      value: { sessionId: "s-3" },
    });
    expect(bridge.seen.map((seen) => seen.body.args.at(-1))).toEqual(["7200", "--json"]);
    expect(bridge.seen[1]!.body.stdin).toBe("owner words");
  });
});

describe("harness service transport selection", () => {
  const machines = readFileSync(
    new URL("./__fixtures__/lody-machine-list.txt", import.meta.url),
    "utf8",
  );

  it("routes Lody calls to the bridge when its URL is in the environment", async () => {
    const bridge = await fakeBridge(() => ({
      body: { exitCode: 0, signal: null, timedOut: false, stdout: machines },
    }));
    const ctx = await createTestService({
      raw: testConfigRaw({ machines: { mbp: { lody: "Mac-Runner" } } }),
      realLody: true,
      env: {
        HARNESS_GITHUB_WEBHOOK_SECRET: "s3cret",
        HARNESS_LODY_BRIDGE_URL: bridge.url,
        HARNESS_LODY_BRIDGE_SECRET: SECRET,
      },
    });
    const reply = await ctx.port.handleCommand({
      command: "status",
      args: "",
      chatId: TEST_CHAT_ID,
      userId: TEST_OWNER,
      messageId: 1,
    });
    expect(reply.html).toContain("执行机：Mac-Runner.local 🟢 在线 · 经lody-bridge");
    expect(bridge.seen[0]!.body.args).toEqual(["machine", "list", "--json"]);
  });

  it("keeps the local CLI when no bridge URL is set", async () => {
    const ctx = await createTestService({
      realLody: true,
      raw: testConfigRaw({ executors: { lody: { cli: "/nonexistent/lody" } } }),
    });
    expect(ctx.service.lodyTransport()).toBe("local");
    expect(await ctx.service.lody().listMachines()).toMatchObject({
      reason: "unavailable",
      message: "未找到 lody CLI（/nonexistent/lody）",
    });
  });
});

it.each([false, true])(
  "releases an unused HTTP error body without changing unknown outcome (cancel fails: %s)",
  async (cancelFails) => {
    const cancel = vi.fn(() => {
      if (cancelFails) throw new Error("cancel failed");
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream({ cancel }), { status: 502 }),
    );
    const exec = createBridgeExec("http://bridge.invalid", SECRET, fetchImpl);
    await expect(
      exec("lody", ["session", "create"], { timeout: 1000, maxBuffer: 1024 }),
    ).rejects.toMatchObject({ killed: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);

it.each(["hello", "中文", "🙂"])("enforces stdout's UTF-8 byte limit for %s", async (stdout) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ exitCode: 0, stdout }));
  const exec = createBridgeExec("http://bridge.invalid", SECRET, fetchImpl);
  const bytes = Buffer.byteLength(stdout, "utf8");
  await expect(
    exec("lody", ["machine", "list"], { timeout: 1000, maxBuffer: bytes }),
  ).resolves.toEqual({ stdout });
  await expect(
    exec("lody", ["machine", "list"], { timeout: 1000, maxBuffer: bytes - 1 }),
  ).rejects.toMatchObject({ killed: true });
});

it.each([
  { exitCode: "3", stdout: '{"ok":false,"error":"rejected"}' },
  { exitCode: 0, timedOut: 0, stdout: '{"sessionId":"unexpected"}' },
  { exitCode: 0, truncated: "", stdout: '{"sessionId":"unexpected"}' },
  null,
])("treats malformed bridge results as unknown without retrying", async (body) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body));
  const lody = new LodyCli(
    ["lody"],
    1000,
    createBridgeExec("http://bridge.invalid", SECRET, fetchImpl),
  );
  await expect(lody.createSession(CREATE)).resolves.toMatchObject({ ok: false, reason: "unknown" });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("accepts valid bridge results with omitted optional fields and future metadata", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      exitCode: 0,
      stdout: '{"ok":true,"session":{"id":"s-9"}}',
      futureMetadata: { version: 2 },
    }),
  );
  const lody = new LodyCli(
    ["lody"],
    1000,
    createBridgeExec("http://bridge.invalid", SECRET, fetchImpl),
  );
  await expect(lody.createSession(CREATE)).resolves.toEqual({
    ok: true,
    value: { sessionId: "s-9" },
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  { status: 401, code: 1, cancelFails: false },
  { status: 401, code: 1, cancelFails: true },
  { status: 429, code: "EWAIT_REFUSED", cancelFails: false },
  { status: 429, code: "EWAIT_REFUSED", cancelFails: true },
])(
  "releases a rejected response while preserving $status classification (cancel fails: $cancelFails)",
  async ({ status, code, cancelFails }) => {
    const cancel = vi.fn(() => {
      if (cancelFails) throw new Error("cancel failed");
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream({ cancel }), { status }),
    );
    const exec = createBridgeExec("http://bridge.invalid", SECRET, fetchImpl);
    await expect(
      exec("lody", ["session", "create", "--wait"], { timeout: 1000, maxBuffer: 1024 }),
    ).rejects.toMatchObject({ code });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);
