import type { AiProviderEntryPublic, ModelEntry } from "@cos-tool-bot/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchProviderModels, modelDiscoveryPath } from "./model-discovery";

type DiscoveryInput = {
  botId: string;
  enabled: boolean;
  providers: AiProviderEntryPublic[];
  apiKeys: Record<string, string>;
  onDiscover: (providerId: string, models: ModelEntry[]) => void;
};

function connectionKey(provider: AiProviderEntryPublic, apiKey: string) {
  return JSON.stringify([
    provider.baseURL,
    provider.providerFormat,
    modelDiscoveryPath(provider),
    provider.hasApiKey,
    apiKey,
  ]);
}

export function useModelDiscovery(input: DiscoveryInput) {
  const { t } = useTranslation("aiSettings");
  const latest = useRef({ ...input, t });
  latest.current = { ...input, t };
  const requests = useRef(new Map<string, AbortController>());
  const [fetching, setFetching] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async (providerId: string) => {
    const { botId, enabled, providers, apiKeys, t } = latest.current;
    const provider = providers.find((entry) => entry.id === providerId);
    if (!enabled || !provider || !modelDiscoveryPath(provider).trim() || !provider.baseURL) return;
    const apiKey = apiKeys[providerId] ?? "";
    if (!provider.hasApiKey && !apiKey.trim()) return;
    const key = connectionKey(provider, apiKey);
    requests.current.get(providerId)?.abort();
    const controller = new AbortController();
    requests.current.set(providerId, controller);
    const isCurrent = () => {
      const current = latest.current;
      const entry = current.providers.find((candidate) => candidate.id === providerId);
      return (
        !controller.signal.aborted &&
        current.enabled &&
        current.botId === botId &&
        entry &&
        connectionKey(entry, current.apiKeys[providerId] ?? "") === key
      );
    };
    setFetching((previous) => new Set(previous).add(providerId));
    setErrors((previous) => {
      const { [providerId]: _, ...rest } = previous;
      return rest;
    });
    try {
      const models = await fetchProviderModels(
        botId,
        provider,
        apiKey,
        controller.signal,
        t("models.fetchError"),
      );
      if (isCurrent()) latest.current.onDiscover(providerId, models);
    } catch (error) {
      if (isCurrent()) {
        setErrors((previous) => ({
          ...previous,
          [providerId]: error instanceof Error ? error.message : t("models.fetchError"),
        }));
      }
    } finally {
      if (requests.current.get(providerId) === controller) {
        requests.current.delete(providerId);
        setFetching((previous) => {
          const next = new Set(previous);
          next.delete(providerId);
          return next;
        });
      }
    }
  }, []);

  useEffect(() => {
    setFetching(new Set());
    setErrors({});
    if (input.enabled) {
      for (const provider of latest.current.providers) void refresh(provider.id);
    }
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [input.botId, input.enabled, refresh]);

  return { fetching, errors, refresh };
}
