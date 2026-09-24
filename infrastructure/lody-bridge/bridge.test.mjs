import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { checkArgs } from "./allowlist.mjs";
import { authorized, createBridgeServer } from "./server.mjs";

const SECRET = "s".repeat(40);
const FAKE = fileURLToPath(new URL("./test/fake-lody.mjs", import.meta.url));
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  delete process.env.FAKE_LODY_MODE;
});

async function start(options = {}) {
  const logs = [];
  const server = createBridgeServer({
    secret: SECRET,
    command: [process.execPath, FAKE],
    log: (line) => logs.push(line),
    ...options,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const exec = (body, secret = SECRET) =>
    fetch(`http://127.0.0.1:${port}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { port, logs, exec };
}

describe("checkArgs", () => {
  it.each([
    [["--version"]],
    [["machine", "list", "--json"]],
    [
      [
        "session",
        "create",
        "--workspace",
        "ws",
        "--machine",
        "40B19689-A2C1",
        "--local-project",
        "koyori",
        "--worktree",
        "--agent",
        "Claude Code",
        "--model",
        "opus[1m]",
        "--title",
        "koyori #12 保存无反馈",
        "--prompt-file",
        "-",
        "--json",
      ],
    ],
    [["session", "chat", "s-1", "--prompt-file", "-", "--json"]],
    [["session", "show", "s-1", "--json"]],
    [["session", "status", "s-1", "--json"]],
    [["session", "cancel", "s-1", "--turn-id", "assistant:abc", "--json"]],
    [["session", "archive", "s-1", "--json"]],
    [["session", "create", "--config-option", "a=1", "--config-option", "b=2", "--json"]],
  ])("allows %j", (args) => {
    expect(checkArgs(args).ok).toBe(true);
  });

  it.each([
    [[], "empty"],
    [["login", "--auth", "x"], "login"],
    [["daemon", "stop"], "daemon"],
    [["session", "delete", "s-1"], "delete"],
    [["session", "create", "do it"], "positional prompt"],
    [["session", "create", "--prompt", "x"], "--prompt text"],
    [["session", "create", "--prompt-file", "/etc/passwd"], "prompt file path"],
    [["session", "create", "--env", "A=1"], "--env"],
    [["session", "create", "--debug"], "--debug"],
    [["session", "create", "--wait", "--timeout", "999"], "--wait"],
    [["session", "create", "--title=x"], "= spelling"],
    [["session", "create", "--title", "a\nb"], "newline"],
    [["session", "create", "--title", "--json"], "flag as value"],
    [["session", "chat", "../x", "--json"], "bad session id"],
    [["session", "show"], "missing session id"],
    [["session", "show", "s-1", "--json", "--json"], "duplicate"],
    [["session", "create", "--machine", "a", "--machine", "b"], "duplicate value"],
  ])("rejects %j (%s)", (args) => {
    expect(checkArgs(args).ok).toBe(false);
  });
});

describe("bridge server", () => {
  it("refuses to start with a short secret", () => {
    expect(() => createBridgeServer({ secret: "short" })).toThrow(/at least 32/);
  });

  it("compares bearer secrets in constant time", () => {
    expect(authorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(authorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(authorized(SECRET, SECRET)).toBe(false);
    expect(authorized(undefined, SECRET)).toBe(false);
  });

  it("answers health without auth and reports the CLI version", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true, lody: "0.100.0" });
  });

  it("rejects bad auth and disallowed commands before spawning", async () => {
    const { exec, logs } = await start();
    expect((await exec({ args: ["machine", "list", "--json"] }, "wrong")).status).toBe(401);
    const denied = await exec({ args: ["daemon", "stop"] });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ ok: false, error: "command not allowed" });
    expect((await exec({ args: ["machine", "list"], stdin: "x" })).status).toBe(400);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("passes stdin, strips secrets from the child env, and never logs values", async () => {
    process.env.LODY_CLI_TOKEN = "tok-should-not-leak";
    const { exec, logs } = await start();
    const res = await exec({
      args: ["session", "chat", "s-1", "--prompt-file", "-", "--json"],
      stdin: "owner words",
    });
    delete process.env.LODY_CLI_TOKEN;
    const result = await res.json();
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, truncated: false });
    const printed = JSON.parse(result.stdout.split("\n")[1]);
    expect(printed).toEqual({
      ok: true,
      args: ["session", "chat", "s-1", "--prompt-file", "-", "--json"],
      stdin: "owner words",
      token: null,
    });
    expect(logs).toEqual([expect.stringMatching(/^lody-bridge: session chat -> 0 in \d+ms$/)]);
  });

  it("reports definite failures with the CLI's own output", async () => {
    process.env.FAKE_LODY_MODE = "fail";
    const { exec } = await start();
    const result = await (await exec({ args: ["session", "show", "s-1", "--json"] })).json();
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.stdout).toContain("machine offline");
  });

  it("kills commands that exceed the timeout or the output cap", async () => {
    process.env.FAKE_LODY_MODE = "sleep";
    const slow = await start({ maxTimeoutMs: 1_000 });
    const timedOut = await (
      await slow.exec({ args: ["session", "status", "s-1", "--json"], timeoutMs: 60_000 })
    ).json();
    expect(timedOut).toMatchObject({ timedOut: true, exitCode: null });

    process.env.FAKE_LODY_MODE = "flood";
    const noisy = await start({ maxOutputBytes: 1024 });
    const flooded = await (await noisy.exec({ args: ["machine", "list", "--json"] })).json();
    expect(flooded).toMatchObject({ truncated: true, stdout: "" });
  });

  it("reports a missing binary as a spawn error", async () => {
    const { exec } = await start({ command: ["/nonexistent/lody"] });
    expect(await (await exec({ args: ["machine", "list", "--json"] })).json()).toEqual({
      spawnError: "ENOENT",
    });
  });
});
