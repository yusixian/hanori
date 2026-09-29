import { DEFAULT_MESSAGE_CONFIG, DEFAULT_TIMER_MAX_SECONDS } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { assembleContext } from "../services/context-assembler.js";
import { buildExtendedToolsPrompt } from "../utils/tools-prompt.js";
import {
  ADMIN_ID,
  FORGET_REQUEST,
  GROUP_ID,
  MEMBER_ID,
  assemble,
  continuation,
  createToolsetConfig,
  reply,
  run,
} from "./turn-toolset-test-helpers.js";
import { resolveImageGenerationActor, type TurnToolset } from "./turn-toolset.js";

const LONG_TERM_MEMORY_WRITES = ["save_memory", "update_memory", "retire_memory", "delete_memory"];

const REPLY_ONLY_TOOLS = [
  "delete_generation_character",
  "delete_prompt_asset",
  "inspect_replied_image_generation",
  "mcp1_lookup",
  "mcp1_rotate_keys",
  "react_to_message",
  "remove_character_binding",
  "retire_memory",
  "save_memory",
  "save_original_character",
  "save_prompt_asset",
  "send_sticker",
  "set_character_binding",
  "update_memory",
];

function promptFor(toolset: TurnToolset): string {
  return buildExtendedToolsPrompt({
    capabilities: toolset.capabilities,
    availableAgents: [],
    isPrivate: false,
    timerMaxSeconds: DEFAULT_TIMER_MAX_SECONDS,
  });
}

