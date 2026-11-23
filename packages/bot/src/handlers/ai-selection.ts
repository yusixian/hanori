import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ModelEntry } from "@cos-tool-bot/shared";
import type { LanguageModel } from "ai";
import { createReasoningCompatibleModelFactory } from "../utils/responses-compatibility.js";
import { createModelFetch } from "../utils/model-fetch.js";

export interface AiProviderRuntime {
  id: string;
  label: string;
  apiKey: string;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
}

export interface AiSelectionPair {
  readonly providerId: string;
  /** null selects the provider's default model. */
  readonly modelId: string | null;
}

export interface AiSelectionSnapshot {
  readonly global: {
    readonly activeProviderId: string;
    /** null selects the active provider's default model. */
    readonly activeModelId: string | null;
  };
  /** A missing chat inherits the complete global pair. */
  readonly chats: Readonly<Record<string, AiSelectionPair>>;
}

/** Persistence is owned by the unified selection service, which publishes a new snapshot. */
export interface AiSelectionMutations {
  setModel(chatId: number, modelId: string, actorTelegramUserId: number): Promise<void>;
  resetModel(chatId: number, actorTelegramUserId: number): Promise<void>;
  setProvider(chatId: number, providerId: string, actorTelegramUserId: number): Promise<void>;
  resetProvider(chatId: number, actorTelegramUserId: number): Promise<void>;
}

export type AiModelFactory = (modelId: string) => LanguageModel;

export interface ResolvedAiSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRuntime: AiProviderRuntime;
  readonly providerFactory: AiModelFactory;
  readonly modelEntry: ModelEntry | undefined;
}

interface AiSelectionRuntimeConfig {
  providers?: AiProviderRuntime[];
  activeProviderId?: string;
  activeModelId?: string | null;
  initialSnapshot?: AiSelectionSnapshot;
  legacy: {
    apiKey: string;
    baseURL: string;
    providerFormat: "openai" | "gemini";
    model: string;
    models?: ModelEntry[];
  };
  mutations?: AiSelectionMutations;
  createProviderFactory?: (provider: AiProviderRuntime) => AiModelFactory;
}

export interface AiSelectionRuntime {
  resolve(chatId?: number): Readonly<ResolvedAiSelection>;
  resolvePair(pair: {
    providerId: string;
    modelId: string;
  }): Readonly<ResolvedAiSelection> | undefined;
  applyAiSelectionSnapshot(snapshot: AiSelectionSnapshot): void;
  setModel(chatId: number, modelId: string, actorTelegramUserId: number): Promise<void>;
  resetModel(chatId: number, actorTelegramUserId: number): Promise<void>;
  setProvider(chatId: number, providerId: string, actorTelegramUserId: number): Promise<void>;
  resetProvider(chatId: number, actorTelegramUserId: number): Promise<void>;
  getProvidersList(): Array<{ id: string; label: string; defaultModel: string }>;
}

function defaultProviderFactory(provider: AiProviderRuntime): AiModelFactory {
  return provider.providerFormat === "gemini"
    ? createGoogleGenerativeAI({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        fetch: createModelFetch(),
      })
    : createReasoningCompatibleModelFactory({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
      });
}

function freezeSnapshot(snapshot: AiSelectionSnapshot): Readonly<AiSelectionSnapshot> {
  const chats: Record<string, Readonly<AiSelectionPair>> = {};
  for (const [chatId, selection] of Object.entries(snapshot.chats)) {
    chats[chatId] = Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
  }
  return Object.freeze({
    global: Object.freeze({
      activeProviderId: snapshot.global.activeProviderId,
      activeModelId: snapshot.global.activeModelId,
    }),
    chats: Object.freeze(chats),
  });
}

