import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LodyCli,
  extractJson,
  parseCreatedSessionId,
  parseSessionStatus,
  findMachine,
  parseMachineList,
  parseSession,
  quotaBreaches,
} from "./lody.js";
import { renderQuota } from "./render.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-09-24T12:00:00Z");

describe("Lody output parsing", () => {
  it("skips transport log lines before the JSON document", () => {
    expect(extractJson(fixture("lody-machine-list.txt"))).toMatchObject({ ok: true });
    expect(extractJson("no json here")).toBeNull();
  });

  it("parses machines, providers, and windows from raceLimits", () => {
    const machines = parseMachineList(extractJson(fixture("lody-machine-list.txt")), NOW);
    expect(machines.map((m) => [m.name, m.online])).toEqual([
      ["MBP-64G.local", true],
      ["Desktop-5090", true],
      ["Desktop-7700X", false],
    ]);
    const claude = machines[0]!.limits.find((limit) => limit.key === "claude::claude")!;
    expect(claude).toMatchObject({ providerId: "claude", planName: "Team" });
    expect(claude.windows.map((w) => [w.span, w.usedPercent, w.label, w.expired])).toEqual([
      ["fiveHour", 17, null, false],
      ["week", 53, null, false],
      ["week", 51, "Fable", false],
    ]);
    const kimi = machines[0]!.limits.find((limit) => limit.key === "kimi::kimi")!;
    expect(kimi.windows.every((window) => window.expired)).toBe(true);
  });

  it("accepts the rateLimits spelling", () => {
    const machines = parseMachineList(
      {
        machines: [
          {
            id: "m1",
            name: "box",
            online: false,
            rateLimits: {
              "claude::claude": {
                scope: { providerId: "claude" },
                windows: [
                  {
                    usedPercent: 5,
                    windowDurationSeconds: 18000,
                    resetsAtEpochSeconds: 1_900_000_000,
                  },
                ],
              },
            },
          },
        ],
      },
      NOW,
    );
    expect(machines[0]!.limits[0]!.windows[0]).toMatchObject({ span: "fiveHour", expired: false });
  });

  it("parses session context usage and model", () => {
    const session = parseSession(extractJson(fixture("lody-session-show.txt")));
    expect(session).toMatchObject({
      status: "running",
      machineId: "mac-0001",
      model: { id: "opus[1m]", name: "Opus 5.5" },
      context: { size: 1_000_000, used: 474_127, percent: 47 },
    });
  });

  it("matches machines by id or by name without .local", () => {
    const machines = parseMachineList(extractJson(fixture("lody-machine-list.txt")), NOW);
    expect(findMachine(machines, "MBP-64G")?.id).toBe("mac-0001");
    expect(findMachine(machines, "win-0002")?.name).toBe("Desktop-5090");
    expect(findMachine(machines, "nope")).toBeNull();
  });

  it("ignores expired windows for guardrails", () => {
    const machines = parseMachineList(extractJson(fixture("lody-machine-list.txt")), NOW);
    expect(quotaBreaches(machines[0]!, { fiveHour: 10, week: 50 })).toEqual([
      { providerId: "claude", limitName: null, span: "fiveHour", usedPercent: 17, threshold: 10 },
      { providerId: "claude", limitName: null, span: "week", usedPercent: 53, threshold: 50 },
      { providerId: "claude", limitName: "Fable", span: "week", usedPercent: 51, threshold: 50 },
    ]);
  });

  it("renders quota with reset times and expired windows", () => {
    const machines = parseMachineList(extractJson(fixture("lody-machine-list.txt")), NOW);
    const text = renderQuota({
      result: { ok: true, value: machines },
      machines: machines.slice(0, 1),
      timeZone: "Asia/Shanghai",
    });
    expect(text).toContain("<b>MBP-64G.local</b> 🟢 在线");
    expect(text).toContain("claude · Team");
    expect(text).toContain("  5 小时 17% · 09-24 23:59 重置");
    expect(text).toContain("  本周 · Fable 51%");
    expect(text).toContain("  本周 · gpt-reserve 0% · 已过期");
  });
});

