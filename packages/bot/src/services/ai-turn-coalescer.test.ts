import { describe, expect, it } from "vitest";
import { AiTurnCoalescer } from "./ai-turn-coalescer.js";

const CHAT = -100;
const USER = 42;
const SCOPE = { chatId: CHAT, userId: USER, privacyMode: "normal" as const };

function entry(tgMessageId: number, text = `msg-${tgMessageId}`) {
  return {
    tgMessageId,
    text,
    userAuthoredContent: text,
    sourceKey: `telegram:${tgMessageId}:user`,
  };
}

describe("AiTurnCoalescer", () => {
  it("appends follow-ups from the same chat and user into the open batch", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(SCOPE);

    expect(coalescer.tryAppend(SCOPE, entry(12))).toBe(true);
    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(true);
    expect(handle.drain().map((m) => m.tgMessageId)).toEqual([12, 13]);
  });

  it("rejects appends from another user or another chat", () => {
    const coalescer = new AiTurnCoalescer();
    coalescer.open(SCOPE);

    expect(coalescer.tryAppend({ ...SCOPE, userId: USER + 1 }, entry(12))).toBe(false);
    expect(coalescer.tryAppend({ ...SCOPE, chatId: CHAT - 1 }, entry(12))).toBe(false);
  });

  it("keeps privacy-mode admissions in separate batches", () => {
    const coalescer = new AiTurnCoalescer();
    coalescer.open(SCOPE);

    expect(coalescer.tryAppend({ ...SCOPE, privacyMode: "off" }, entry(12))).toBe(false);
  });

  it("keeps forum topics apart", () => {
    const coalescer = new AiTurnCoalescer();
    const topicA = coalescer.open({ ...SCOPE, threadId: 7 });
    coalescer.open({ ...SCOPE, threadId: 9 });

    expect(coalescer.tryAppend({ ...SCOPE, threadId: 9 }, entry(12))).toBe(true);
    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(false);
    expect(topicA.drain()).toHaveLength(0);
  });

  it("rejects appends after drain and drains only once", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(12));

    expect(handle.drain()).toHaveLength(1);
    expect(handle.drain()).toHaveLength(0);
    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(false);
  });

  it("returns undrained messages on close so cancelled runs can finalize them", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(12));

    expect(handle.close().map((m) => m.tgMessageId)).toEqual([12]);
    expect(handle.drain()).toHaveLength(0);
  });

  it("stops later appends without discarding extras already owned by the handle", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(12));

    coalescer.stopAccepting(SCOPE);

    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(false);
    expect(handle.drain().map((message) => message.tgMessageId)).toEqual([12]);
  });

  it("routes appends to the newest open batch and keeps older handles independent", () => {
    const coalescer = new AiTurnCoalescer();
    const first = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(12));
    const second = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(13));

    expect(first.drain().map((m) => m.tgMessageId)).toEqual([12]);
    expect(second.drain().map((m) => m.tgMessageId)).toEqual([13]);
  });

  it("does not expose an older batch again when a newer batch closes", () => {
    const coalescer = new AiTurnCoalescer();
    coalescer.open(SCOPE);
    const second = coalescer.open(SCOPE);
    second.close();

    expect(coalescer.tryAppend(SCOPE, entry(12))).toBe(false);
  });

  it("stops accepting appends after clear but handles still close with their extras", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(SCOPE);
    coalescer.tryAppend(SCOPE, entry(12));
    coalescer.clear();

    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(false);
    expect(handle.close().map((m) => m.tgMessageId)).toEqual([12]);
  });

  it("declines past the message-count ceiling so overflow hits the scheduler queue", () => {
    const coalescer = new AiTurnCoalescer({ maxMessages: 2 });
    const handle = coalescer.open(SCOPE);

    expect(coalescer.tryAppend(SCOPE, entry(12))).toBe(true);
    expect(coalescer.tryAppend(SCOPE, entry(13))).toBe(true);
    expect(coalescer.tryAppend(SCOPE, entry(14))).toBe(false);
    expect(handle.drain()).toHaveLength(2);
  });

  it("declines past the total-character ceiling", () => {
    const coalescer = new AiTurnCoalescer({ maxChars: 10 });
    const handle = coalescer.open(SCOPE);

    expect(coalescer.tryAppend(SCOPE, entry(12, "123456"))).toBe(true);
    expect(coalescer.tryAppend(SCOPE, entry(13, "123456"))).toBe(false);
    // A smaller message still fits after a larger one was rejected.
    expect(coalescer.tryAppend(SCOPE, entry(14, "1234"))).toBe(true);
    expect(handle.drain().map((m) => m.tgMessageId)).toEqual([12, 14]);
  });
});
