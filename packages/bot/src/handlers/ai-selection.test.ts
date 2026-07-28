import { streamText, type LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  createAiSelectionRuntime,
  type AiProviderRuntime,
  type AiSelectionMutations,
  type AiSelectionSnapshot,
} from "./ai-selection.js";

const providers: AiProviderRuntime[] = [
  {
    id: "provider-a",
    label: "Provider A",
    apiKey: "secret-a",
    baseURL: "https://a.example/v1",
    providerFormat: "openai",
    defaultModel: "model-a",
    models: [{ id: "model-a" }, { id: "model-a-2" }],
  },
  {
    id: "provider-b",
    label: "Provider B",
    apiKey: "secret-b",
    baseURL: "https://b.example/v1",
    providerFormat: "gemini",
    defaultModel: "model-b",
    models: [{ id: "model-b" }, { id: "model-b-2" }],
  },
];

function fakeFactory(provider: AiProviderRuntime) {
  return Object.assign(
    (modelId: string) => ({ providerId: provider.id, modelId }) as unknown as LanguageModel,
    { providerId: provider.id },
  );
}

function snapshot(
  activeProviderId = "provider-a",
  activeModelId: string | null = null,
  chats: AiSelectionSnapshot["chats"] = {},
): AiSelectionSnapshot {
  return { global: { activeProviderId, activeModelId }, chats };
}

function createRuntime(
  options: {
    initialSnapshot?: AiSelectionSnapshot;
    mutations?: AiSelectionMutations;
  } = {},
) {
  return createAiSelectionRuntime({
    providers,
    activeProviderId: "provider-a",
    initialSnapshot: options.initialSnapshot,
    legacy: {
      apiKey: "legacy",
      baseURL: "https://legacy.example/v1",
      providerFormat: "openai",
      model: "legacy-model",
    },
    mutations: options.mutations,
    createProviderFactory: fakeFactory,
  });
}

describe("AiSelectionRuntime", () => {
  it("falls back when an OpenAI-compatible endpoint rejects streaming usage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "unknown field stream_options" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "stop after request capture" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runtime = createAiSelectionRuntime({
        providers: [providers[0]!],
        activeProviderId: "provider-a",
        legacy: {
          apiKey: "legacy",
          baseURL: "https://legacy.example/v1",
          providerFormat: "openai",
          model: "legacy-model",
        },
      });
      const selection = runtime.resolve();
      const result = streamText({
        model: selection.providerFactory(selection.modelId),
        prompt: "usage probe",
      });

      await expect(result.text).rejects.toThrow();

      const usageRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const fallbackRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(usageRequest?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(JSON.parse(String(fallbackRequest?.body))).not.toHaveProperty("stream_options");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves the configured global active model and chat default-model semantics", () => {
    const runtime = createRuntime({
      initialSnapshot: snapshot("provider-b", "model-b-2", {
        "-100": { providerId: "provider-a", modelId: null },
      }),
    });

    expect(runtime.resolve(-200)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b-2",
    });
    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("atomically replaces the complete immutable runtime snapshot", () => {
    const source = snapshot("provider-a", "model-a-2");
    const runtime = createRuntime({ initialSnapshot: source });
    const beforePublish = runtime.resolve(-100);

    runtime.applyAiSelectionSnapshot(
      snapshot("provider-a", "model-a-2", {
        "-100": { providerId: "provider-b", modelId: "model-b-2" },
      }),
    );
    (source.global as { activeModelId: string | null }).activeModelId = "model-a";

    expect(beforePublish).toMatchObject({ providerId: "provider-a", modelId: "model-a-2" });
    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b-2",
    });
    expect(Object.isFrozen(beforePublish)).toBe(true);
  });

  it("never exposes a mixed pair while the service mutation and publish are pending", async () => {
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let runtime!: ReturnType<typeof createRuntime>;
    const setProvider = vi.fn(async (chatId: number, providerId: string) => {
      await mutationGate;
      runtime.applyAiSelectionSnapshot(
        snapshot("provider-a", "model-a-2", {
          [chatId]: { providerId, modelId: null },
        }),
      );
    });
    const mutations: AiSelectionMutations = {
      setModel: vi.fn(async () => {}),
      resetModel: vi.fn(async () => {}),
      setProvider,
      resetProvider: vi.fn(async () => {}),
    };
    runtime = createRuntime({
      initialSnapshot: snapshot("provider-a", "model-a-2"),
      mutations,
    });

    const switchProvider = runtime.setProvider(-100, "provider-b", 42);
    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-a",
      modelId: "model-a-2",
    });

    releaseMutation();
    await switchProvider;
    expect(runtime.resolve(-100)).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(setProvider).toHaveBeenCalledWith(-100, "provider-b", 42);
  });

  it("delegates reset intent instead of rewriting it as an explicit default pair", async () => {
    const mutations: AiSelectionMutations = {
      setModel: vi.fn(async () => {}),
      resetModel: vi.fn(async () => {}),
      setProvider: vi.fn(async () => {}),
      resetProvider: vi.fn(async () => {}),
    };
    const runtime = createRuntime({ mutations });

    await runtime.setModel(-100, "model-a-2", 42);
    await runtime.resetModel(-100, 42);
    await runtime.setProvider(-100, "provider-b", 42);
    await runtime.resetProvider(-100, 42);

    expect(mutations.setModel).toHaveBeenCalledWith(-100, "model-a-2", 42);
    expect(mutations.resetModel).toHaveBeenCalledWith(-100, 42);
    expect(mutations.setProvider).toHaveBeenCalledWith(-100, "provider-b", 42);
    expect(mutations.resetProvider).toHaveBeenCalledWith(-100, 42);
  });

  it("keeps the provider row on model reset and removes the row on provider reset", async () => {
    const runtime = createRuntime({
      initialSnapshot: snapshot("provider-b", "model-b-2", {
        "-100": { providerId: "provider-a", modelId: "model-a-2" },
      }),
    });

    await runtime.resetModel(-100, 42);
    expect(runtime.resolve(-100)).toMatchObject({ providerId: "provider-a", modelId: "model-a" });

    await runtime.resetProvider(-100, 42);
    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b-2",
    });
  });

  it("keeps global inheritance when resetting a chat without a selection row", async () => {
    const runtime = createRuntime({
      initialSnapshot: snapshot("provider-b", "model-b-2"),
    });

    await runtime.resetModel(-100, 42);

    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b-2",
    });
  });

  it("normalizes stale cross-provider model ids before exposing a request snapshot", () => {
    const runtime = createRuntime({
      initialSnapshot: snapshot("provider-a", null, {
        "-100": { providerId: "provider-b", modelId: "model-a" },
      }),
    });

    expect(runtime.resolve(-100)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b",
      providerRuntime: { id: "provider-b" },
    });
  });
});