describe("turn toolset", () => {
  it("offers continuations exactly the reply families minus the declared reply-only tools", async () => {
    const replyNames = Object.keys((await assemble(reply())).tools);
    const continueNames = Object.keys((await assemble(continuation())).tools);

    expect(continueNames.filter((name) => !replyNames.includes(name))).toEqual([]);
    expect(
      replyNames.filter((name) => !continueNames.includes(name) && !name.startsWith("github_")),
    ).toEqual(REPLY_ONLY_TOOLS);
    expect(replyNames.some((name) => name.startsWith("github_"))).toBe(true);
  });

  it("keeps forwarded content from authorizing any long-term memory write", async () => {
    const forwarded = await assemble(reply({ forwarded: true, text: FORGET_REQUEST }));

    expect(forwarded.tools.recall_memories).toBeDefined();
    for (const name of LONG_TERM_MEMORY_WRITES) expect(forwarded.tools[name]).toBeUndefined();
    expect(forwarded.capabilities.has("bot-memory")).toBe(true);
  });

  it("offers hard deletion only for the sender's own forget request", async () => {
    const authored = await assemble(reply({ text: FORGET_REQUEST }));
    const quoted = await assemble(reply({ text: "他说请忘记我喜欢咖啡" }));
    const continued = await assemble(continuation());

    for (const name of LONG_TERM_MEMORY_WRITES) expect(authored.tools[name]).toBeDefined();
    expect(quoted.tools.save_memory).toBeDefined();
    expect(quoted.tools.delete_memory).toBeUndefined();
    for (const name of LONG_TERM_MEMORY_WRITES) expect(continued.tools[name]).toBeUndefined();
  });

  it("drops a family and its prompt capability when its port or config is missing", async () => {
    const bare = await assemble(reply(), {
      config: createToolsetConfig({
        memory: undefined,
        botMemory: undefined,
        webTools: undefined,
        artworkToolsConfig: undefined,
        dataFiles: undefined,
        generationLibraryPort: undefined,
        imageGenerationPort: undefined,
      }),
      delegation: undefined,
    });

    for (const name of [
      "get_profile",
      "recall_memories",
      "fetch_webpage",
      "fetch_artwork_info",
      "read_file",
      "search_generation_characters",
      "get_image_generation",
      "delegate_task",
    ]) {
      expect(bare.tools[name]).toBeUndefined();
    }
    expect([...bare.capabilities].sort()).toEqual(["multi-message", "sticker"]);
    await expect(run(bare.tools, "load_skill", { skill: "prompt-atelier" })).resolves.toMatchObject(
      {
        runtime: {
          imageGeneration: expect.stringContaining("No image-generation tool"),
          webSearch: expect.stringContaining("web_search is unavailable"),
        },
      },
    );
  });

  it("stops promising image generation from a legacy image config without an image port", async () => {
    const toolset = await assemble(reply(), {
      config: createToolsetConfig({ imageGenerationPort: undefined }),
    });
    const bundle = await assembleContext({
      systemPrompt: "System",
      isPrivate: false,
      chatId: GROUP_ID,
      userName: "Nahida",
      maxContextMessages: 20,
      webToolsConfig: {
        enabled: true,
        imageGeneration: { provider: "openai", apiKey: "image-key" },
      },
      toolCapabilities: toolset.capabilities,
    });

    expect(toolset.tools.get_image_generation).toBeUndefined();
    expect(toolset.capabilities.has("image-generation")).toBe(false);
    expect(bundle.messages[0]!.content).not.toContain("异步生图工具");
    expect(bundle.messages[0]!.content).toContain("- fetch_webpage: 获取网页正文内容");
  });

  it("keeps an ownerless continuation away from user-bound tools and their prompt", async () => {
    const config = createToolsetConfig();
    const ownerless = await assemble(continuation(), { config, userId: undefined });

    expect(await resolveImageGenerationActor(config, { chatId: GROUP_ID, isPrivate: false })).toBe(
      undefined,
    );
    for (const name of [
      "get_image_generation",
      "search_generation_characters",
      "get_profile_avatar",
      "mark_rss_read",
    ]) {
      expect(ownerless.tools[name]).toBeUndefined();
    }
    expect(ownerless.tools.list_rss_feeds).toBeDefined();
    expect(ownerless.capabilities.has("image-generation")).toBe(false);
    expect(promptFor(ownerless)).not.toContain("异步生图工具");
  });

  it("resolves delegated group admins only for ordinary group members", async () => {
    const isDelegatedGroupAdmin = vi.fn().mockResolvedValue(true);
    const config = createToolsetConfig({ isDelegatedGroupAdmin });

    await expect(
      resolveImageGenerationActor(config, {
        chatId: GROUP_ID,
        isPrivate: false,
        userId: MEMBER_ID,
      }),
    ).resolves.toEqual({
      botId: "bot-1",
      chatId: GROUP_ID,
      userId: MEMBER_ID,
      chatType: "supergroup",
      isBotAdmin: false,
      isDelegatedGroupAdmin: true,
    });
    await resolveImageGenerationActor(config, {
      chatId: GROUP_ID,
      isPrivate: false,
      userId: ADMIN_ID,
    });
    await resolveImageGenerationActor(config, {
      chatId: MEMBER_ID,
      isPrivate: true,
      userId: MEMBER_ID,
    });
    expect(isDelegatedGroupAdmin).toHaveBeenCalledOnce();
  });

  it.each([reply(), continuation()])(
    "binds $kind file tools to the data directory and protects injectable files",
    async (entry) => {
      const withFiles = await assemble(entry);
      const withoutFiles = await assemble(entry, {
        config: createToolsetConfig({ dataFiles: undefined }),
      });

      expect(withFiles.capabilities.has("file")).toBe(true);
      await expect(run(withFiles.tools, "delete_file", { path: "IDENTITY.md" })).resolves.toEqual({
        error: "This file is protected (injectable) and cannot be deleted",
      });
      expect(withoutFiles.tools.read_file).toBeUndefined();
      expect(withoutFiles.capabilities.has("file")).toBe(false);
    },
  );

  it("withholds multi_message, and its prompt, from turns that cannot deliver it", async () => {
    const stream = createToolsetConfig({
      messageConfig: { ...DEFAULT_MESSAGE_CONFIG, replyMode: "stream" },
    });
    const queued = await assemble(reply({}, { preserveQueuedMessage: true }));
    const toolsets = [
      queued,
      await assemble(reply(), { config: stream }),
      await assemble(continuation(), { config: stream }),
    ];

    for (const toolset of toolsets) {
      expect(toolset.tools.multi_message).toBeUndefined();
      expect(toolset.capabilities.has("multi-message")).toBe(false);
    }
    expect(promptFor(queued)).not.toContain("multi_message");
    expect((await assemble(reply())).capabilities.has("multi-message")).toBe(true);
  });

  it("withholds personal tools and memory prompts when personalization is off", async () => {
    const off = await assemble(reply(), { privacyMode: "off" });

    for (const name of ["set_timer", "set_mood", "get_profile", "get_profile_avatar"]) {
      expect(off.tools[name]).toBeUndefined();
    }
    expect(off.tools.recall_memories).toBeUndefined();
    expect(off.capabilities.has("memory")).toBe(false);
    expect(off.capabilities.has("bot-memory")).toBe(false);
  });

  it("stops a timer chain at the depth limit", async () => {
    const onLog = vi.fn();
    const second = await assemble(continuation({ timerDepth: 2 }), { onLog });

    expect(second.tools.set_timer).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith({
      level: "warn",
      message: "set_timer disabled due to timer depth limit",
      meta: { chatId: GROUP_ID, timerDepth: 2 },
    });
    expect((await assemble(continuation({ timerDepth: 1 }))).tools.set_timer).toBeDefined();
  });

  it("advertises stickers only where send_sticker can succeed", async () => {
    const withPacks = await assemble(reply());
    const withoutPacks = await assemble(reply(), {
      config: createToolsetConfig({ stickerPacks: [] }),
    });
    const continued = await assemble(continuation());

    expect(withPacks.capabilities.has("sticker")).toBe(true);
    expect(withoutPacks.tools.send_sticker).toBeDefined();
    expect(withoutPacks.capabilities.has("sticker")).toBe(false);
    expect(continued.capabilities.has("sticker")).toBe(false);
    expect(promptFor(continued)).not.toContain("send_sticker");
  });
});
