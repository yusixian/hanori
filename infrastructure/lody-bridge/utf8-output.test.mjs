import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runLody } from "./server.mjs";
import { startTurn } from "./waiter.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child);
  return child;
}

it("preserves split UTF-8 command output and flushes a trailing incomplete character", async () => {
  const child = childFixture();
  const result = runLody(["fake"], [], { timeoutMs: 1000, maxOutputBytes: 1000 });
  const text = "中文🙂";
  for (const byte of Buffer.from(text)) child.stdout.emit("data", Buffer.from([byte]));
  child.stdout.emit("data", Buffer.from([0xe4]));
  child.emit("close", 0, null);
  expect(await result).toMatchObject({ exitCode: 0, stdout: `${text}�`, truncated: false });
});

it("preserves split UTF-8 waiter error lines", async () => {
  const child = childFixture();
  const turn = startTurn(["fake"], ["session", "chat", "session-1", "--wait", "10"], {
    env: {},
    acceptMs: 1000,
    earlyTimeoutMs: 1000,
  });
  const error = "执行失败🙂";
  for (const byte of Buffer.from(JSON.stringify({ type: "error", error }))) {
    child.stdout.emit("data", Buffer.from([byte]));
  }
  child.emit("close", 1, null);
  expect(JSON.parse((await turn.early).stdout)).toEqual({ ok: false, error });
  expect(await turn.ended).toBeNull();
});

it.each([false, true])(
  "ignores oversized control lines regardless of chunking (split: %s)",
  async (split) => {
    const child = childFixture();
    const turn = startTurn(["fake"], ["session", "chat", "session-1", "--wait", "10"], {
      env: {},
      acceptMs: 1000,
      earlyTimeoutMs: 1000,
    });
    const line = JSON.stringify({ type: "done", padding: "x".repeat(70_000) });
    if (split) {
      child.stdout.emit("data", Buffer.from(line));
      child.stdout.emit("data", Buffer.from("\n"));
    } else child.stdout.emit("data", Buffer.from(`${line}\n`));
    child.stdout.emit("data", Buffer.from('{"type":"error","error":"real failure"}\n'));
    child.emit("close", 1, null);
    expect(JSON.parse((await turn.early).stdout)).toEqual({ ok: false, error: "real failure" });
    expect(await turn.ended).toBeNull();
  },
);

it("still accepts an oversized streaming update without parsing its payload", async () => {
  const child = childFixture();
  const turn = startTurn(["fake"], ["session", "chat", "session-1", "--wait", "10"], {
    env: {},
    acceptMs: 1000,
    earlyTimeoutMs: 1000,
  });
  child.stdout.emit(
    "data",
    Buffer.from(`${JSON.stringify({ type: "update", text: "x".repeat(70_000) })}\n`),
  );
  expect(await turn.early).toMatchObject({ exitCode: 0 });
  child.emit("close", 0, null);
  await turn.ended;
});
