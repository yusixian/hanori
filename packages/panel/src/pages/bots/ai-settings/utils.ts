import type {
  AiConfigPublic,
  AiProviderEntryPublic,
  ImageOcrConfig,
  ModelEntry,
  SummaryConfigStored,
} from "@cos-tool-bot/shared";
import { replaceProviderModels } from "./model-discovery";

export type AiConfigSaveRecoveryResult = "not-applicable" | "reloaded" | "reload-failed";

export async function recoverAiConfigAfterApplyFailure(
  response: { status: number; code?: string },
  reload: () => Promise<boolean>,
): Promise<AiConfigSaveRecoveryResult> {
  if (response.status !== 503 || response.code !== "saved_apply_failed") {
    return "not-applicable";
  }

  try {
    return (await reload()) ? "reloaded" : "reload-failed";
  } catch {
    return "reload-failed";
  }
}

export function groupModelsByProvider(models: ModelEntry[]): [string, ModelEntry[]][] {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const parts = m.id.split(/[/-]/);
    const provider = parts.length > 2 ? parts[0]! : "default";
    const list = groups.get(provider) ?? [];
    list.push(m);
    groups.set(provider, list);
  }
  return [...groups.entries()];
}

export function resolveManagedProviderIdAfterSave({
  currentProviderId,
  draftProviderIds,
  savedProviders,
  activeProviderId,
}: {
  currentProviderId?: string;
  draftProviderIds: string[];
  savedProviders: AiProviderEntryPublic[];
  activeProviderId?: string;
}) {
  if (currentProviderId) {
    const draftIndex = draftProviderIds.indexOf(currentProviderId);
    const remappedProviderId = draftIndex >= 0 ? savedProviders[draftIndex]?.id : undefined;
    if (remappedProviderId) return remappedProviderId;
    if (savedProviders.some((provider) => provider.id === currentProviderId)) {
      return currentProviderId;
    }
  }
  return activeProviderId ?? savedProviders[0]?.id;
}

export function renameProviderModelReferences({
  config,
  summaryConfig,
  imageOcrConfig,
  providerId,
  currentId,
  nextId,
}: {
  config: AiConfigPublic;
  summaryConfig: SummaryConfigStored;
  imageOcrConfig: ImageOcrConfig;
  providerId: string;
  currentId: string;
  nextId: string;
}) {
  const usesActiveProvider = config.activeProviderId === providerId;
  const githubUsesProvider =
    config.githubToolsConfig?.codingProviderId === providerId ||
    (!config.githubToolsConfig?.codingProviderId && usesActiveProvider);
  const ocrUsesProvider =
    imageOcrConfig.providerId === providerId || (!imageOcrConfig.providerId && usesActiveProvider);

  return {
    config: {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === providerId
          ? {
              ...replaceProviderModels(
                provider,
                (provider.models ?? []).map((model) =>
                  model.id === currentId ? { ...model, id: nextId } : model,
                ),
              ),
              defaultModel: provider.defaultModel === currentId ? nextId : provider.defaultModel,
            }
          : provider,
      ),
      githubToolsConfig:
        config.githubToolsConfig?.codingModelId === currentId && githubUsesProvider
          ? { ...config.githubToolsConfig, codingModelId: nextId }
          : config.githubToolsConfig,
      agentToolsConfig:
        usesActiveProvider && config.agentToolsConfig?.subAgentModel === currentId
          ? { ...config.agentToolsConfig, subAgentModel: nextId }
          : config.agentToolsConfig,
    },
    summaryConfig:
      usesActiveProvider && summaryConfig.modelId === currentId
        ? { ...summaryConfig, modelId: nextId }
        : summaryConfig,
    imageOcrConfig:
      imageOcrConfig.modelId === currentId && ocrUsesProvider
        ? { ...imageOcrConfig, modelId: nextId }
        : imageOcrConfig,
  };
}
