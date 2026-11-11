/** Immutable authored content only; credentials, tools and memories are deliberately absent. */
export interface PromptSnapshot {
  systemPrompt: string;
  behavioralPrompt: string;
  groupBehavioralPrompt: string;
  files: Array<{ name: string; content: string; enabled: boolean }>;
  maxInjectionBytes: number;
  skills: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    summary: string;
    source: string;
    digest: string;
    instructions: string;
    resources: Record<string, string>;
    enabled: boolean;
  }>;
}
export interface PromptPreviewSnapshot {
  fullPrompt: string;
  estimatedTokens: number;
  sections: Array<{ id: string; estimatedTokens: number }>;
}
export interface PromptVersion {
  id: string;
  botId: string;
  name: string;
  description: string;
  createdAt: string;
  applicationVersion: string;
  snapshot: PromptSnapshot;
  previews: { private: PromptPreviewSnapshot; group: PromptPreviewSnapshot };
}

export type PromptVersionSummary = Omit<PromptVersion, "snapshot" | "previews"> & {
  privateTokens: number;
  groupTokens: number;
};
