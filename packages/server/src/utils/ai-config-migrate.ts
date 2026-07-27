import type { AiConfigStored, AiProviderEntry } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";

/** Stable synthetic id used when wrapping legacy flat config into providers[0].
 *  Fixed (not random) so PUT handlers can look it up reliably across calls. */
const LEGACY_PROVIDER_ID = "__legacy__";
export const DEFAULT_MODEL_DISCOVERY_PATH = "/models";

export function normalizeAiProvider(provider: AiProviderEntry): AiProviderEntry {
  const models: NonNullable<AiProviderEntry["models"]> = [];
  const seenModelIds = new Set<string>();
  for (const model of provider.models ?? []) {
    const id = model.id.trim();
    if (!id || seenModelIds.has(id)) continue;
    seenModelIds.add(id);
    models.push({ ...model, id });
  }

  const configuredDefault = provider.defaultModel.trim();
  const defaultModel = configuredDefault || models[0]?.id || "";
  if (defaultModel && !seenModelIds.has(defaultModel)) {
    models.push({ id: defaultModel });
  }

  return {
    ...provider,
    modelDiscoveryPath:
      provider.modelDiscoveryPath === undefined
        ? DEFAULT_MODEL_DISCOVERY_PATH
        : provider.modelDiscoveryPath.trim(),
    defaultModel,
    models: models.length > 0 || provider.models !== undefined ? models : undefined,
  };
}

/** Wrap legacy flat AI config fields into providers[0] on first access.
 *  If providers[] already non-empty, only fixes up activeProviderId if missing/stale.
 *  Does NOT strip legacy top-level fields (preserved for rollback compat). */
export function migrateAiConfig(stored: AiConfigStored): AiConfigStored {
  const normalized = {
    ...stored,
    conversationConfig: {
      ...DEFAULT_CONVERSATION_CONFIG,
      ...stored.conversationConfig,
    },
  };

  if (normalized.providers && normalized.providers.length > 0) {
    const providers = normalized.providers.map(normalizeAiProvider);
    const activeProviderId =
      !normalized.activeProviderId || !providers.some((p) => p.id === normalized.activeProviderId)
        ? providers[0]!.id
        : normalized.activeProviderId;
    const activeProvider = providers.find((provider) => provider.id === activeProviderId)!;
    const activeModelId =
      normalized.activeModelId &&
      (normalized.activeModelId === activeProvider.defaultModel ||
        activeProvider.models?.some((model) => model.id === normalized.activeModelId))
        ? normalized.activeModelId
        : activeProvider.defaultModel;
    return {
      ...normalized,
      providers,
      activeProviderId,
      activeModelId,
      aiSelectionDisplayDefault: normalized.aiSelectionDisplayDefault ?? "show",
    };
  }

  const legacy: AiProviderEntry = {
    id: LEGACY_PROVIDER_ID,
    label: "Default",
    encryptedApiKey: normalized.encryptedApiKey,
    baseURL: normalized.baseURL,
    providerFormat: normalized.providerFormat ?? "openai",
    defaultModel: normalized.model,
    models: normalized.models,
  };
  const normalizedLegacy = normalizeAiProvider(legacy);

  return {
    ...normalized,
    providers: [normalizedLegacy],
    activeProviderId: legacy.id,
    activeModelId: normalizedLegacy.defaultModel,
    aiSelectionDisplayDefault: normalized.aiSelectionDisplayDefault ?? "show",
  };
}

/** Resolve the currently-active provider entry (post-migration). */
export function getActiveProvider(stored: AiConfigStored): AiProviderEntry | null {
  if (!stored.providers || stored.providers.length === 0) return null;
  const target = stored.activeProviderId;
  if (target) {
    const match = stored.providers.find((p) => p.id === target);
    if (match) return match;
  }
  return stored.providers[0] ?? null;
}
