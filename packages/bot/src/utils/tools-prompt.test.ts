import { DEFAULT_TIMER_MAX_SECONDS } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import { buildExtendedToolsPrompt, type ExtendedToolsPromptOptions } from "./tools-prompt.js";

function promptOptions(
  overrides: Partial<ExtendedToolsPromptOptions> = {},
): ExtendedToolsPromptOptions {
  return {
    capabilities: new Set(),
    availableAgents: [],
    isPrivate: false,
    timerMaxSeconds: DEFAULT_TIMER_MAX_SECONDS,
    ...overrides,
  };
}

describe("buildExtendedToolsPrompt", () => {
  it("states the configured timer ceiling", () => {
    const prompt = buildExtendedToolsPrompt(promptOptions({ timerMaxSeconds: 604_800 }));

    expect(prompt).toContain("单个定时器最长 604800 秒");
    expect(prompt).not.toContain("86400");
  });

  it("states the default ceiling when the Bot keeps it", () => {
    const prompt = buildExtendedToolsPrompt(promptOptions());

    expect(prompt).toContain("单个定时器最长 86400 秒");
  });
});
