import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { extractWithYtdlp } from "./yt-dlp.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function fixture(
  read: Parameters<typeof extractWithYtdlp>[2] = vi.fn(async () => ({})),
  signal?: AbortSignal,
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const result = extractWithYtdlp(
    "subtitles",
    { aid: 42, bvid: "synthetic", cid: 1 },
    read,
    signal,
  );
  return { child, read, result };
}

it.each([Buffer.from("x"), Buffer.from([0xe4]), Buffer.from([0xf0, 0x9f])])(
  "rejects trailing protocol bytes after a result: %j",
  async (tail) => {
    const { child, read, result } = fixture();
    const assertion = expect(result).rejects.toMatchObject({ code: "extractor_failed" });
    child.stdout.write(Buffer.concat([Buffer.from('{"type":"result","value":"ok"}\n'), tail]));
    child.emit("close", 0);
    await assertion;
    expect(read).not.toHaveBeenCalled();
  },
);

it("preserves complete UTF-8 characters split across output chunks", async () => {
  const { child, read, result } = fixture();
  for (const byte of Buffer.from(JSON.stringify({ type: "result", value: "字幕🙂" }) + "\n"))
    child.stdout.write(Buffer.from([byte]));
  child.emit("close", 0);
  await expect(result).resolves.toBe("字幕🙂");
  expect(read).not.toHaveBeenCalled();
});

it("waits for process close after cancellation and releases its concurrency slot", async () => {
  const controller = new AbortController();
  const reason = new Error("owner cancelled");
  const first = fixture(undefined, controller.signal);
  const second = fixture();
  const assertion = expect(first.result).rejects.toBe(reason);
  let settled = false;
  void first.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort(reason);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(first.child.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(fixture().result).rejects.toMatchObject({ code: "unavailable" });
  first.child.emit("close", null);
  await assertion;
  const replacement = fixture();
  for (const run of [second, replacement]) {
    run.child.stdout.write('{"type":"result","value":"ok"}\n');
    run.child.emit("close", 0);
    await expect(run.result).resolves.toBe("ok");
  }
});

it.each(["resolve", "reject"] as const)(
  "aborts a pending host read on process exit and ignores its late %s",
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const read = vi.fn(
      (_url: string, _query: Record<string, unknown>, _signal: AbortSignal) =>
        new Promise<unknown>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const { child, result } = fixture(read);
    const assertion = expect(result).rejects.toMatchObject({ code: "extractor_failed" });
    const write = vi.spyOn(child.stdin, "write");
    child.stdout.write('{"type":"request","url":"https://example.invalid","query":{}}\n');
    expect(read).toHaveBeenCalledOnce();
    child.emit("close", 1);
    await assertion;
    expect(read.mock.calls[0]![2].aborted).toBe(true);
    if (outcome === "resolve") resolve({ value: "late" });
    else reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it("preserves spawn failure through close and clears the deadline", async () => {
  vi.useFakeTimers();
  const { child, result } = fixture();
  const assertion = expect(result).rejects.toMatchObject({ code: "unavailable" });
  child.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" }));
  child.emit("close", -2);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending host read at the deadline and waits for process close", async () => {
  vi.useFakeTimers();
  const read = vi.fn(
    (_url: string, _query: Record<string, unknown>, signal: AbortSignal) =>
      new Promise<unknown>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const { child, result } = fixture(read);
  const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
  child.stdout.write('{"type":"request","url":"https://example.invalid","query":{}}\n');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read.mock.calls[0]![2].aborted).toBe(true);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
