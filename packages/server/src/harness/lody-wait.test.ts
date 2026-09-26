import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type ExecFileLike, LodyCli } from "./lody.js";
import { type SpawnLike, type TurnEnd, createLocalExec } from "./lody-wait.js";

const SESSION = "11111111-2222-4333-8444-555555555555";

/** A scripted `lody` child: the test writes its stdout and decides when it exits. */
function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; stdin: string }> = [];
  const children: Array<{ print(text: string): void; exit(code: number): void }> = [];
  const spawn: SpawnLike = (file, args) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const call = { file, args, stdin: "" };
    stdin.on("data", (chunk: Buffer) => (call.stdin += chunk.toString()));
    Object.assign(child, { stdout, stdin, kill: vi.fn(() => true) });
    calls.push(call);
    children.push({
      print: (text) => stdout.write(text),
      exit: (code) => {
        stdout.end();
        setImmediate(() => child.emit("close", code, null));
      },
    });
    return child;
  };
  return { spawn, calls, children };
}

const CREATE = {
  machine: "mac-0001",
  localProject: "koyori",
  worktree: true,
  agent: "Claude Code",
  model: null,
  title: "koyori task fix",
  prompt: "owner words",
  workspace: null,
};

function setup(options: { maxWaiters?: number; acceptMs?: number } = {}) {
  const fake = fakeSpawn();
  const ends: TurnEnd[] = [];
  const exec = createLocalExec((end) => ends.push(end), { spawn: fake.spawn, ...options });
  const cli = new LodyCli(["npx", "-y", "lody"], 5_000, exec, undefined, 7_200);
  return { ...fake, ends, cli };
}

describe("local turn waiter", () => {
  it("answers a create once the session id prints and reports the end in-process", async () => {
    const ctx = setup();
    const created = ctx.cli.createSession(CREATE);
    await vi.waitFor(() => expect(ctx.children).toHaveLength(1));
    expect(ctx.calls[0]!.file).toBe("npx");
    expect(ctx.calls[0]!.args.slice(0, 4)).toEqual(["-y", "lody", "session", "create"]);
    expect(ctx.calls[0]!.args.slice(-3)).toEqual(["--wait", "--timeout", "7200"]);
    expect(ctx.calls[0]!.args).not.toContain("--json");
    ctx.children[0]!.print(`info: [ws] attached\n${SESSION}\n`);
    expect(await created).toEqual({ ok: true, value: { sessionId: SESSION } });
    expect(ctx.calls[0]!.stdin).toBe("owner words");
    expect(ctx.ends).toEqual([]);

    ctx.children[0]!.print("\nerror: this line is transcript text\n");
    ctx.children[0]!.exit(0);
    await vi.waitFor(() => expect(ctx.ends).toHaveLength(1));
    expect(ctx.ends[0]).toMatchObject({
      sessionId: SESSION,
      command: "create",
      status: "completed",
    });
  });

  it("accepts a chat at its first event or after the accept window, and reads the end status", async () => {
    const ctx = setup({ acceptMs: 30 });
    const streamed = ctx.cli.chat("s-1", "continue", "harness-turn-1");
    await vi.waitFor(() => expect(ctx.children).toHaveLength(1));
    expect(ctx.calls[0]!.args).toEqual(
      expect.arrayContaining(["session", "chat", "s-1", "--jsonl", "--wait"]),
    );
    ctx.children[0]!.print('{"type":"update","sessionId":"s-1","content":{"text":"x"}}\n');
    expect(await streamed).toEqual({ ok: true, value: undefined });

    const quiet = await ctx.cli.chat("s-1", "again");
    expect(quiet).toEqual({ ok: true, value: undefined });

    ctx.children[0]!.print('{"type":"done","sessionId":"s-1","turnId":"t"}\n');
    ctx.children[0]!.exit(0);
    ctx.children[1]!.print(
      '{"type":"error","sessionId":"s-1","userTurnId":"u","code":"canceled","error":"x"}\n',
    );
    ctx.children[1]!.exit(1);
    await vi.waitFor(() => expect(ctx.ends).toHaveLength(2));
    expect(ctx.ends[0]!.turnId).toBe("harness-turn-1");
    expect(ctx.calls[0]!.args).not.toContain("harness-turn-1");
    expect(ctx.ends.map((end) => [end.command, end.status])).toEqual([
      ["chat", "completed"],
      ["chat", "canceled"],
    ]);
  });

  it("keeps dispatch failures definite and reports nothing for them", async () => {
    const ctx = setup();
    const created = ctx.cli.createSession(CREATE);
    await vi.waitFor(() => expect(ctx.children).toHaveLength(1));
    ctx.children[0]!.print(
      '\u001b[31merror\u001b[39m: [session] Machine offline {"scope":"session"}\n',
    );
    ctx.children[0]!.exit(1);
    expect(await created).toEqual({ ok: false, reason: "failed", message: "Machine offline" });

    const chat = ctx.cli.chat("s-1", "x");
    await vi.waitFor(() => expect(ctx.children).toHaveLength(2));
    ctx.children[1]!.print('{"type":"error","error":"Session not found"}\n');
    ctx.children[1]!.exit(1);
    expect(await chat).toEqual({ ok: false, reason: "failed", message: "Session not found" });

    const silent = ctx.cli.chat("s-1", "x");
    await vi.waitFor(() => expect(ctx.children).toHaveLength(3));
    ctx.children[2]!.exit(1);
    expect(await silent).toMatchObject({ ok: false, reason: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.ends).toEqual([]);
  });
});

describe("LodyCli turn waits", () => {
  it("refuses a wait when the pool is full, and LodyCli then runs the plain command", async () => {
    const fake = fakeSpawn();
    const exec = createLocalExec(() => {}, { spawn: fake.spawn, maxWaiters: 1 });
    const argv = [
      "session",
      "chat",
      "s-1",
      "--prompt-file",
      "-",
      "--jsonl",
      "--wait",
      "--timeout",
      "60",
    ];
    const options = { timeout: 5_000, maxBuffer: 1024, input: "x" };
    const first = exec("lody", argv, options);
    await vi.waitFor(() => expect(fake.children).toHaveLength(1));
    fake.children[0]!.print('{"type":"update"}\n');
    await first;
    await expect(exec("lody", argv, options)).rejects.toMatchObject({ code: "EWAIT_REFUSED" });
    expect(fake.calls).toHaveLength(1);

    const plain = vi.fn<ExecFileLike>(async () => ({ stdout: '{"ok":true,"sessionId":"s-2"}' }));
    const refusing: ExecFileLike = async (file, args, execOptions) => {
      if (args.includes("--wait")) throw Object.assign(new Error("x"), { code: "EWAIT_REFUSED" });
      return plain(file, args, execOptions);
    };
    const cli = new LodyCli(["lody"], 5_000, refusing, undefined, 600);
    expect(await cli.createSession(CREATE)).toEqual({ ok: true, value: { sessionId: "s-2" } });
    expect(plain.mock.calls[0]![1].slice(-3)).toEqual(["--prompt-file", "-", "--json"]);
  });

  it("never waits when turnWait is off", async () => {
    const exec = vi.fn<ExecFileLike>(async () => ({ stdout: '{"ok":true}' }));
    await new LodyCli(["lody"], 5_000, exec).chat("s-1", "x");
    expect(exec.mock.calls[0]![1]).toEqual([
      "session",
      "chat",
      "s-1",
      "--prompt-file",
      "-",
      "--json",
    ]);
  });
});
