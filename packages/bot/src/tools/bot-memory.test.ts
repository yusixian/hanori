import type { BotMemoryCallbacks } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createBotMemoryTools, explicitlyRequestsMemoryForget } from "./bot-memory.js";

function createCallbacks() {
  const saveMemory = vi.fn().mockResolvedValue({ id: 1 });
  const recallMemories = vi.fn().mockResolvedValue([]);
  const updateMemory = vi.fn().mockResolvedValue({ id: 1 });
  const retireMemory = vi.fn().mockResolvedValue(true);
  const deleteMemory = vi.fn().mockResolvedValue(true);
  return {
    callbacks: {
      saveMemory,
      recallMemories,
      updateMemory,
      retireMemory,
      deleteMemory,
    } as unknown as BotMemoryCallbacks,
    saveMemory,
    recallMemories,
    updateMemory,
    retireMemory,
    deleteMemory,
  };
}

async function execute(tool: Tool | undefined, args: object) {
  if (!tool?.execute) throw new Error("Expected executable tool");
  return tool.execute(args, {} as never);
}

describe("Bot memory tools", () => {
  it("binds personal scope and provenance to the current message", async () => {
    const { callbacks, saveMemory } = createCallbacks();
    const tools = createBotMemoryTools(callbacks, {
      chatId: -100,
      userId: 42,
      messageId: 9,
      privacyMode: "normal",
    });

    await execute(tools.save_memory, {
      content: "Likes tea",
      kind: "preference",
      scope: "current_user",
      telegram_id: 999,
      source_user_id: 999,
      scope_chat_id: -999,
    });
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramId: 42,
        scopeChatId: undefined,
        origin: "agent",
        sourceChatId: -100,
        sourceMessageId: 9,
        sourceUserId: 42,
      }),
    );
  });

  it("chat-scopes shared facts, experiences, relationships and isolated personal facts", async () => {
    const { callbacks, saveMemory } = createCallbacks();
    const normal = createBotMemoryTools(callbacks, { chatId: -100, userId: 42 });
    await execute(normal.save_memory, { content: "Group rule", kind: "fact", scope: "chat" });
    await execute(normal.save_memory, {
      content: "We planned to meet",
      kind: "commitment",
      scope: "current_user",
    });
    const isolated = createBotMemoryTools(callbacks, {
      chatId: -100,
      userId: 42,
      privacyMode: "isolated",
    });
    await execute(isolated.save_memory, {
      content: "Likes tea",
      kind: "preference",
      scope: "current_user",
    });

    expect(saveMemory.mock.calls[0]?.[0]).toMatchObject({ scopeChatId: -100 });
    expect(saveMemory.mock.calls[0]?.[0].telegramId).toBeUndefined();
    expect(saveMemory.mock.calls[1]?.[0]).toMatchObject({ telegramId: 42, scopeChatId: -100 });
    expect(saveMemory.mock.calls[2]?.[0]).toMatchObject({ telegramId: 42, scopeChatId: -100 });
  });

  it("restricts recall and mutation access to the trusted user and chat", async () => {
    const { callbacks, recallMemories, updateMemory, retireMemory } = createCallbacks();
    const tools = createBotMemoryTools(callbacks, {
      chatId: -100,
      userId: 42,
      privacyMode: "isolated",
    });
    await execute(tools.recall_memories, {
      query: "tea",
      scope: "current_user",
      telegram_id: 999,
    });
    await execute(tools.update_memory, {
      memory_id: 3,
      expected_content: "Likes tea",
      content: "Now likes coffee",
    });
    await execute(tools.retire_memory, {
      memory_id: 3,
      expected_content: "Likes tea",
      superseded_by_id: 4,
    });

    expect(recallMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramId: 42,
        scopeChatId: -100,
        includeUnscopedPersonal: false,
        scope: "user_only",
      }),
    );
    expect(updateMemory).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ expectedContent: "Likes tea", content: "Now likes coffee" }),
      { chatId: -100, userId: 42, includeUnscopedPersonal: false },
    );
    expect(retireMemory).toHaveBeenCalledWith(
      3,
      4,
      { chatId: -100, userId: 42, includeUnscopedPersonal: false },
      "Likes tea",
    );
    await expect(
      execute(tools.update_memory, { memory_id: 3, expected_content: "Likes tea" }),
    ).resolves.toEqual({
      error: "没有提供要修改的内容",
    });
    expect(updateMemory).toHaveBeenCalledTimes(1);
    await expect(execute(tools.retire_memory, { memory_id: 3 })).resolves.toEqual({
      error: "缺少刚检索到的原记忆内容",
    });
    expect(retireMemory).toHaveBeenCalledTimes(1);
  });

  it("filters out-of-scope callback results before giving them to the model", async () => {
    const { callbacks, recallMemories } = createCallbacks();
    const base = { id: 1, telegramId: 42, scopeChatId: -100 };
    recallMemories.mockResolvedValue([
      { ...base, id: 1, telegramId: 99 },
      { ...base, id: 2, scopeChatId: -999 },
      { ...base, id: 3, scopeChatId: null },
      { ...base, id: 4 },
    ]);
    const tools = createBotMemoryTools(callbacks, {
      chatId: -100,
      userId: 42,
      privacyMode: "isolated",
    });

    await expect(execute(tools.recall_memories, { query: "tea" })).resolves.toEqual({
      count: 1,
      memories: [{ ...base, id: 4 }],
    });
  });

  it("only exposes hard deletion when the current user explicitly requests forgetting", async () => {
    const { callbacks, deleteMemory } = createCallbacks();
    const ordinary = createBotMemoryTools(callbacks, { chatId: 42, userId: 42 });
    expect(ordinary.delete_memory).toBeUndefined();

    const explicit = createBotMemoryTools(callbacks, {
      chatId: 42,
      userId: 42,
      allowHardDelete: explicitlyRequestsMemoryForget("请忘记我喜欢咖啡这件事"),
    });
    await execute(explicit.delete_memory, { memory_id: 3 });
    expect(deleteMemory).toHaveBeenCalledWith(3, {
      chatId: 42,
      userId: 42,
      includeUnscopedPersonal: true,
    });
    expect(explicitlyRequestsMemoryForget("他说请忘记我喜欢咖啡")).toBe(false);
    expect(explicitlyRequestsMemoryForget("把你记住的我喜欢咖啡删掉")).toBe(true);
    expect(explicitlyRequestsMemoryForget("删除我的聊天记录")).toBe(false);
    expect(explicitlyRequestsMemoryForget("Delete my tea preference")).toBe(true);
  });

  it("does not offer writes on continuations or forwarded turns", () => {
    const { callbacks } = createCallbacks();
    const tools = createBotMemoryTools(callbacks, {
      chatId: -100,
      allowSave: false,
      allowMutations: false,
    });
    expect(tools.save_memory).toBeUndefined();
    expect(tools.update_memory).toBeUndefined();
    expect(tools.retire_memory).toBeUndefined();
    expect(tools.recall_memories).toBeDefined();
    const forwarded = createBotMemoryTools(callbacks, {
      chatId: -100,
      userId: 42,
      messageId: 9,
      allowSave: false,
      allowMutations: false,
      allowHardDelete: false,
    });
    expect(forwarded.save_memory).toBeUndefined();
    expect(forwarded.update_memory).toBeUndefined();
    expect(forwarded.retire_memory).toBeUndefined();
    expect(forwarded.delete_memory).toBeUndefined();
  });
});
