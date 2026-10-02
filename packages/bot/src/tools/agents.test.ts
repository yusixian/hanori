import type { GenerationLibraryActor, GenerationLibraryPort } from "@cos-tool-bot/shared";
import type { LanguageModel, Tool } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createAgentTools } from "./agents.js";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
}));

interface ExecutableTool {
  execute: (input: { agent: string; task: string; context?: string }) => Promise<unknown>;
}

describe("createAgentTools logging", () => {
  test("logs delegated task structure without task or context content", async () => {
    generateTextMock.mockResolvedValue({ text: "delegated answer", steps: [] });
    const onLog = vi.fn();
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test-model",
      onLog,
    });
    const delegatedTask = "confidential delegated task";
    const context = "private background context";

    await (tools.delegate_task as Tool as unknown as ExecutableTool).execute({
      agent: "general",
      task: delegatedTask,
      context,
    });

    expect(onLog).toHaveBeenCalledWith({
      level: "debug",
      message: "[delegate] agent=general started",
      meta: {
        agent: "general",
        subAgentModel: "test-model",
        maxSteps: 64,
        taskLength: delegatedTask.length,
        contextLength: context.length,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(delegatedTask);
    expect(JSON.stringify(onLog.mock.calls)).not.toContain(context);
  });

  test("keeps the Danbooru tag tool when researcher web tools are enabled", async () => {
    generateTextMock.mockResolvedValue({ text: "research answer", steps: [] });
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test-model",
      webToolsConfig: { enabled: true },
    });

    await (tools.delegate_task as Tool as unknown as ExecutableTool).execute({
      agent: "researcher",
      task: "resolve a character tag",
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          fetch_webpage: expect.any(Object),
          search_danbooru_character_tags: expect.any(Object),
        }),
      }),
    );
  });

  test("passes the trusted Telegram actor into researcher library tools", async () => {
    generateTextMock.mockImplementationOnce(async (options: { tools: Record<string, Tool> }) => {
      expect(options.tools.save_original_character).toBeUndefined();
      expect(options.tools.set_character_binding).toBeUndefined();
      expect(options.tools.save_prompt_asset).toBeUndefined();
      await (
        options.tools.search_generation_characters as Tool as unknown as {
          execute: (input: { search: string; page: number; limit: number }) => Promise<unknown>;
        }
      ).execute({ search: "oc", page: 1, limit: 10 });
      return { text: "research answer", steps: [] };
    });
    const actor: GenerationLibraryActor = {
      botId: "bot-1",
      source: "telegram",
      telegramUserId: 42,
      isAdmin: false,
    };
    const listCharacters = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test-model",
      generationLibraryPort: { listCharacters } as unknown as GenerationLibraryPort,
      getActor: () => actor,
    });

    await (tools.delegate_task as Tool as unknown as ExecutableTool).execute({
      agent: "researcher",
      task: "search the local character library",
    });

    expect(listCharacters).toHaveBeenCalledWith(actor, { search: "oc", page: 1, limit: 10 }, true);
  });
});

describe("unified researcher search", () => {
  test("isolates references per delegation and retains the researcher source restrictions", async () => {
    const actor: GenerationLibraryActor = {
      botId: "bot-1",
      source: "telegram",
      telegramUserId: 42,
      isAdmin: true,
    };
    const listCharacters = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 5, name: "OC", appearance: "private body" }], total: 1 });
    let firstReference = "";
    let calls = 0;
    generateTextMock.mockImplementation(
      async (options: { tools: Record<string, Tool>; system: string }) => {
        expect(options.tools.search).toBeDefined();
        expect(options.tools.read_reference).toBeDefined();
        expect(options.tools.search_generation_characters).toBeUndefined();
        expect(options.tools.search_danbooru_character_tags).toBeUndefined();
        expect(options.tools.web_search).toBeUndefined();
        expect(options.tools.get_character_bindings).toBeDefined();
        expect(options.tools.save_original_character).toBeUndefined();
        expect(options.system).toContain("search");
        const execute = (name: string, input: Record<string, unknown>) =>
          options.tools[name]!.execute!(input as never, { toolCallId: "test", messages: [] });
        for (const scope of ["history", "profiles", "memory", "github", "artwork", "web"])
          await expect(
            execute("search", { scope, query: "hello", page: 1, limit: 3 }),
          ).resolves.toMatchObject({ status: "unavailable" });
        if (calls++)
          await expect(
            execute("read_reference", { reference: firstReference }),
          ).resolves.toMatchObject({ status: "forbidden", content: "" });
        const result = (await execute("search", {
          scope: "characters",
          provider: "builtin.characters.local",
          query: "oc",
          page: 1,
          limit: 3,
        })) as import("@cos-tool-bot/shared").SearchResult;
        const reference = result.items[0]!.reference;
        if (!firstReference) firstReference = reference;
        await expect(execute("read_reference", { reference })).resolves.toMatchObject({
          status: "ok",
          content: "private body",
        });
        return { text: "answer", steps: [] };
      },
    );
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      unifiedSearchEnabled: true,
      generationLibraryPort: { listCharacters } as unknown as GenerationLibraryPort,
      getActor: () => actor,
    });
    const delegate = tools.delegate_task as unknown as ExecutableTool;
    await delegate.execute({ agent: "researcher", task: "first" });
    await delegate.execute({ agent: "researcher", task: "second" });
    expect(listCharacters).toHaveBeenCalledTimes(2);
    expect(listCharacters).toHaveBeenLastCalledWith(
      actor,
      { search: "oc", page: 1, limit: 3 },
      false,
    );
  });

  test("keeps general delegates without tools when unified search is enabled", async () => {
    generateTextMock.mockResolvedValue({ text: "answer", steps: [] });
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      unifiedSearchEnabled: true,
    });
    await (tools.delegate_task as unknown as ExecutableTool).execute({
      agent: "general",
      task: "write",
    });
    expect(generateTextMock).toHaveBeenLastCalledWith(expect.objectContaining({ tools: {} }));
  });
});

