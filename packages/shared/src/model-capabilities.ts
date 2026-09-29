import type { ModelCapability } from "./ai-providers.js";

const KNOWN_CAPABILITIES: Record<string, ModelCapability[]> = {
  // OpenAI
  "gpt-4o": ["vision", "tool_calling", "code"],
  "gpt-4o-mini": ["vision", "tool_calling", "code"],
  "gpt-4-turbo": ["vision", "tool_calling", "code"],
  "gpt-4.1": ["vision", "tool_calling", "code", "long_context"],
  "gpt-4.1-mini": ["vision", "tool_calling", "code", "long_context"],
  "gpt-4.1-nano": ["tool_calling", "code"],
  o1: ["reasoning", "vision", "tool_calling", "code"],
  "o1-mini": ["reasoning", "code"],
  "o1-preview": ["reasoning", "code"],
  o3: ["reasoning", "vision", "tool_calling", "code"],
  "o3-mini": ["reasoning", "tool_calling", "code"],
  "o4-mini": ["reasoning", "vision", "tool_calling", "code"],

  // Anthropic
  "claude-3.5-sonnet": ["vision", "tool_calling", "code", "long_context"],
  "claude-3.5-haiku": ["vision", "tool_calling", "code"],
  "claude-3-opus": ["vision", "tool_calling", "code", "long_context"],
  "claude-3-sonnet": ["vision", "tool_calling", "code"],
  "claude-3-haiku": ["vision", "tool_calling", "code"],
  "claude-sonnet-4": ["vision", "tool_calling", "code", "long_context", "reasoning"],
  "claude-opus-4": ["vision", "tool_calling", "code", "long_context", "reasoning"],

  // DeepSeek
  "deepseek-chat": ["tool_calling", "code", "long_context"],
  "deepseek-reasoner": ["reasoning", "code", "long_context"],

  // Google
  "gemini-2.0-flash": ["vision", "tool_calling", "web_search", "code"],
  "gemini-2.0-pro": ["vision", "tool_calling", "web_search", "code", "long_context"],
  "gemini-2.5-flash": ["vision", "tool_calling", "web_search", "code", "reasoning"],
  "gemini-2.5-pro": ["vision", "tool_calling", "web_search", "code", "long_context", "reasoning"],
  "gemini-1.5-pro": ["vision", "tool_calling", "code", "long_context"],
  "gemini-1.5-flash": ["vision", "tool_calling", "code"],

  // Qwen
  "qwen-plus": ["tool_calling", "code", "long_context"],
  "qwen-max": ["tool_calling", "code", "long_context"],
  "qwen-turbo": ["tool_calling", "code"],
  "qwq-plus": ["reasoning", "tool_calling", "code"],
};

function heuristicCapabilities(modelId: string): ModelCapability[] {
  const lower = modelId.toLowerCase();
  const caps: ModelCapability[] = [];

  // Vision
  if (
    lower.includes("vision") ||
    lower.includes("4o") ||
    lower.includes("gemini") ||
    lower.includes("claude-3") ||
    lower.includes("claude-sonnet") ||
    lower.includes("claude-opus")
  ) {
    caps.push("vision");
  }

  // Reasoning
  if (
    lower.includes("reasoner") ||
    lower.includes("reasoning") ||
    /\bo[134]-/.test(lower) ||
    lower.includes("qwq") ||
    lower.includes("r1")
  ) {
    caps.push("reasoning");
  }

  // Tool calling
  if (
    lower.includes("gpt-4") ||
    lower.includes("gpt-3.5") ||
    lower.includes("claude") ||
    lower.includes("gemini") ||
    lower.includes("qwen") ||
    lower.includes("deepseek-chat") ||
    lower.includes("tool")
  ) {
    caps.push("tool_calling");
  }

  // Long context
  if (lower.includes("long") || lower.includes("128k") || lower.includes("200k")) {
    caps.push("long_context");
  }

  // Code
  if (
    lower.includes("code") ||
    lower.includes("coder") ||
    lower.includes("deepseek") ||
    lower.includes("gpt-4") ||
    lower.includes("claude")
  ) {
    caps.push("code");
  }

  // Web search
  if (lower.includes("search") || lower.includes("online")) {
    caps.push("web_search");
  }

  return [...new Set(caps)];
}

export function inferCapabilities(modelId: string): ModelCapability[] {
  // Try exact match first
  if (KNOWN_CAPABILITIES[modelId]) {
    return KNOWN_CAPABILITIES[modelId];
  }

  // Try prefix match (e.g. "gpt-4o-2024-11-20" matches "gpt-4o").
  // Longest key first so "o1-mini" wins over "o1".
  const byKeyLengthDesc = Object.entries(KNOWN_CAPABILITIES).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [key, caps] of byKeyLengthDesc) {
    if (modelId.startsWith(key)) {
      return caps;
    }
  }

  // Fall back to heuristics
  return heuristicCapabilities(modelId);
}
