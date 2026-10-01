import { client } from "@/lib/client";
import type { AiProviderEntryPublic, ModelEntry } from "@cos-tool-bot/shared";

export function modelDiscoveryPath(provider: AiProviderEntryPublic) {
  return provider.modelDiscoveryPath ?? "/models";
}

export function mergeDiscoveredModels(
  provider: AiProviderEntryPublic,
  discovered: ModelEntry[],
): AiProviderEntryPublic {
  const models = [...(provider.models ?? [])];
  const known = new Set(models.map((model) => model.id));
  const excluded = new Set(provider.excludedModelIds);
  for (const model of discovered) {
    if (known.has(model.id) || excluded.has(model.id)) continue;
    models.push({ id: model.id, capabilities: model.capabilities });
    known.add(model.id);
  }
  if (models.length === (provider.models?.length ?? 0)) return provider;
  return { ...provider, models, defaultModel: provider.defaultModel || models[0]!.id };
}

export function replaceProviderModels(provider: AiProviderEntryPublic, models: ModelEntry[]) {
  const included = new Set(models.map((model) => model.id));
  const excluded = new Set(provider.excludedModelIds);
  for (const model of provider.models ?? []) {
    if (!included.has(model.id)) excluded.add(model.id);
  }
  for (const id of included) excluded.delete(id);
  return { ...provider, models, excludedModelIds: [...excluded] };
}

function formatApiError(error: unknown, fallback: string) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    const detail = error.issues
      .map((issue) => {
        if (!issue || typeof issue !== "object") return "";
        const path =
          "path" in issue && Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
        const message = "message" in issue ? String(issue.message) : "";
        return path && message ? `${path}: ${message}` : message;
      })
      .filter(Boolean)
      .join("; ");
    if (detail) return detail;
  }
  return fallback;
}

export async function fetchProviderModels(
  botId: string,
  provider: AiProviderEntryPublic,
  apiKey: string,
  signal: AbortSignal,
  fallbackError: string,
): Promise<ModelEntry[]> {
  const response = await client.api.bots[":botId"]["ai-models"].$post(
    {
      param: { botId },
      json: {
        providerId: provider.id,
        baseURL: provider.baseURL || undefined,
        apiKey: apiKey.trim() || undefined,
        modelDiscoveryPath: modelDiscoveryPath(provider),
      },
    },
    { init: { signal } },
  );
  const body = await response.json();
  if (!body.ok) {
    throw new Error(formatApiError("error" in body ? body.error : undefined, fallbackError));
  }
  return body.data;
}
