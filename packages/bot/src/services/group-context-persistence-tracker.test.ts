import { describe, expect, it } from "vitest";
import { GroupContextPersistenceTracker } from "./group-context-persistence-tracker.js";

interface Message {
  messageId: number;
  text: string;
}

describe("GroupContextPersistenceTracker", () => {
  it("does not save a previous trigger again as group context", () => {
    const tracker = new GroupContextPersistenceTracker();
    const firstBuffer: Message[] = [
      { messageId: 1, text: "ambient" },
      { messageId: 2, text: "first trigger" },
    ];

    expect(
      tracker.selectUnsavedContext(10, 2, firstBuffer).map((message) => message.messageId),
    ).toEqual([1]);
    tracker.commitReply(
      10,
      2,
      1,
      firstBuffer.map((message) => message.messageId),
    );

    const secondBuffer: Message[] = [
      ...firstBuffer,
      { messageId: 3, text: "new ambient" },
      { messageId: 4, text: "second trigger" },
    ];
    expect(
      tracker.selectUnsavedContext(10, 4, secondBuffer).map((message) => message.messageId),
    ).toEqual([3]);
  });

  it("keeps individually saved ids bounded to messages still in the ring buffer", () => {
    const tracker = new GroupContextPersistenceTracker();

    tracker.commitReply(10, 1, undefined, [1]);
    tracker.commitReply(10, 2, undefined, [1, 2]);
    tracker.commitReply(10, 3, undefined, [2, 3]);

    expect(
      tracker
        .selectUnsavedContext(10, 4, [
          { messageId: 1, text: "evicted message" },
          { messageId: 4, text: "current trigger" },
        ])
        .map((message) => message.messageId),
    ).toEqual([1]);
  });

  it("clears all persistence state for an expired group buffer", () => {
    const tracker = new GroupContextPersistenceTracker();
    tracker.commitReply(10, 2, 1, [1, 2]);

    tracker.clearChat(10);

    expect(
      tracker
        .selectUnsavedContext(10, 3, [
          { messageId: 2, text: "old trigger" },
          { messageId: 3, text: "current trigger" },
        ])
        .map((message) => message.messageId),
    ).toEqual([2]);
  });
});
