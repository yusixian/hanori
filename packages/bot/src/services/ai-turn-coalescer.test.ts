import { describe, expect, it } from "vitest";
import { AiTurnCoalescer } from "./ai-turn-coalescer.js";

const CHAT = -100;
const USER = 42;

function entry(tgMessageId: number, text = `msg-${tgMessageId}`) {
  return { tgMessageId, text, sourceKey: `telegram:${tgMessageId}:user` };
}

describe("AiTurnCoalescer", () => {
  it("appends follow-ups from the same chat and user into the open batch", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(CHAT, USER);

    expect(coalescer.tryAppend(CHAT, USER, entry(12))).toBe(true);
    expect(coalescer.tryAppend(CHAT, USER, entry(13))).toBe(true);
    expect(handle.drain().map((m) => m.tgMessageId)).toEqual([12, 13]);
  });

  it("rejects appends from another user or another chat", () => {
    const coalescer = new AiTurnCoalescer();
    coalescer.open(CHAT, USER);

    expect(coalescer.tryAppend(CHAT, USER + 1, entry(12))).toBe(false);
    expect(coalescer.tryAppend(CHAT - 1, USER, entry(12))).toBe(false);
  });

  it("rejects appends after drain and drains only once", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(CHAT, USER);
    coalescer.tryAppend(CHAT, USER, entry(12));

    expect(handle.drain()).toHaveLength(1);
    expect(handle.drain()).toHaveLength(0);
    expect(coalescer.tryAppend(CHAT, USER, entry(13))).toBe(false);
  });

  it("returns undrained messages on close so cancelled runs can finalize them", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(CHAT, USER);
    coalescer.tryAppend(CHAT, USER, entry(12));

    expect(handle.close().map((m) => m.tgMessageId)).toEqual([12]);
    expect(handle.drain()).toHaveLength(0);
  });

  it("routes appends to the newest open batch and keeps older handles independent", () => {
    const coalescer = new AiTurnCoalescer();
    const first = coalescer.open(CHAT, USER);
    coalescer.tryAppend(CHAT, USER, entry(12));
    const second = coalescer.open(CHAT, USER);
    coalescer.tryAppend(CHAT, USER, entry(13));

    expect(first.drain().map((m) => m.tgMessageId)).toEqual([12]);
    expect(second.drain().map((m) => m.tgMessageId)).toEqual([13]);
  });

  it("keeps older handle's map entry intact when a newer batch closes", () => {
    const coalescer = new AiTurnCoalescer();
    coalescer.open(CHAT, USER);
    const second = coalescer.open(CHAT, USER);
    second.close();

    expect(coalescer.tryAppend(CHAT, USER, entry(12))).toBe(false);
  });

  it("stops accepting appends after destroy but handles still close with their extras", () => {
    const coalescer = new AiTurnCoalescer();
    const handle = coalescer.open(CHAT, USER);
    coalescer.tryAppend(CHAT, USER, entry(12));
    coalescer.destroy();

    expect(coalescer.tryAppend(CHAT, USER, entry(13))).toBe(false);
    expect(handle.close().map((m) => m.tgMessageId)).toEqual([12]);
  });
});