export function createAiSelectionRuntime(config: AiSelectionRuntimeConfig): AiSelectionRuntime {
  const providerRegistry = new Map<string, AiProviderRuntime>();
  if (config.providers?.length) {
    for (const provider of config.providers) providerRegistry.set(provider.id, provider);
  } else {
    providerRegistry.set("__legacy__", {
      id: "__legacy__",
      label: "Default",
      apiKey: config.legacy.apiKey,
      baseURL: config.legacy.baseURL,
      providerFormat: config.legacy.providerFormat,
      defaultModel: config.legacy.model,
      models: config.legacy.models,
    });
  }

  const fallbackProviderId =
    config.activeProviderId && providerRegistry.has(config.activeProviderId)
      ? config.activeProviderId
      : providerRegistry.keys().next().value!;
  const initialSnapshot =
    config.initialSnapshot ??
    ({
      global: {
        activeProviderId: fallbackProviderId,
        activeModelId: config.activeModelId ?? null,
      },
      chats: {},
    } satisfies AiSelectionSnapshot);
  const providerFactoryCache = new Map<string, AiModelFactory>();
  let currentSnapshot = freezeSnapshot(initialSnapshot);

  function providerFor(providerId?: string): AiProviderRuntime {
    return (
      (providerId ? providerRegistry.get(providerId) : undefined) ??
      providerRegistry.get(fallbackProviderId)!
    );
  }

  function supportsModel(provider: AiProviderRuntime, modelId: string): boolean {
    return (
      modelId === provider.defaultModel ||
      provider.models?.some((model) => model.id === modelId) === true
    );
  }

  function factoryFor(provider: AiProviderRuntime): AiModelFactory {
    const cached = providerFactoryCache.get(provider.id);
    if (cached) return cached;
    const factory = (config.createProviderFactory ?? defaultProviderFactory)(provider);
    providerFactoryCache.set(provider.id, factory);
    return factory;
  }

  function resolve(chatId?: number): Readonly<ResolvedAiSelection> {
    const snapshot = currentSnapshot;
    const chatSelection = chatId === undefined ? undefined : snapshot.chats[String(chatId)];
    const validChatSelection =
      chatSelection && providerRegistry.has(chatSelection.providerId) ? chatSelection : undefined;
    const providerRuntime = providerFor(
      validChatSelection?.providerId ?? snapshot.global.activeProviderId,
    );
    const configuredModelId = validChatSelection
      ? validChatSelection.modelId
      : snapshot.global.activeModelId;
    const modelId =
      configuredModelId && supportsModel(providerRuntime, configuredModelId)
        ? configuredModelId
        : providerRuntime.defaultModel;
    return Object.freeze({
      providerId: providerRuntime.id,
      modelId,
      providerRuntime,
      providerFactory: factoryFor(providerRuntime),
      modelEntry: providerRuntime.models?.find((model) => model.id === modelId),
    });
  }

  function replaceChatSelection(chatId: number, selection: AiSelectionPair | undefined): void {
    const chats = { ...currentSnapshot.chats };
    if (selection) chats[String(chatId)] = selection;
    else delete chats[String(chatId)];
    currentSnapshot = freezeSnapshot({ global: currentSnapshot.global, chats });
  }

  return {
    resolve,
    resolvePair(pair) {
      const providerRuntime = providerRegistry.get(pair.providerId);
      if (!providerRuntime || !supportsModel(providerRuntime, pair.modelId)) return undefined;
      return Object.freeze({
        ...pair,
        providerRuntime,
        providerFactory: factoryFor(providerRuntime),
        modelEntry: providerRuntime.models?.find((model) => model.id === pair.modelId),
      });
    },
    applyAiSelectionSnapshot(snapshot) {
      currentSnapshot = freezeSnapshot(snapshot);
    },
    async setModel(chatId, modelId, actorTelegramUserId) {
      const current = resolve(chatId);
      if (!supportsModel(current.providerRuntime, modelId)) throw new Error("Unknown AI model");
      if (config.mutations) return config.mutations.setModel(chatId, modelId, actorTelegramUserId);
      const existing = currentSnapshot.chats[String(chatId)];
      replaceChatSelection(chatId, {
        providerId: existing?.providerId ?? current.providerId,
        modelId,
      });
    },
    async resetModel(chatId, actorTelegramUserId) {
      if (config.mutations) return config.mutations.resetModel(chatId, actorTelegramUserId);
      const existing = currentSnapshot.chats[String(chatId)];
      if (existing)
        replaceChatSelection(chatId, { providerId: existing.providerId, modelId: null });
    },
    async setProvider(chatId, providerId, actorTelegramUserId) {
      if (!providerRegistry.has(providerId)) throw new Error("Unknown AI provider");
      if (config.mutations)
        return config.mutations.setProvider(chatId, providerId, actorTelegramUserId);
      replaceChatSelection(chatId, { providerId, modelId: null });
    },
    async resetProvider(chatId, actorTelegramUserId) {
      if (config.mutations) return config.mutations.resetProvider(chatId, actorTelegramUserId);
      replaceChatSelection(chatId, undefined);
    },
    getProvidersList() {
      return [...providerRegistry.values()].map(({ id, label, defaultModel }) => ({
        id,
        label,
        defaultModel,
      }));
    },
  };
}
