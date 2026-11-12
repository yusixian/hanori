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
import { createPluginTools } from "./plugins.js";
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
      userName: "Alice",
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

describe("unified search turn integration", () => {
  const migrated = [
    "web_search",
    "search_history",
    "search_profiles",
    "recall_memories",
    "search_generation_characters",
    "search_prompt_assets",
    "search_danbooru_character_tags",
    "fetch_artwork_info",
    "github_list_issues",
    "github_list_tree",
  ];

  it.each([reply(), continuation()])(
    "replaces only authorized search tools for $kind and leaves writes in their existing policy",
    async (entry) => {
      const searchHistory = vi.fn().mockResolvedValue([]);
      const listCharacters = vi.fn().mockResolvedValue({ data: [], total: 0 });
      const config = createToolsetConfig({
        unifiedSearchEnabled: true,
        memory: {
          searchHistory,
          searchProfiles: async () => [],
        } as unknown as import("@cos-tool-bot/shared").MemoryCallbacks,
        generationLibraryPort: {
          listCharacters,
        } as unknown as import("@cos-tool-bot/shared").GenerationLibraryPort,
      });
      const toolset = await assemble(entry, { config });
      expect(toolset.tools.search).toBeDefined();
      expect(toolset.tools.read_reference).toBeDefined();
      for (const name of migrated) expect(toolset.tools[name]).toBeUndefined();
      expect(toolset.tools.fetch_webpage).toBeDefined();
      expect(toolset.tools.send_artwork).toBeDefined();
      expect(!!toolset.tools.save_original_character).toBe(entry.kind === "reply");
      await expect(
        run(toolset.tools, "search", { scope: "history", query: "hello", page: 1, limit: 3 }),
      ).resolves.toMatchObject({ status: "empty" });
      expect(searchHistory).toHaveBeenCalledWith({
        query: "hello",
        chatId: GROUP_ID,
        userId: undefined,
        limit: 3,
      });
      await expect(
        run(toolset.tools, "search", {
          scope: "characters",
          provider: "builtin.characters.local",
          query: "oc",
          page: 2,
          limit: 4,
        }),
      ).resolves.toMatchObject({ status: "empty" });
      expect(listCharacters).toHaveBeenCalledWith(
        expect.objectContaining({ telegramUserId: ADMIN_ID }),
        { search: "oc", page: 2, limit: 4 },
        false,
      );
      if (entry.kind === "continue")
        await expect(
          run(toolset.tools, "search", { scope: "github", query: "hello", page: 1, limit: 3 }),
        ).resolves.toMatchObject({ status: "unavailable" });
    },
  );

  it.each([false, undefined])(
    "keeps the legacy tool surface when the low-level switch is %s",
    async (unifiedSearchEnabled) => {
      const toolset = await assemble(reply(), {
        config: createToolsetConfig({ unifiedSearchEnabled }),
      });
      expect(toolset.tools.search).toBeUndefined();
      expect(toolset.tools.read_reference).toBeUndefined();
      for (const name of migrated) expect(toolset.tools[name]).toBeDefined();
      expect(promptFor(toolset)).toContain("- web_search:");
    },
  );

  it("cannot regain sources removed by privacy or member authorization", async () => {
    const toolset = await assemble(reply(), {
      config: createToolsetConfig({ unifiedSearchEnabled: true }),
      privacyMode: "off",
      userId: MEMBER_ID,
    });
    for (const scope of ["history", "profiles", "memory", "github"]) {
      await expect(
        run(toolset.tools, "search", { scope, query: "hello", page: 1, limit: 3 }),
      ).resolves.toMatchObject({ status: "unavailable" });
    }
    expect(toolset.capabilities.has("bot-memory")).toBe(false);
    expect(promptFor(toolset)).not.toContain("search(scope=memory)");
  });

  it("does not share references between successive turns", async () => {
    const listCharacters = vi.fn().mockResolvedValue({
      data: [{ id: 1, name: "OC", appearance: "private appearance" }],
      total: 1,
    });
    const config = createToolsetConfig({
      unifiedSearchEnabled: true,
      generationLibraryPort: {
        listCharacters,
      } as unknown as import("@cos-tool-bot/shared").GenerationLibraryPort,
    });
    const first = await assemble(reply(), { config });
    const next = await assemble(continuation(), { config });
    const result = (await run(first.tools, "search", {
      scope: "characters",
      provider: "builtin.characters.local",
      query: "oc",
      page: 1,
      limit: 3,
    })) as import("@cos-tool-bot/shared").SearchResult;
    await expect(
      run(next.tools, "read_reference", { reference: result.items[0]!.reference }),
    ).resolves.toMatchObject({ status: "forbidden", content: "" });
    await expect(
      run(first.tools, "read_reference", { reference: result.items[0]!.reference }),
    ).resolves.toMatchObject({ status: "ok", content: "private appearance" });
  });

  it("generates memory, web, artwork and skill instructions matching the offered tool names", async () => {
    const toolset = await assemble(reply(), {
      config: createToolsetConfig({ unifiedSearchEnabled: true }),
    });
    const prompt = promptFor(toolset);
    for (const name of migrated) expect(prompt).not.toContain(name);
    expect(prompt).toContain("- search:");
    expect(prompt).toContain("- read_reference:");
    expect(prompt).toContain("search(scope=web)");
    expect(prompt).toContain("search(scope=memory)");
    expect(prompt).toContain("search(scope=artwork");
    const bundle = await assembleContext({
      systemPrompt: "System",
      isPrivate: false,
      chatId: GROUP_ID,
      userName: "Alice",
      maxContextMessages: 20,
      toolCapabilities: toolset.capabilities,
    });
    const text = JSON.stringify(bundle.messages);
    expect(text).toContain("search(scope=history)");
    expect(text).toContain("search(scope=profiles)");
    for (const name of migrated) expect(text).not.toContain(name);
    await expect(
      run(toolset.tools, "load_skill", { skill: "prompt-atelier" }),
    ).resolves.toMatchObject({
      runtime: {
        webSearch: expect.stringContaining("scope=web"),
        retrieval: expect.stringContaining("These old names are not callable"),
      },
    });
  });
});

