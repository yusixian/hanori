import { describe, expect, test, vi } from "vitest";
import { createGovernanceSubjectResolver } from "./governance-subject-resolver";

function option(value: string, label = value) {
  return { value, label, detail: `ID ${value}` };
}

describe("governance subject resolver", () => {
  test("limits exact label lookups to four and deduplicates the same subject", async () => {
    let active = 0;
    let maxActive = 0;
    const requests: Array<{ value: string; finish: () => void }> = [];
    const search = vi.fn(
      (_kind: "chat" | "user", value: string, signal: AbortSignal) =>
        new Promise<ReturnType<typeof option>[]>((resolve, reject) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            active -= 1;
            resolve([option(value)]);
          };
          signal.addEventListener(
            "abort",
            () => {
              if (settled) return;
              settled = true;
              active -= 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          requests.push({ value, finish });
        }),
    );
    const resolver = createGovernanceSubjectResolver(search, 4);
    const signal = new AbortController().signal;
    const values = ["-1", "-1", "-2", "-3", "-4", "-5", "-6"];
    const resolutions = values.map((value) => resolver.resolve("chat", value, signal));

    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(maxActive).toBe(4);
    requests.slice(0, 4).forEach((request) => request.finish());
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    requests.slice(4).forEach((request) => request.finish());

    await expect(Promise.all(resolutions)).resolves.toHaveLength(values.length);
    expect(search).toHaveBeenCalledTimes(6);
    expect(search.mock.calls.filter(([, value]) => value === "-1")).toHaveLength(1);
    resolver.dispose();
  });

  test("consumer cancellation does not cancel a shared lookup", async () => {
    let finish: (() => void) | undefined;
    const search = vi.fn(
      (_kind: "chat" | "user", value: string) =>
        new Promise<ReturnType<typeof option>[]>((resolve) => {
          finish = () => resolve([option(value)]);
        }),
    );
    const resolver = createGovernanceSubjectResolver(search);
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(resolver.resolve("user", "7", alreadyCancelled.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(search).not.toHaveBeenCalled();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = resolver.resolve("user", "42", firstController.signal);
    const second = resolver.resolve("user", "42", secondController.signal);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(search).toHaveBeenCalledTimes(1);
    finish?.();
    await expect(second).resolves.toEqual(option("42"));
    resolver.dispose();
  });

  test("cancels active and queued lookups after their last consumers leave", async () => {
    const observedSignals: AbortSignal[] = [];
    const search = vi.fn(
      (_kind: "chat" | "user", _value: string, signal: AbortSignal) =>
        new Promise<ReturnType<typeof option>[]>((_resolve, reject) => {
          observedSignals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const resolver = createGovernanceSubjectResolver(search, 1);
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = resolver.resolve("chat", "-1", activeController.signal);
    const queued = resolver.resolve("chat", "-2", queuedController.signal);
    const activeAssertion = expect(active).rejects.toMatchObject({ name: "AbortError" });
    const queuedAssertion = expect(queued).rejects.toMatchObject({ name: "AbortError" });

    activeController.abort();
    queuedController.abort();
    await Promise.all([activeAssertion, queuedAssertion]);
    await vi.waitFor(() => expect(observedSignals[0]?.aborted).toBe(true));
    expect(search).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });

  test("dispose aborts active and queued work so a new bot resolver starts clean", async () => {
    const observedSignals: AbortSignal[] = [];
    const search = vi.fn(
      (_kind: "chat" | "user", _value: string, signal: AbortSignal) =>
        new Promise<ReturnType<typeof option>[]>((_resolve, reject) => {
          observedSignals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const resolver = createGovernanceSubjectResolver(search, 1);
    const signal = new AbortController().signal;
    const active = resolver.resolve("chat", "-1", signal);
    const queued = resolver.resolve("chat", "-2", signal);
    const activeAssertion = expect(active).rejects.toMatchObject({ name: "AbortError" });
    const queuedAssertion = expect(queued).rejects.toMatchObject({ name: "AbortError" });

    resolver.dispose();
    await Promise.all([activeAssertion, queuedAssertion]);
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);

    const nextSearch = vi.fn(async (_kind: "chat" | "user", value: string) => [option(value)]);
    const nextResolver = createGovernanceSubjectResolver(nextSearch);
    await expect(nextResolver.resolve("chat", "-1", signal)).resolves.toEqual(option("-1"));
    expect(nextSearch).toHaveBeenCalledTimes(1);
    nextResolver.dispose();
  });
});
