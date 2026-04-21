import { randomUUID } from "node:crypto";
import type { AiConfigStored, AiProviderEntry } from "@cos-tool-bot/shared";

/** Wrap legacy flat AI config fields into providers[0] on first access.
 *  Idempotent: if providers[] non-empty, returns input unchanged.
 *  Does NOT strip legacy top-level fields (preserved for rollback compat). */
export function migrateAiConfig(stored: AiConfigStored): AiConfigStored {
  if (stored.providers && stored.providers.length > 0) {
    if (
      !stored.activeProviderId ||
      !stored.providers.some((p) => p.id === stored.activeProviderId)
    ) {
      return { ...stored, activeProviderId: stored.providers[0]!.id };
    }
    return stored;
  }

  const legacy: AiProviderEntry = {
    id: randomUUID(),
    label: "Default",
    encryptedApiKey: stored.encryptedApiKey,
    baseURL: stored.baseURL,
    providerFormat: stored.providerFormat ?? "openai",
    defaultModel: stored.model,
    models: stored.models,
  };

  return {
    ...stored,
    providers: [legacy],
    activeProviderId: legacy.id,
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
