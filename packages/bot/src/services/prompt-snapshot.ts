import type { PromptSnapshot } from "@cos-tool-bot/shared";
import type { DataFilesConfig } from "../utils/data-files.js";
import type { BotSkillDefinition } from "../skills/catalog.js";

export interface PromptSnapshotConfig {
  systemPrompt?: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  dataFiles?: DataFilesConfig;
  skills?: readonly BotSkillDefinition[];
  getPromptSnapshot?: () => Promise<{ id: string; snapshot: PromptSnapshot } | null>;
  promptVersionId?: string;
}
export function snapshotDataFiles(snapshot: PromptSnapshot, dataDir: string): DataFilesConfig {
  const pinned = structuredClone(snapshot.files);
  const files: Array<{ name: string; content: string }> = [];
  let bytes = 0;
  for (const file of pinned.filter((file) => file.enabled)) {
    if (!file.content.trim()) continue;
    const size = Buffer.byteLength(file.content, "utf8");
    if (bytes + size > snapshot.maxInjectionBytes) break;
    bytes += size;
    files.push({ name: file.name, content: file.content });
  }
  return {
    dataDir,
    injectableFiles: new Set(pinned.filter((file) => file.enabled).map((file) => file.name)),
    snapshotFiles: Object.fromEntries(pinned.map((file) => [file.name, file.content])),
    loadFiles: async () => files.map((file) => ({ ...file })),
  };
}
/** Capture once when a turn starts executing, including resources used by later tool calls. */
export async function capturePromptConfig<T extends PromptSnapshotConfig>(
  config: T,
): Promise<T & PromptSnapshotConfig> {
  const active = await config.getPromptSnapshot?.();
  if (active) {
    const snapshot = structuredClone(active.snapshot);
    return {
      ...config,
      systemPrompt: snapshot.systemPrompt,
      behavioralPrompt: snapshot.behavioralPrompt,
      groupBehavioralPrompt: snapshot.groupBehavioralPrompt,
      promptVersionId: active.id,
      skills: snapshot.skills.filter((skill) => skill.enabled),
      dataFiles: snapshotDataFiles(snapshot, config.dataFiles?.dataDir ?? ""),
      getPromptSnapshot: undefined,
    };
  }
  return {
    ...config,
    skills: config.skills ? structuredClone(config.skills) : undefined,
    getPromptSnapshot: undefined,
  };
}
