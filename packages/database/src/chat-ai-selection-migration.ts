import type {
  AiProviderEntry,
  ChatAiSelectionMigrationOutcome,
  ChatAiSelectionMigrationReason,
} from "@cos-tool-bot/shared";

type MigrationProvider = Pick<AiProviderEntry, "id" | "defaultModel" | "models">;

export interface ResolveLegacyChatAiSelectionInput {
  legacyProviderId: string | null;
  legacyModelId: string | null;
  effectiveProviderId: string | null;
  providers: readonly MigrationProvider[];
}

export interface ResolvedLegacyChatAiSelection {
  providerId: string | null;
  modelId: string | null;
  outcome: ChatAiSelectionMigrationOutcome;
  reason: ChatAiSelectionMigrationReason;
}

function findProvider(providers: readonly MigrationProvider[], providerId: string | null) {
  const normalizedProviderId = providerId?.trim();
  if (!normalizedProviderId) return null;
  return (
    providers.find(
      (provider) => provider.id.trim() === normalizedProviderId && provider.id.trim().length > 0,
    ) ?? null
  );
}

function providerHasModel(provider: MigrationProvider, modelId: string): boolean {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return false;
  if (provider.defaultModel.trim() === normalizedModelId) return true;
  return (provider.models ?? []).some((model) => model.id.trim() === normalizedModelId);
}

/**
 * Executable contract for the hand-written SQL backfill. It intentionally returns
 * no selection for unsafe legacy data so the chat inherits the Bot defaults.
 */
export function resolveLegacyChatAiSelection(
  input: ResolveLegacyChatAiSelectionInput,
): ResolvedLegacyChatAiSelection {
  const legacyProviderId = input.legacyProviderId?.trim() || null;
  const legacyModelId = input.legacyModelId?.trim() || null;
  const explicitProvider = findProvider(input.providers, legacyProviderId);

  if (legacyProviderId && !legacyModelId) {
    return explicitProvider
      ? {
          providerId: explicitProvider.id.trim(),
          modelId: null,
          outcome: "migrated_provider_default",
          reason: "provider_only_valid",
        }
      : {
          providerId: null,
          modelId: null,
          outcome: "inherited",
          reason: "provider_only_invalid_provider",
        };
  }

  if (!legacyProviderId && legacyModelId) {
    const effectiveProvider = findProvider(input.providers, input.effectiveProviderId);
    if (!effectiveProvider) {
      return {
        providerId: null,
        modelId: null,
        outcome: "inherited",
        reason: "model_only_no_effective_provider",
      };
    }
    return providerHasModel(effectiveProvider, legacyModelId)
      ? {
          providerId: effectiveProvider.id.trim(),
          modelId: legacyModelId,
          outcome: "migrated_pair",
          reason: "model_only_valid",
        }
      : {
          providerId: null,
          modelId: null,
          outcome: "inherited",
          reason: "model_only_invalid_model",
        };
  }

  if (!explicitProvider) {
    return {
      providerId: null,
      modelId: null,
      outcome: "inherited",
      reason: "pair_invalid_provider",
    };
  }
  if (legacyModelId && providerHasModel(explicitProvider, legacyModelId)) {
    return {
      providerId: explicitProvider.id.trim(),
      modelId: legacyModelId,
      outcome: "migrated_pair",
      reason: "pair_valid",
    };
  }
  return {
    providerId: explicitProvider.id.trim(),
    modelId: null,
    outcome: "migrated_provider_default",
    reason: "pair_invalid_model_provider_default",
  };
}
