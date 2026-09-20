import { asSchema, type Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createToolSchemaHash } from "../utils/prompt-cache.js";
import { createArtworkTools } from "./artwork/index.js";
import { createBehaviorTools } from "./behavior.js";
import { createTelegramTools } from "./telegram.js";
import {
  createTurnInteractionTools,
  type TurnInteractionToolsOptions,
} from "./turn-interaction.js";
import { createOnceGuard } from "./utils.js";

function fixture(): TurnInteractionToolsOptions {
  let nextId = 100;
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
      sendPhoto: vi.fn(async () => ({ message_id: nextId++ })),
    } as unknown as Api,
    chatId: -1001,
    recentBotMessageIds: [90],
    onceGuard: createOnceGuard(),
    telegram: { userId: 42, timerMaxSeconds: 604_800 },
    behavior: { moodState: new Map(), richMessageEnabled: false },
    artwork: { config: { enabled: true } },
  };
}

function run(tools: Record<string, Tool>, name: string, input: unknown) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`Missing executable tool: ${name}`);
  return execute(input as never, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

describe("turn interaction assembly", () => {
  it.each([
    { chatId: 42, userId: 42, artworkEnabled: true },
    { chatId: -1001, userId: 42, artworkEnabled: true },
    { chatId: -1001, userId: undefined, artworkEnabled: true },
    { chatId: 42, userId: 42, artworkEnabled: false },
    { chatId: -1001, userId: 42, artworkEnabled: false },
    { chatId: -1001, userId: undefined, artworkEnabled: false },
  ])("preserves names and schemas for %j", ({ chatId, userId, artworkEnabled }) => {
    const options = fixture();
    options.chatId = chatId;
    options.telegram.userId = userId;
    options.artwork = { config: { enabled: artworkEnabled } };
    const { api, recentBotMessageIds, onceGuard } = options;
    const common = { api, chatId, recentBotMessageIds };
    const legacy = {
      telegramTools: createTelegramTools({ ...common, onceGuard, ...options.telegram }),
      behaviorTools: createBehaviorTools({ ...common, ...options.behavior }),
      artworkTools: artworkEnabled
        ? createArtworkTools({ ...common, onceGuard, ...options.artwork })
        : {},
    };
    const assembled = createTurnInteractionTools(options);
    for (const family of ["telegramTools", "behaviorTools", "artworkTools"] as const) {
      expect(Object.keys(assembled[family]).sort()).toEqual(Object.keys(legacy[family]).sort());
      expect(createToolSchemaHash(assembled[family])).toBe(createToolSchemaHash(legacy[family]));
    }
    expect(asSchema(assembled.telegramTools.set_timer!.inputSchema).jsonSchema).toMatchObject({
      properties: { seconds: { maximum: 604_800 } },
    });
  });

  it("keeps lazy visible targets and shares newly delivered behavior message IDs", async () => {
    const options = fixture();
    const visibleIds: number[] = [];
    const delivered = vi.fn();
    options.telegram.getReplyableMessageIds = () => visibleIds;
    options.behavior.onMultiMessageSent = delivered;
    const { telegramTools, behaviorTools } = createTurnInteractionTools(options);

    expect(
      await run(telegramTools, "reply_to_specific", { reply_to_message_id: 90, text: "old" }),
    ).toMatchObject({ available_message_ids: [] });
    visibleIds.push(80);
    expect(
      await run(telegramTools, "reply_to_specific", { reply_to_message_id: 81, text: "unseen" }),
    ).toMatchObject({ available_message_ids: [80] });
    expect(options.api.sendMessage).not.toHaveBeenCalled();

    expect(
      await run(behaviorTools, "multi_message", { messages: [{ text: "one" }, { text: "two" }] }),
    ).toEqual({ sent: 2 });
    expect(delivered.mock.calls).toEqual([
      ["one", 100],
      ["two", 101],
    ]);
    expect(options.recentBotMessageIds).toEqual([90, 100, 101]);
    expect(
      await run(telegramTools, "reply_to_specific", {
        reply_to_message_id: 101,
        text: "follow up",
      }),
    ).toMatchObject({ success: true, replied_to_message_id: 101 });
    expect(
      await run(telegramTools, "reply_to_specific", { reply_to_message_id: 80, text: "again" }),
    ).toMatchObject({ blocked: true });
    expect(options.api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("uses the caller's guard for both Telegram and artwork without sharing it across turns", async () => {
    const first = fixture();
    first.onceGuard!.markFired("send_photo");
    first.onceGuard!.markFired("send_artwork");
    const blocked = createTurnInteractionTools(first);
    expect(await run(blocked.telegramTools, "send_photo", { photo: "file" })).toMatchObject({
      blocked: true,
    });
    expect(await run(blocked.artworkTools, "send_artwork", {})).toMatchObject({ blocked: true });
    expect(first.api.sendPhoto).not.toHaveBeenCalled();

    const next = fixture();
    const fresh = createTurnInteractionTools(next);
    expect(await run(fresh.telegramTools, "send_photo", { photo: "file" })).toMatchObject({
      success: true,
    });
    expect(await run(fresh.artworkTools, "send_artwork", {})).toEqual({
      error: "请先调用 fetch_artwork_info 获取作品信息",
    });
    expect(next.api.sendPhoto).toHaveBeenCalledOnce();
  });
});
