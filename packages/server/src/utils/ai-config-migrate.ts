import type { AiConfigStored, AiProviderEntry } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";

/** Stable synthetic id used when wrapping legacy flat config into providers[0].
 *  Fixed (not random) so PUT handlers can look it up reliably across calls. */
const LEGACY_PROVIDER_ID = "__legacy__";

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
    if (
      !normalized.activeProviderId ||
      !normalized.providers.some((p) => p.id === normalized.activeProviderId)
    ) {
      return { ...normalized, activeProviderId: normalized.providers[0]!.id };
    }
    return normalized;
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

  return {
    ...normalized,
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