describe("delegate cancellation", () => {
  test("rejects an already-cancelled parent without starting a model call", async () => {
    generateTextMock.mockClear();
    const controller = new AbortController();
    const reason = new Error("parent cancelled");
    controller.abort(reason);
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      unifiedSearchEnabled: true,
    });
    await expect(
      tools.delegate_task!.execute!({ agent: "researcher", task: "search" } as never, {
        toolCallId: "test",
        messages: [],
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("forwards running parent cancellation and preserves its reason instead of returning an ordinary error", async () => {
    generateTextMock.mockClear();
    const controller = new AbortController();
    const reason = new Error("parent stopped during research");
    let childSignal: AbortSignal | undefined;
    generateTextMock.mockImplementationOnce(
      async (options: { abortSignal: AbortSignal; tools: Record<string, Tool> }) => {
        childSignal = options.abortSignal;
        expect(options.tools.read_reference).toBeDefined();
        for (const tool of Object.values(options.tools)) {
          expect(tool.description ?? "").not.toMatch(
            /\b(?:web_search|search_generation_characters|search_danbooru_character_tags|search_prompt_assets|fetch_artwork_info|search_profiles|recall_memories)\b/,
          );
        }
        return new Promise((_resolve, reject) =>
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          }),
        );
      },
    );
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      unifiedSearchEnabled: true,
    });
    const pending = tools.delegate_task!.execute!(
      { agent: "researcher", task: "search" } as never,
      { toolCallId: "test", messages: [], abortSignal: controller.signal },
    );
    await vi.waitFor(() => expect(childSignal).toBeDefined());
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(childSignal!.aborted).toBe(true);
    expect(childSignal!.reason).toBe(reason);
  });
});

test("does not report success when a cancelled child model returns late despite its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before late model completion");
  let finish!: (result: { text: string; steps: unknown[] }) => void;
  generateTextMock.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const tools = createAgentTools({
    provider: () => ({}) as LanguageModel,
    model: "test",
    unifiedSearchEnabled: true,
  });
  const pending = tools.delegate_task!.execute!({ agent: "researcher", task: "search" } as never, {
    toolCallId: "test",
    messages: [],
    abortSignal: controller.signal,
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort(reason);
  finish({ text: "late answer", steps: [] });
  await expect(pending).rejects.toBe(reason);
});