it("offers only current built-in search names in avatar, artwork and memory mutation contracts", async () => {
  const unified = await assemble(reply(), {
    config: createToolsetConfig({ unifiedSearchEnabled: true }),
  });
  const legacy = await assemble(reply(), {
    config: createToolsetConfig({ unifiedSearchEnabled: false }),
  });
  expect(unified.tools.get_profile_avatar!.description).toContain("search(scope=profiles)");
  expect(unified.tools.get_profile_avatar!.description).not.toContain("search_profiles");
  expect(legacy.tools.get_profile_avatar!.description).toContain("search_profiles");
  expect(unified.tools.send_artwork!.description).toContain("search(scope=artwork");
  expect(legacy.tools.send_artwork!.description).toContain("fetch_artwork_info");
  await expect(run(unified.tools, "send_artwork", {})).resolves.toEqual({
    error: "请先调用 search(scope=artwork, query=作品URL) 获取作品信息",
  });
  await expect(run(legacy.tools, "send_artwork", {})).resolves.toEqual({
    error: "请先调用 fetch_artwork_info 获取作品信息",
  });
  for (const name of ["update_memory", "retire_memory"]) {
    const schema = unified.tools[name]!.inputSchema as {
      jsonSchema: { properties: { expected_content: { description: string } } };
    };
    const description = schema.jsonSchema.properties.expected_content.description;
    expect(description).toContain("search(scope=memory)");
    expect(description).toContain("read_reference");
    expect(description).toContain("完整原文");
    expect(description).toContain("不得使用截断的 summary");
    expect(description).not.toContain("recall_memories");
  }
  expect(unified.tools.mcp1_lookup!.description).toBe(legacy.tools.mcp1_lookup!.description);
});

