import type { ModelEntry } from "@cos-tool-bot/shared";
import type { ModelOption } from "./types";

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

export function groupFetchedModels(models: ModelOption[]): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const key = m.owned_by || "other";
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