describe("LodyCli", () => {
  it("reports a missing CLI as unavailable", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("spawn lody ENOENT"), { code: "ENOENT" });
    });
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    const result = await cli.listMachines();
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: "未找到 lody CLI（lody）",
    });
  });

  it("passes a multi-part command and caches machine lists", async () => {
    const exec = vi.fn(async () => ({ stdout: fixture("lody-machine-list.txt") }));
    const cli = new LodyCli(["node", "/opt/lody/index.js"], 1000, exec, () => NOW);
    await cli.listMachines();
    await cli.listMachines();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "node",
      ["/opt/lody/index.js", "machine", "list", "--json"],
      expect.objectContaining({ timeout: 1000 }),
    );
  });

  it("rejects malformed session ids without running the CLI", async () => {
    const exec = vi.fn();
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    expect((await cli.showSession("../etc; rm")).ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("creates a session with the prompt on stdin, never in argv", async () => {
    const exec = vi.fn(async () => ({
      stdout: '[ws] attached\n{"ok":true,"session":{"id":"s-1"}}',
    }));
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    const result = await cli.createSession({
      machine: "mac-0001",
      localProject: "koyori",
      worktree: true,
      agent: "Claude Code",
      model: "sonnet",
      configOptions: ["effort=high"],
      title: "koyori #12 fix",
      prompt: "secret owner words",
      workspace: null,
    });
    expect(result).toEqual({ ok: true, value: { sessionId: "s-1" } });
    const [file, args, options] = exec.mock.calls[0]! as unknown as [
      string,
      string[],
      { input: string; timeout: number },
    ];
    expect(file).toBe("lody");
    expect(args).toEqual([
      "session",
      "create",
      "--machine",
      "mac-0001",
      "--local-project",
      "koyori",
      "--worktree",
      "--agent",
      "Claude Code",
      "--model",
      "sonnet",
      "--config-option",
      "effort=high",
      "--title",
      "koyori #12 fix",
      "--prompt-file",
      "-",
      "--json",
    ]);
    expect(args.join(" ")).not.toContain("secret");
    expect(options.input).toBe("secret owner words");
    expect(options.timeout).toBeGreaterThanOrEqual(120_000);
  });

  it("lists agent configs without keeping their env", async () => {
    const exec = vi.fn(async () => ({
      stdout: `[ws] attached\n${JSON.stringify({
        ok: true,
        agentConfigs: [
          { id: "c1", name: "Codex", agentType: "codex", machineId: null, env: { KEY: "sk-x" } },
          { id: "", name: "broken" },
        ],
      })}`,
    }));
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    const result = await cli.listAgentConfigs();
    expect(result).toEqual({
      ok: true,
      value: [{ id: "c1", name: "Codex", agentType: "codex", machineId: null }],
    });
    expect(JSON.stringify(result)).not.toContain("sk-x");
    await cli.listAgentConfigs();
    expect(exec).toHaveBeenCalledOnce();
    expect((exec.mock.calls[0] as unknown as [string, string[]])[1]).toEqual([
      "agent-config",
      "list",
      "--json",
    ]);
  });

  it("chats, cancels, and archives by session id only", async () => {
    const exec = vi.fn(async () => ({ stdout: '{"ok":true}' }));
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    await cli.chat("s-1", "feedback");
    await cli.cancelSession("s-1");
    await cli.archiveSession("s-1");
    expect(exec.mock.calls.map((call) => (call as unknown as [string, string[]])[1])).toEqual([
      ["session", "chat", "s-1", "--prompt-file", "-", "--json"],
      ["session", "cancel", "s-1", "--json"],
      ["session", "archive", "s-1", "--json"],
    ]);
    expect((await cli.chat("bad id", "x")).ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("reports a create without a session id as a failure", async () => {
    const exec = vi.fn(async () => ({ stdout: '{"ok":true}' }));
    const cli = new LodyCli(["lody"], 1000, exec, () => NOW);
    const result = await cli.createSession({
      machine: "m",
      localProject: "p",
      worktree: false,
      agent: "a",
      model: null,
      title: "t",
      prompt: "p",
      workspace: "ws",
    });
    expect(result).toEqual({ ok: false, reason: "unknown", message: "输出中没有会话 ID" });
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(0, 4)).toEqual(["session", "create", "--workspace", "ws"]);
    expect(args).not.toContain("--worktree");
    expect(args).not.toContain("--model");
  });
});

describe("Lody outcome classification", () => {
  const fail = (error: Record<string, unknown>) =>
    new LodyCli(
      ["lody"],
      1000,
      async () => {
        throw Object.assign(new Error("exec"), error);
      },
      () => NOW,
    ).cancelSession("s-1");

  it("treats timeouts, signals, and unexplained exits as unknown outcomes", async () => {
    expect(await fail({ killed: true, signal: "SIGTERM" })).toMatchObject({ reason: "unknown" });
    expect(await fail({ code: 1, stdout: "boom" })).toMatchObject({ reason: "unknown" });
  });

  it("treats an exit the CLI explains as a definite failure", async () => {
    expect(await fail({ code: 1, stdout: '{"ok":false,"error":"machine offline"}' })).toEqual({
      ok: false,
      reason: "failed",
      message: "machine offline",
    });
  });
});

describe("Lody session parsing", () => {
  it("accepts the session id wherever create prints it", () => {
    expect(parseCreatedSessionId({ session: { id: "a" } })).toBe("a");
    expect(parseCreatedSessionId({ sessionId: "b" })).toBe("b");
    expect(parseCreatedSessionId({ id: "c" })).toBe("c");
    expect(parseCreatedSessionId({})).toBeNull();
  });

  it("prefers the live status", () => {
    expect(
      parseSessionStatus({
        status: { type: "idle" },
        liveStatus: { state: "running", source: "machine" },
        machineOnline: true,
        archived: false,
      }),
    ).toEqual({ status: "running", running: true, machineOnline: true, archived: false });
  });
});