describe("trusted plugin turn binding", () => {
  function pluginSession(): import("@cos-tool-bot/shared").PluginTurnSession {
    return {
      tools: [
        {
          name: "plg_fixture_read",
          description: "Plugin reader",
          inputSchema: { type: "object" },
          effect: "read_only",
          access: "all",
          execute: vi.fn(async () => ({ ok: true })),
        },
      ],
      searchProviders: [],
      dispose: vi.fn(async () => {}),
    };
  }
  it.each([
    {
      entry: reply(),
      userId: ADMIN_ID,
      privacyMode: "normal" as const,
      chatId: GROUP_ID,
      isAdmin: true,
      readOnly: false,
    },
    {
      entry: reply(),
      userId: MEMBER_ID,
      privacyMode: "normal" as const,
      chatId: MEMBER_ID,
      isAdmin: false,
      readOnly: false,
    },
    {
      entry: reply(),
      userId: ADMIN_ID,
      privacyMode: "off" as const,
      chatId: GROUP_ID,
      isAdmin: true,
      readOnly: true,
    },
    {
      entry: continuation(),
      userId: undefined,
      privacyMode: "normal" as const,
      chatId: GROUP_ID,
      isAdmin: false,
      readOnly: true,
    },
  ])(
    "binds trusted context for $entry.kind, user $userId and privacy $privacyMode",
    async (scenario) => {
      const bound = pluginSession();
      const createSession = vi.fn(async () => bound);
      const controller = new AbortController();
      const result = await assemble(scenario.entry, {
        userId: scenario.userId,
        chatId: scenario.chatId,
        privacyMode: scenario.privacyMode,
        signal: controller.signal,
        config: createToolsetConfig({ plugins: { createSession } }),
      });
      expect(createSession).toHaveBeenCalledWith(
        {
          botId: "bot-1",
          chatId: scenario.chatId,
          userId: scenario.userId,
          isAdmin: scenario.isAdmin,
          isPrivate: scenario.chatId > 0,
          readOnly: scenario.readOnly,
        },
        controller.signal,
      );
      expect(result.tools.plg_fixture_read).toBeDefined();
      await result.dispose!();
      expect(bound.dispose).toHaveBeenCalledOnce();
    },
  );
  it("offers plugin unified search with the legacy migration flag off and isolates its references by turn", async () => {
    const search = vi.fn(async () => ({
      status: "ok" as const,
      items: [{ id: "track", title: "Track", summary: "Preview", content: "Full plugin body" }],
      hasMore: false,
    }));
    const createSession = vi.fn(async () => ({
      ...pluginSession(),
      searchProviders: [
        {
          id: "plg_fixture_music",
          scope: "music",
          description: "Plugin music",
          pagination: "single_page" as const,
          search,
        },
      ],
    }));
    const config = createToolsetConfig({ plugins: { createSession }, unifiedSearchEnabled: false });
    const first = await assemble(reply(), { config });
    const second = await assemble(reply(), { config });
    try {
      expect(first.tools.search).toBeDefined();
      expect(first.tools.read_reference).toBeDefined();
      expect(first.tools.web_search).toBeDefined();
      const found = (await run(first.tools, "search", {
        scope: "music",
        query: "track",
        page: 1,
        limit: 5,
      })) as import("@cos-tool-bot/shared").SearchResult;
      await expect(
        run(first.tools, "read_reference", { reference: found.items[0]!.reference }),
      ).resolves.toMatchObject({ status: "ok", content: "Full plugin body" });
      await expect(
        run(second.tools, "read_reference", { reference: found.items[0]!.reference }),
      ).resolves.toMatchObject({ status: "forbidden", content: "" });
      expect(first.capabilities.has("unified-search")).toBe(true);
    } finally {
      await first.dispose!();
      await second.dispose!();
    }
  });
  it("disposes the session when a plugin namespace conflicts with an existing turn tool", async () => {
    const bound = pluginSession();
    await expect(
      assemble(reply(), {
        config: createToolsetConfig({
          plugins: { createSession: async () => bound },
          webTools: createPluginTools(bound),
        }),
      }),
    ).rejects.toThrow("Plugin tool name conflict");
    expect(bound.dispose).toHaveBeenCalledOnce();
  });
  it("disposes a session when its search registry cannot be assembled", async () => {
    const bound = pluginSession();
    const provider = {
      id: "fixture_duplicate",
      scope: "music",
      description: "Fixture",
      pagination: "native" as const,
      search: async () => ({ status: "empty" as const, items: [], hasMore: false }),
    };
    bound.searchProviders = [provider, provider];
    await expect(
      assemble(reply(), {
        config: createToolsetConfig({ plugins: { createSession: async () => bound } }),
      }),
    ).rejects.toThrow("Duplicate search provider id");
    expect(bound.dispose).toHaveBeenCalledOnce();
  });
});

it("registers a current-topic summary callback without exposing actor or destination arguments", async () => {
  const summarizeChat = vi.fn(async () => ({ ok: true, contentRaw: "summary" }));
  const signal = new AbortController().signal;
  const tools = await assemble(reply(), {
    config: createToolsetConfig({ summarizeChat }),
    chatId: -123,
    threadId: 7,
    userId: MEMBER_ID,
    signal,
  });
  await run(tools.tools, "summarize_chat", {
    instructions: "List decisions",
    mode: { kind: "hours", hours: 2 },
  });
  expect(summarizeChat).toHaveBeenCalledWith({
    chatId: -123,
    threadId: 7,
    userId: MEMBER_ID,
    signal,
    request: { instructions: "List decisions", mode: { kind: "hours", hours: 2 } },
  });
  const off = await assemble(reply(), {
    config: createToolsetConfig({ summarizeChat }),
    privacyMode: "off",
  });
  expect(off.tools.summarize_chat).toBeUndefined();
});
