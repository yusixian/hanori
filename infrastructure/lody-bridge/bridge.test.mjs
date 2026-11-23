import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArgs } from "./allowlist.mjs";
import {
  authorized,
  createBridgeServer,
  redactAgentConfigs,
  trimHistory,
  watchDaemon,
} from "./server.mjs";

const SECRET = "s".repeat(40);
const FAKE = fileURLToPath(new URL("./test/fake-lody.mjs", import.meta.url));
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  delete process.env.FAKE_LODY_MODE;
  delete process.env.FAKE_LODY_DAEMON_FILE;
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
    [["session", "history", "s-1", "--limit", "4", "--reverse", "--json"]],
    [
      [
        "session",
        "create",
        "--config-option",
        "reasoning_effort=ultra",
        "--config-option",
        "effort=default",
        "--json",
      ],
    ],
    [["agent-config", "list", "--json"]],
    [["agent-config", "list", "--machine", "Mac-Runner", "--json"]],
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
    [["session", "create", "--wait", "--timeout", "999", "--json"], "--wait with --json"],
    [["session", "create", "--title=x"], "= spelling"],
    [["session", "create", "--title", "a\nb"], "newline"],
    [["session", "create", "--title", "--json"], "flag as value"],
    [["session", "chat", "../x", "--json"], "bad session id"],
    [["session", "show"], "missing session id"],
    [["session", "show", "s-1", "--json", "--json"], "duplicate"],
    [["session", "create", "--machine", "a", "--machine", "b"], "duplicate value"],
    [["session", "create", "--config-option", "a=1"], "arbitrary config option"],
    [["session", "create", "--config-option", "effort=turbo"], "unknown effort"],
    [["session", "create", "--config-option", "sandbox=danger-full-access"], "permissions"],
    [["agent-config", "create", "--json"], "agent-config writes"],
    [["agent-config", "list", "--env", "A=1"], "--env"],
    [["session", "history", "s-1", "--all", "--json"], "full history"],
    [["session", "history", "s-1", "--limit", "500", "--json"], "large limit"],
    [["session", "history", "s-1", "--jsonl"], "jsonl"],
    [["session", "history", "--json"], "missing session id"],
    [["session", "show", "--json"], "flag as session id"],
  ])("rejects %j (%s)", (args) => {
    expect(checkArgs(args).ok).toBe(false);
  });
});

describe("bridge server", () => {
  it("authenticates runtime updates and blocks commands during maintenance", async () => {
    const runtime = {
      updating: false,
      status: async () => ({
        version: "0.103.0",
        machineName: "server",
        updating: false,
        canUpdate: true,
      }),
      update: async () => ({
        version: "0.103.0",
        machineName: "server",
        updating: false,
        canUpdate: true,
        updated: true,
      }),
    };
    const daemon = { daemon: "down" };
    const { port, exec } = await start({ runtime, daemon });
    const url = `http://127.0.0.1:${port}/runtime`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const headers = { authorization: `Bearer ${SECRET}` };
    expect((await (await fetch(url, { headers, method: "POST" })).json()).runtime.updated).toBe(
      true,
    );
    expect(daemon.daemon).toBe("running");
    runtime.updating = true;
    expect((await fetch(url, { method: "POST", headers })).status).toBe(409);
    expect((await exec({ args: ["machine", "list", "--json"] })).status).toBe(409);
  });

  it("preserves only safe model capability fields and pagination through the bridge", () => {
    const output = redactAgentConfigs(
      JSON.stringify({
        ok: true,
        hasMore: true,
        nextCursor: "page-2",
        agentConfigs: [
          {
            id: "cfg",
            name: "Agent",
            agentType: "codex",
            machineId: "server",
            env: { KEY: "secret" },
            runConfig: {
              secret: "secret",
              models: [
                {
                  id: "new-model",
                  name: "New model",
                  reasoningEffortValues: ["high"],
                  secret: "secret",
                },
              ],
            },
          },
        ],
      }),
    );
    expect(JSON.parse(output)).toMatchObject({
      hasMore: true,
      nextCursor: "page-2",
      agentConfigs: [
        { runConfig: { models: [{ id: "new-model", reasoningEffortValues: ["high"] }] } },
      ],
    });
    expect(output).not.toContain("secret");
  });
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

  it("restarts a stopped daemon with the saved login and reports it in health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lody-bridge-"));
    process.env.FAKE_LODY_DAEMON_FILE = join(dir, "daemon");
    process.env.LODY_CLI_TOKEN = "tok-should-not-leak";
    try {
      const logs = [];
      const watch = watchDaemon({
        command: [process.execPath, FAKE],
        machineName: "srv",
        intervalMs: 0,
        log: (line) => logs.push(line),
      });
      const { port } = await start({ daemon: watch.state });
      await watch.tick();
      expect(readFileSync(process.env.FAKE_LODY_DAEMON_FILE, "utf8")).toBe(
        "daemon start --machine-name srv",
      );
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({
        ok: true,
        lody: "0.100.0",
        daemon: "running",
      });

      rmSync(process.env.FAKE_LODY_DAEMON_FILE);
      process.env.FAKE_LODY_MODE = "fail";
      await watch.tick();
      await watch.tick();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, daemon: "down" });
      expect(logs).toEqual([
        "lody-bridge: daemon was down and has been restarted",
        "lody-bridge: daemon is down and restart failed; retrying",
      ]);
    } finally {
      delete process.env.LODY_CLI_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("strips agent-config env before the output leaves the sidecar", async () => {
    const { exec, logs } = await start();
    const result = await (await exec({ args: ["agent-config", "list", "--json"] })).json();
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      agentConfigs: [{ id: "cfg-1", name: "Codex", agentType: "codex", machineId: "m-1" }],
    });
    expect(JSON.stringify(result)).not.toContain("sk-should-not-leak");
    expect(logs.join("\n")).not.toContain("sk-should-not-leak");
    expect(redactAgentConfigs("not json")).toBe(
      JSON.stringify({ ok: false, error: "unreadable agent-config output" }),
    );
  });

  it("trims session history to role, time, and bounded text", async () => {
    const { exec } = await start();
    const result = await (
      await exec({ args: ["session", "history", "s-1", "--limit", "2", "--reverse", "--json"] })
    ).json();
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      entries: [
        {
          index: 1,
          role: "assistant",
          timestamp: "2026-09-24T12:41:44.073Z",
          text: "x".repeat(4000),
        },
        { index: 0, role: "user", timestamp: "2026-09-24T12:41:43.190Z", text: "continue" },
      ],
    });
    expect(result.stdout).not.toContain("attachment-secret");
    expect(trimHistory("not json")).toBe(
      JSON.stringify({ ok: false, error: "unreadable session history output" }),
    );
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
