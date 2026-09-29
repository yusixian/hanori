import { describe, expect, it, vi } from "vitest";
import { MemoryHarnessStore } from "./memory-store.js";
import { TRANSITION_RETRIES, optimisticTransition, prTransition } from "./request-lifecycle.js";
import { REQUEST_STATES as S } from "./states.js";
import type { HarnessRequestPatch, HarnessRequestRecord } from "./store.js";

function stored(store: MemoryHarnessStore, state: string) {
  return store.insertRequest({ projectKey: "sandbox", type: "bug", state, repo: "o/r" });
}

describe("optimisticTransition", () => {
  it("moves from the snapshot's state with its fields and facts, then runs `after`", async () => {
    const store = new MemoryHarnessStore();
    const request = await stored(store, S.running);
    const after = vi.fn(async () => {});
    const won = await optimisticTransition(store, request, async () => ({
      to: S.prReady,
      fields: { title: "linked" },
      facts: { cardMessageId: 100 },
      after,
    }));
    expect(won).toBe(true);
    expect(await store.getRequest(request.id)).toMatchObject({
      state: S.prReady,
      title: "linked",
      cardMessageId: 100,
    });
    expect(after).toHaveBeenCalledOnce();
  });

  it("keeps a transition made meanwhile, writes only the lost facts, and decides again", async () => {
    const store = new MemoryHarnessStore();
    const request = await stored(store, S.prReady);
    const seen: Array<Pick<HarnessRequestRecord, "state" | "cardMessageId">> = [];
    const after = vi.fn(async () => {});
    const won = await optimisticTransition(store, request, async (snapshot) => {
      seen.push({ state: snapshot.state, cardMessageId: snapshot.cardMessageId });
      if (seen.length === 1) {
        await store.transitionRequest(request.id, [S.prReady], S.cancelled, {
          stateReason: "owner",
        });
      }
      return {
        to: snapshot.state,
        fields: { title: `attempt ${seen.length}` },
        facts: { cardMessageId: 100 },
        after,
      };
    });
    expect(won).toBe(true);
    expect(seen).toEqual([
      { state: S.prReady, cardMessageId: null },
      { state: S.cancelled, cardMessageId: 100 },
    ]);
    expect(await store.getRequest(request.id)).toMatchObject({
      state: S.cancelled,
      stateReason: "owner",
      title: "attempt 2",
    });
    expect(after).toHaveBeenCalledOnce();
  });

  it("rejects with a failing `after` once the transition is committed", async () => {
    const store = new MemoryHarnessStore();
    const request = await stored(store, S.running);
    const decide = vi.fn(async () => ({
      to: S.prReady,
      fields: { title: "linked" },
      after: async () => {
        throw new Error("session down");
      },
    }));
    await expect(optimisticTransition(store, request, decide)).rejects.toThrow("session down");
    expect(await store.getRequest(request.id)).toMatchObject({ state: S.prReady, title: "linked" });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("gives up after its retries without running `after`", async () => {
    const store = new MemoryHarnessStore();
    const request = await stored(store, S.queued);
    const after = vi.fn(async () => {});
    let attempts = 0;
    const won = await optimisticTransition(store, request, async (snapshot) => {
      attempts++;
      const next = snapshot.state === S.queued ? S.starting : S.queued;
      await store.transitionRequest(request.id, [snapshot.state], next);
      return { to: S.needsAttention, after };
    });
    expect(won).toBe(false);
    expect(attempts).toBe(TRANSITION_RETRIES + 1);
    expect(after).not.toHaveBeenCalled();
    expect((await store.getRequest(request.id))?.state).not.toBe(S.needsAttention);
  });

  it("stops once the request is gone", async () => {
    const store = new MemoryHarnessStore();
    const request = await stored(store, S.open);
    const decide = vi.fn(async () => {
      store.requests.delete(request.id);
      return { to: S.closed };
    });
    expect(await optimisticTransition(store, request, decide)).toBe(false);
    expect(decide).toHaveBeenCalledOnce();
  });

  it("leaves `state` out of field patches", () => {
    // @ts-expect-error `state` changes only through transitionRequest.
    const literal: HarnessRequestPatch = { state: S.cancelled };
    const record = { state: S.cancelled } as HarnessRequestRecord;
    // @ts-expect-error nor can a whole record carry it in.
    const widened: HarnessRequestPatch = record;
    expect([literal, widened]).toHaveLength(2);
  });
});

describe("prTransition", () => {
  const open = { merged: false, state: "open" as const };
  const work = (state: string) => ({ type: "bug", state });

  it("takes merged and closed from GitHub", () => {
    expect(prTransition(work(S.cancelled), { merged: true, state: "closed" }, false).to).toBe(
      S.merged,
    );
    expect(prTransition(work(S.running), { merged: false, state: "closed" }, true).to).toBe(
      S.closed,
    );
  });

  it("keeps a pr request open and a work request's stage until its session pushes", () => {
    expect(prTransition({ type: "pr", state: S.open }, open, true).to).toBe(S.open);
    const kept = [S.received, S.queued, S.starting, S.needsAttention, S.needsSpec, S.cancelled];
    for (const state of kept) {
      expect(prTransition(work(state), open, true).to).toBe(state);
    }
    expect(prTransition(work(S.running), open, false).to).toBe(S.running);
    expect(prTransition(work(S.revising), open, false).to).toBe(S.revising);
    for (const state of [S.running, S.revising]) {
      expect(prTransition(work(state), open, true).to).toBe(S.prReady);
    }
    expect(prTransition(work(S.failed), open, true).to).toBe(S.failed);
    expect(prTransition(work(S.completed), open, false).to).toBe(S.prReady);
    expect(prTransition(work(S.closed), open, false).to).toBe(S.prReady);
  });

  it("clears the reason only when the request enters pr_ready", () => {
    expect(prTransition(work(S.revising), open, true).fields).toEqual({ stateReason: null });
    expect(prTransition(work(S.prReady), open, true).fields).toEqual({});
    expect(prTransition(work(S.needsAttention), open, true).fields).toEqual({});
  });
});