describe("researcher plugin sessions", () => {
  test("creates fresh read-only sessions from the trusted turn actor and isolates plugin references with migration off", async () => {
    const { assemble, reply, createToolsetConfig, MEMBER_ID, GROUP_ID } =
      await import("./turn-toolset-test-helpers.js");
    const sessions: import("@cos-tool-bot/shared").PluginTurnSession[] = [];
    const createSession = vi.fn<import("@cos-tool-bot/shared").PluginRuntimePort["createSession"]>(
      async (actor) => {
        const read = {
          name: "plg_fixture_read",
          description: "Read bound identity",
          inputSchema: { type: "object" },
          effect: "read_only" as const,
          access: "all" as const,
          execute: async () => ({
            botId: actor.botId,
            userId: actor.userId,
            readOnly: actor.readOnly,
          }),
        };
        const write = { ...read, name: "plg_fixture_write", effect: "mutating" as const };
        const session: import("@cos-tool-bot/shared").PluginTurnSession = {
          tools: actor.readOnly ? [read] : [read, write],
          searchProviders: [
            {
              id: "plg_fixture_music",
              scope: "music",
              description: "Music fixture",
              pagination: "native",
              search: async () => ({
                status: "ok",
                items: [
                  {
                    id: "track",
                    title: "Track",
                    summary: "Preview",
                    content: "Scoped plugin reference",
                  },
                ],
                hasMore: false,
              }),
            },
          ],
          dispose: vi.fn(async () => {}),
        };
        sessions.push(session);
        return session;
      },
    );
    let firstReference = "";
    let calls = 0;
    generateTextMock.mockImplementation(async (options: { tools: Record<string, Tool> }) => {
      expect(options.tools.plg_fixture_write).toBeUndefined();
      expect(options.tools.plg_fixture_read).toBeDefined();
      expect(options.tools.search).toBeDefined();
      const run = (name: string, input: unknown) =>
        options.tools[name]!.execute!(input as never, { toolCallId: "research", messages: [] });
      await expect(
        run("plg_fixture_read", { botId: "spoofed", userId: 999, isAdmin: true }),
      ).resolves.toEqual({ botId: "bot-1", userId: MEMBER_ID, readOnly: true });
      if (calls++)
        await expect(run("read_reference", { reference: firstReference })).resolves.toMatchObject({
          status: "forbidden",
        });
      const found = (await run("search", {
        scope: "music",
        query: "track",
        page: 1,
        limit: 1,
      })) as import("@cos-tool-bot/shared").SearchResult;
      if (!firstReference) firstReference = found.items[0]!.reference;
      await expect(
        run("read_reference", { reference: found.items[0]!.reference }),
      ).resolves.toMatchObject({ status: "ok", content: "Scoped plugin reference" });
      return { text: "Research complete", steps: [] };
    });
    const turn = await assemble(reply(), {
      userId: MEMBER_ID,
      config: createToolsetConfig({ plugins: { createSession }, unifiedSearchEnabled: false }),
      delegation: (_actor, plugins) =>
        createAgentTools({
          provider: () => ({}) as LanguageModel,
          model: "test",
          plugins,
          unifiedSearchEnabled: false,
        }),
    });
    try {
      expect(turn.tools.plg_fixture_write).toBeDefined();
      for (const task of ["first", "second"])
        await turn.tools.delegate_task!.execute!({ agent: "researcher", task } as never, {
          toolCallId: "delegate",
          messages: [],
        });
      expect(createSession).toHaveBeenCalledTimes(3);
      for (const actor of createSession.mock.calls.slice(1).map((call) => call[0]))
        expect(actor).toEqual({
          botId: "bot-1",
          chatId: GROUP_ID,
          userId: MEMBER_ID,
          isAdmin: false,
          isPrivate: false,
          readOnly: true,
        });
      expect(sessions[1]!.dispose).toHaveBeenCalledOnce();
      expect(sessions[2]!.dispose).toHaveBeenCalledOnce();
      expect(sessions[0]!.dispose).not.toHaveBeenCalled();
    } finally {
      await turn.dispose!();
    }
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
  });
  test.each(["success", "failure", "cancellation"])(
    "disposes a researcher session after model %s and propagates parent abort",
    async (outcome) => {
      const dispose = vi.fn(async () => {});
      const controller = new AbortController();
      const reason = new Error("parent stopped");
      let signal: AbortSignal | undefined;
      const plugins = vi.fn(async (current?: AbortSignal) => {
        signal = current;
        return { tools: [], searchProviders: [], dispose };
      });
      generateTextMock.mockImplementationOnce(async () => {
        if (outcome === "failure") throw new Error("model unavailable");
        if (outcome === "cancellation") {
          controller.abort(reason);
          throw reason;
        }
        return { text: "Complete", steps: [] };
      });
      const tools = createAgentTools({
        provider: () => ({}) as LanguageModel,
        model: "test",
        plugins,
      });
      const pending = tools.delegate_task!.execute!(
        { agent: "researcher", task: "research" } as never,
        { toolCallId: "delegate", messages: [], abortSignal: controller.signal },
      );
      if (outcome === "cancellation") {
        await expect(pending).rejects.toBe(reason);
        expect(signal!.aborted).toBe(true);
        expect(signal!.reason).toBe(reason);
      } else
        await expect(pending).resolves.toMatchObject(
          outcome === "success"
            ? { result: "Complete" }
            : { error: expect.stringContaining("model unavailable") },
        );
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
  test("general delegates never start a plugin session", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "Complete", steps: [] });
    const plugins = vi.fn();
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      plugins,
    });
    await tools.delegate_task!.execute!({ agent: "general", task: "write" } as never, {
      toolCallId: "delegate",
      messages: [],
    });
    expect(plugins).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenLastCalledWith(expect.objectContaining({ tools: {} }));
  });
  test("disposes the session after a plugin source registry assembly failure", async () => {
    const dispose = vi.fn(async () => {});
    const provider = {
      id: "duplicate",
      scope: "music",
      description: "Fixture",
      pagination: "native" as const,
      search: async () => ({ status: "empty" as const, items: [], hasMore: false }),
    };
    const plugins = async () => ({ tools: [], searchProviders: [provider, provider], dispose });
    generateTextMock.mockClear();
    const tools = createAgentTools({
      provider: () => ({}) as LanguageModel,
      model: "test",
      plugins,
    });
    await expect(
      tools.delegate_task!.execute!({ agent: "researcher", task: "research" } as never, {
        toolCallId: "delegate",
        messages: [],
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Duplicate search provider id") });
    expect(dispose).toHaveBeenCalledOnce();
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
