import type { AgentToolsConfig, BotLogEntry, WebToolsConfig } from "@cos-tool-bot/shared";
import type { CoreTool } from "ai";
import { generateText, tool } from "ai";
import type { LanguageModelV1 } from "ai";
import { z } from "zod";
import { zodToAiSchema } from "./utils.js";
import { createWebTools } from "./web.js";

interface AgentDefinition {
  systemPrompt: string;
  tools: Record<string, CoreTool>;
  maxSteps: number;
}

function buildThinkTool(onLog?: (entry: BotLogEntry) => void | Promise<void>): CoreTool {
  return tool({
    description: "内部推理工具。用来深度思考、分析问题。内容不会发送给用户。",
    parameters: zodToAiSchema(
      z.object({
        thought: z.string().describe("思考过程"),
      }),
    ),
    execute: async ({ thought }) => {
      onLog?.({ level: "debug", message: `[sub-agent think] ${thought}` });
      return { acknowledged: true };
    },
  });
}

function buildAgentDefinitions(
  webToolsConfig?: WebToolsConfig,
  agentConfig?: AgentToolsConfig,
  onLog?: (entry: BotLogEntry) => void | Promise<void>,
): Record<string, AgentDefinition> {
  const thinkTool = buildThinkTool(onLog);

  // Build web tools for researcher if available
  let webTools: Record<string, CoreTool> = {};
  if (webToolsConfig?.enabled) {
    webTools = createWebTools({ config: webToolsConfig });
  }

  const defaults: Record<string, AgentDefinition> = {
    researcher: {
      systemPrompt:
        "你是一个研究助手。使用搜索和网页获取工具来回答问题。先搜索，再深入阅读相关页面，最后总结发现。输出简洁的研究结果。",
      tools: { ...webTools, think: thinkTool },
      maxSteps: 5,
    },
    creative_writer: {
      systemPrompt:
        "你是一个创意写作助手。擅长诗歌、故事、文案、对联等创意内容。用 think 工具来构思，然后输出成品。",
      tools: { think: thinkTool },
      maxSteps: 3,
    },
    code_helper: {
      systemPrompt: "你是一个代码助手。擅长代码分析、解释、生成和调试。用 think 工具来组织思路。",
      tools: { think: thinkTool },
      maxSteps: 3,
    },
    translator: {
      systemPrompt:
        "你是一个专业翻译。提供准确、自然的翻译，保留原文的语气和风格。如果原文是中文则翻译为英文，反之亦然，除非另有指示。",
      tools: { think: thinkTool },
      maxSteps: 2,
    },
  };

  // Apply custom overrides and filter disabled agents
  if (agentConfig?.agents) {
    for (const [name, override] of Object.entries(agentConfig.agents)) {
      if (override.enabled === false) {
        delete defaults[name];
      } else if (defaults[name] && override.systemPrompt) {
        defaults[name]!.systemPrompt = override.systemPrompt;
      }
    }
  }

  return defaults;
}

const MAX_SUB_AGENT_RESULT_LENGTH = 3000;
const RESEARCHER_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function getAvailableAgentNames(
  agentConfig?: AgentToolsConfig,
  webToolsConfig?: WebToolsConfig,
): string[] {
  const defs = buildAgentDefinitions(webToolsConfig, agentConfig);
  return Object.keys(defs);
}

export interface AgentToolsOptions {
  provider: (model: string) => LanguageModelV1;
  model: string;
  agentConfig?: AgentToolsConfig;
  webToolsConfig?: WebToolsConfig;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
}

export function createAgentTools(options: AgentToolsOptions): Record<string, CoreTool> {
  const { provider, model, agentConfig, webToolsConfig, onLog } = options;

  const agentDefs = buildAgentDefinitions(webToolsConfig, agentConfig, onLog);
  const availableAgents = Object.keys(agentDefs);

  if (availableAgents.length === 0) return {};

  return {
    delegate_task: tool({
      description: `将子任务委派给专门的 agent。可用 agents: ${availableAgents.join(", ")}。适合复杂任务分解，如深度研究、创意写作、代码分析、翻译等。`,
      parameters: zodToAiSchema(
        z.object({
          agent: z.string().describe(`agent 名称，可选: ${availableAgents.join(", ")}`),
          task: z.string().describe("具体任务描述"),
          context: z.string().optional().describe("相关上下文信息"),
        }),
      ),
      execute: async ({ agent, task, context }) => {
        const def = agentDefs[agent];
        if (!def)
          return { error: `Unknown agent: ${agent}. Available: ${availableAgents.join(", ")}` };

        const subAgentModel = agentConfig?.subAgentModel ?? model;
        const maxSteps = agentConfig?.maxSubAgentSteps ?? def.maxSteps;
        const prompt = context ? `背景信息:\n${context}\n\n任务:\n${task}` : task;

        onLog?.({
          level: "debug",
          message: `[delegate] agent=${agent} task=${task.slice(0, 100)}`,
          meta: { agent, subAgentModel, maxSteps },
        });

        try {
          const result = await generateText({
            model: provider(subAgentModel),
            system: def.systemPrompt,
            prompt,
            tools: def.tools,
            maxSteps,
            abortSignal: AbortSignal.timeout(
              agent === "researcher" ? RESEARCHER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
            ),
          });

          const text =
            result.text.length > MAX_SUB_AGENT_RESULT_LENGTH
              ? result.text.slice(0, MAX_SUB_AGENT_RESULT_LENGTH) + "..."
              : result.text;

          onLog?.({
            level: "debug",
            message: `[delegate] agent=${agent} done, steps=${result.steps.length}`,
            meta: { agent, steps: result.steps.length, resultLength: result.text.length },
          });

          return { agent, result: text, steps: result.steps.length };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onLog?.({
            level: "warn",
            message: `[delegate] agent=${agent} failed: ${msg}`,
          });
          return { error: `Sub-agent ${agent} failed: ${msg}` };
        }
      },
    }),
  };
}
