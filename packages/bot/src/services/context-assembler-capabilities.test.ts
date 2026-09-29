import type { Tool } from "ai";
import { describe, expect, it } from "vitest";
import { deriveCapabilitiesFromTools } from "../utils/tool-capabilities.js";
import {
  assembleContext,
  assemblePromptPreview,
  buildContinueChatPromptBundle,
} from "./context-assembler.js";

const segmentTurnTools = {
  multi_message: {} as Tool,
  get_current_time: {} as Tool,
  web_search: {} as Tool,
  fetch_webpage: {} as Tool,
};

describe("prompt tool capabilities", () => {
  it("keeps runtime, public preview, and continuation search prompts aligned", async () => {
    const runtimeConfig = {
      enabled: true,
      search: { provider: "tavily" as const, apiKey: "secret" },
    };
    const runtime = await assembleContext({
      systemPrompt: "System",
      isPrivate: true,
      chatId: 42,
      userName: "Nahida",
      maxContextMessages: 20,
      timerMaxSeconds: 604_800,
      webToolsConfig: runtimeConfig,
      toolCapabilities: deriveCapabilitiesFromTools(segmentTurnTools),
    });
    const preview = await assemblePromptPreview({
      systemPrompt: "System",
      isPrivate: true,
      memoryEnabled: false,
      botMemoryEnabled: false,
      timerMaxSeconds: 604_800,
      webToolsConfig: {
        enabled: true,
        search: { provider: "tavily", hasApiKey: true },
      },
    });
    const continuation = await buildContinueChatPromptBundle({
      systemPrompt: "System",
      chatId: 42,
      moodState: new Map(),
      timerMaxSeconds: 604_800,
      webToolsConfig: runtimeConfig,
      toolCapabilities: deriveCapabilitiesFromTools(segmentTurnTools),
    });

    expect(preview.trace.staticPrefixHash).toBe(runtime.trace.staticPrefixHash);
    expect(continuation.trace.staticPrefixHash).toBe(runtime.trace.staticPrefixHash);
    expect(preview.fullPrompt).toContain("- web_search: 搜索网络获取最新信息");
    expect(preview.fullPrompt).toContain("单个定时器最长 604800 秒");
  });

  it("does not advertise search from invalid preview config or config alone at runtime", async () => {
    const invalidPreview = await assemblePromptPreview({
      systemPrompt: "System",
      isPrivate: true,
      memoryEnabled: false,
      botMemoryEnabled: false,
      webToolsConfig: {
        enabled: true,
        search: { provider: "brave", hasApiKey: false },
      },
    });
    const runtimeWithoutSearch = await assembleContext({
      systemPrompt: "System",
      isPrivate: true,
      chatId: 42,
      userName: "Nahida",
      maxContextMessages: 20,
      webToolsConfig: {
        enabled: true,
        search: { provider: "custom", baseURL: "https://search.example.com" },
      },
      toolCapabilities: deriveCapabilitiesFromTools({ fetch_webpage: {} as Tool }),
    });

    for (const prompt of [invalidPreview.fullPrompt, runtimeWithoutSearch.messages[0]!.content]) {
      expect(prompt).toContain("- fetch_webpage: 获取网页正文内容");
      expect(prompt).not.toContain("- web_search: 搜索网络获取最新信息");
      expect(prompt).not.toContain("用 web_search 查证");
    }
  });
});
