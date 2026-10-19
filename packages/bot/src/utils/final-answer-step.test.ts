import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage, type Tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { prepareFinalAnswerStep } from "./final-answer-step.js";
import { createSkillTools } from "../tools/skills.js";
import { resolveBuiltInSkills } from "../skills/catalog.js";
import { composeTurnTools } from "./tool-pipeline.js";
import { createRequestCache } from "../tools/utils.js";

describe("final answer step", () => {
  it("ends repeated missing Skill resource calls with an explanation after three attempts", async () => {
    const onLog = vi.fn();
    const onEffect = vi.fn();
    const tools = composeTurnTools(
      createSkillTools({
        skills: resolveBuiltInSkills(["prompt-atelier"]),
        hasImageGeneration: true,
        hasWebSearch: false,
      }),
      { requestCache: createRequestCache(), getStep: () => 1, onLog, onEffect },
    );
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const final = options.toolChoice?.type === "none";
        return {
          content: final
            ? [{ type: "text", text: "参考资料不存在，尚未提交生图请求。" }]
            : [
                {
                  type: "tool-call",
                  toolCallId: `load-${++callCount}`,
                  toolName: "load_skill",
                  input: JSON.stringify({ skill: "prompt-atelier", resource: "missing.md" }),
                },
              ],
          finishReason: { unified: final ? "stop" : "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const result = await generateText({
      model,
      tools,
      prompt: "draw",
      prepareStep: prepareFinalAnswerStep(20),
      stopWhen: stepCountIs(20),
    });
    expect(result.steps).toHaveLength(4);
    expect(result.text).toContain("尚未提交");
    expect(onEffect).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "AI tool result",
        meta: expect.objectContaining({
          success: false,
          output: expect.objectContaining({ code: "skill_retry_limit", attempts: 3 }),
        }),
      }),
    );
  });

  it("preserves a single allowed action when the turn budget is one step", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "tool-call", toolCallId: "write", toolName: "write", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 0, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const tools: Record<string, Tool> = {
      write: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute }),
    };
    const result = await generateText({
      model,
      prompt: "Perform one action",
      tools,
      prepareStep: prepareFinalAnswerStep(1),
      stopWhen: stepCountIs(1),
    });
    expect(model.doGenerateCalls[0]!.tools?.map((item) => item.name)).toEqual(["write"]);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.steps).toHaveLength(1);
  });
  it("answers from accumulated tool results before the SDK step budget is exhausted", async () => {
    const execute = vi.fn(async () => ({ text: "A subtitle excerpt" }));
    let toolCalls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const final = options.toolChoice?.type === "none";
        return {
          content: final
            ? [{ type: "text", text: "Summary of the collected subtitles" }]
            : [
                {
                  type: "tool-call",
                  toolCallId: `read-${++toolCalls}`,
                  toolName: "read",
                  input: "{}",
                },
              ],
          finishReason: { unified: final ? "stop" : "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const prepareStep = vi.fn(({ messages }: { messages: ModelMessage[] }) => ({ messages }));
    const tools: Record<string, Tool> = {
      read: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute }),
    };
    const result = await generateText({
      model,
      prompt: "Summarize this video",
      tools,
      prepareStep: prepareFinalAnswerStep(10, prepareStep),
      stopWhen: stepCountIs(10),
    });
    expect(execute).toHaveBeenCalledTimes(9);
    expect(result.steps).toHaveLength(10);
    expect(result.text).toBe("Summary of the collected subtitles");
    const final = model.doGenerateCalls[9]!;
    expect(final.tools).toEqual([]);
    expect(final.toolChoice).toEqual({ type: "none" });
    expect(final.prompt.filter((message) => message.role === "tool")).toHaveLength(9);
    expect(prepareStep).toHaveBeenCalledTimes(10);
  });

  it("preserves the existing context preparation, including avatar image parts", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image" as const, image: new Uint8Array([1, 2]), mediaType: "image/png" },
        ],
      },
    ];
    const prepare = prepareFinalAnswerStep(2, () => ({ messages }));
    const model = new MockLanguageModelV3();
    const options = { steps: [], messages: [], model, experimental_context: undefined };
    expect(await prepare({ ...options, stepNumber: 0 })).toEqual({ messages });
    expect(await prepare({ ...options, stepNumber: 1 })).toEqual({
      messages,
      activeTools: [],
      toolChoice: "none",
    });
  });
});
