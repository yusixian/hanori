import type { Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createOnceGuard } from "./utils.js";
import { createTelegramTools } from "./telegram.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

function run(tools: Record<string, Tool>, name: string, input: unknown) {
  return (tools[name] as Tool as unknown as ExecutableTool).execute(input, {
    abortSignal: new AbortController().signal,
  });
}

describe("reply_to_specific target validation", () => {
  it("reports the delivered parent and topic for conversation persistence", async () => {
    const onTextMessageSent = vi.fn();
    const api = {
      sendMessage: vi.fn().mockResolvedValue({
        message_id: 9001,
        reply_to_message: { message_id: 4902 },
        is_topic_message: true,
        message_thread_id: 77,
      }),
    } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      getReplyableMessageIds: () => [4902],
      onTextMessageSent,
    });
    await run(tools, "reply_to_specific", { reply_to_message_id: 4902, text: "Fictional reply" });
    expect(onTextMessageSent).toHaveBeenCalledWith(9001, "Fictional reply", 4902, 77);
  });

  it("refuses a message id the model never saw and lists the ids it may use", async () => {
    const api = { sendMessage: vi.fn() } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      getReplyableMessageIds: () => [4901, 4902],
    });

    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4820,
      text: "《Different hydration and rendering strategies》摘要……",
    });

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ available_message_ids: [4901, 4902] });
    expect((result as { error: string }).error).toContain("4820");
  });

  it("never returns the text of the messages it offers as alternatives", async () => {
    const api = { sendMessage: vi.fn() } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      getReplyableMessageIds: () => [4901],
    });

    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4820,
      text: "摘要",
    });

    expect(Object.keys(result as object).sort()).toEqual(["available_message_ids", "error"]);
  });

  it("sends a reply whose target the model read in the group context", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 9001 }),
    } as unknown as Api;
    const recentBotMessageIds: number[] = [];
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds,
      getReplyableMessageIds: () => [4901, 4902],
    });

    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4902,
      text: "这篇讲了 hydration 的几种策略",
    });

    expect(api.sendMessage).toHaveBeenCalledWith(-1001, "这篇讲了 hydration 的几种策略", {
      reply_parameters: { message_id: 4902 },
    });
    expect(result).toEqual({
      success: true,
      message_id: 9001,
      replied_to_message_id: 4902,
    });
    expect(recentBotMessageIds).toEqual([9001]);
  });

  it("lets the bot reply to a message it just sent itself", async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 9001 }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 9002 }),
    } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [8800],
      getReplyableMessageIds: () => [],
    });

    const previous = await run(tools, "reply_to_specific", {
      reply_to_message_id: 8800,
      text: "补充一句",
    });
    expect(previous).toMatchObject({ available_message_ids: [] });
    expect(api.sendMessage).not.toHaveBeenCalled();

    const sent = await run(tools, "send_photo", { photo: "telegram-file-id" });
    expect(sent).toMatchObject({ message_id: 9001 });
    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 9001,
      text: "补充一句",
    });
    expect(result).toMatchObject({ success: true, replied_to_message_id: 9001 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not expose old bot ids even when the shared history is trimmed", async () => {
    const api = { sendMessage: vi.fn() } as unknown as Api;
    const recentBotMessageIds = [8800, 8801];
    const tools = createTelegramTools({ api, chatId: -1001, recentBotMessageIds });
    recentBotMessageIds.shift();
    recentBotMessageIds.push(9001);

    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 8801,
      text: "猜中的旧 bot 消息",
    });
    expect(result).toMatchObject({ available_message_ids: [9001] });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves the once guard intact so the corrected retry still sends", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 9003 }),
    } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      onceGuard: createOnceGuard(),
      getReplyableMessageIds: () => [4901],
    });

    const refused = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4820,
      text: "摘要",
    });
    const retried = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4901,
      text: "摘要",
    });

    expect(refused).toMatchObject({ available_message_ids: [4901] });
    expect(retried).toMatchObject({ success: true, replied_to_message_id: 4901 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still blocks a second delivered reply in the same turn", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 9004 }),
    } as unknown as Api;
    const tools = createTelegramTools({
      api,
      chatId: -1001,
      recentBotMessageIds: [],
      onceGuard: createOnceGuard(),
      getReplyableMessageIds: () => [4901, 4902],
    });

    await run(tools, "reply_to_specific", { reply_to_message_id: 4901, text: "第一条" });
    const second = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4902,
      text: "第二条",
    });

    expect(second).toMatchObject({ blocked: true });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses every id when the caller supplies no visible messages", async () => {
    const api = { sendMessage: vi.fn() } as unknown as Api;
    const tools = createTelegramTools({ api, chatId: -1001, recentBotMessageIds: [] });

    const result = await run(tools, "reply_to_specific", {
      reply_to_message_id: 4820,
      text: "摘要",
    });

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ available_message_ids: [] });
  });
});
