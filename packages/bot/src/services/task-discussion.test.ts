import { describe, expect, it } from "vitest";
import { beginTaskDiscussion, endTaskDiscussion, hasTaskDiscussion } from "./task-discussion.js";
const actor = {
  botId: "bot",
  chatId: -100,
  threadId: 7,
  userId: 42,
  userName: "member",
  isAdmin: false,
};
describe("task configuration discussion", () => {
  it("isolates users, bots, chats and real topics and expires", () => {
    beginTaskDiscussion(actor, 1000);
    expect(hasTaskDiscussion(actor, 1001)).toBe(true);
    for (const other of [
      { ...actor, botId: "other" },
      { ...actor, userId: 43 },
      { ...actor, chatId: -200 },
      { ...actor, threadId: undefined },
    ])
      expect(hasTaskDiscussion(other, 1001)).toBe(false);
    expect(hasTaskDiscussion(actor, 601000)).toBe(false);
  });
  it("ends when a complete plan is proposed", () => {
    beginTaskDiscussion(actor);
    endTaskDiscussion(actor);
    expect(hasTaskDiscussion(actor)).toBe(false);
  });
});
