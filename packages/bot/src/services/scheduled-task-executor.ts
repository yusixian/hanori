import { capturePromptConfig } from "./prompt-snapshot.js";
import { createAiSelectionRuntime } from "../handlers/ai-selection.js";
import { createWebTools } from "../tools/web.js";
import { PendingAdminActionRegistry } from "./pending-github-actions.js";
import type {
  AgentExecutionConfig,
  AgentToolsConfig,
  ScheduledTaskPlan,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_SUB_AGENT_MAX_STEPS,
  DEFAULT_TIMEOUT_CONFIG,
  isRichMessageEnabled,
} from "@cos-tool-bot/shared";
import { generateText, stepCountIs, tool, type LanguageModel, type Tool } from "ai";
import { Api } from "grammy";
import { z } from "zod";
import {
  createTurnToolset,
  resolveImageGenerationActor,
  type TurnToolsetConfig,
} from "../tools/turn-toolset.js";
import { createOnceGuard, zodToAiSchema } from "../tools/utils.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { splitMessage } from "../utils/split-message.js";
import { isTextCoveredByDeliveries } from "../utils/delivery.js";

const DEFAULT_TASK_PROMPT =
  "你是定时任务执行助手。只执行已批准的计划，按需读取计划允许的数据，不假设拥有完整聊天记录。数据不足时明确说明缺口，不编造总结。其他工具的确认要求仍然有效。";
const DEFAULT_TASK_TOOLS = [
  "read_task_history",
  "web_search",
  "fetch_webpage",
  "search",
  "read_reference",
];

export interface TaskHistoryMessage {
  content: string;
  createdAt: string;
  userName?: string | null;
  role: string;
}
export interface ScheduledTaskExecutorConfig {
  taskAgentConfig?: AgentExecutionConfig;
  agentToolsConfig?: AgentToolsConfig;
  toolsetConfig: TurnToolsetConfig;
  /** Resolves existing administrator-managed credentials. Explicit unknown selections must fail. */
  resolveModel(
    providerId?: string,
    modelId?: string,
  ): {
    model: LanguageModel;
    providerId: string;
    modelId: string;
  };
  /** The implementation must query only this Bot/chat/thread and respect privacy filters. */
  readTaskHistory(input: {
    chatId: number;
    threadId?: number;
    since: Date;
    until: Date;
    limit: number;
  }): Promise<{ messages: TaskHistoryMessage[]; complete: boolean }>;
}
export interface ScheduledTaskExecutorInput {
  api: Api;
  plan: ScheduledTaskPlan;
  /** Source scope is the approved task's chat, independently of its delivery destination. */
  chatId: number;
  threadId?: number;
  userId: number;
  config: ScheduledTaskExecutorConfig;
  signal?: AbortSignal;
  now?: Date;
  onAgentResolved?: (agent: AgentExecutionConfig) => Promise<void>;
}
export interface ScheduledTaskExecutionResult {
  output: string;
  agent: AgentExecutionConfig;
  messageIds: number[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export function resolveTaskAgentConfig(
  plan: Pick<ScheduledTaskPlan, "agent" | "agentName">,
  defaults?: AgentExecutionConfig,
  agents?: AgentToolsConfig,
): AgentExecutionConfig {
  const named = plan.agentName ? agents?.agents?.[plan.agentName] : undefined;
  if (plan.agentName && (!named || named.enabled === false)) {
    throw new Error(`Task Agent is not configured or is disabled: ${plan.agentName}`);
  }
  const defined = (value: AgentExecutionConfig = {}) =>
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  return {
    systemPrompt: DEFAULT_TASK_PROMPT,
    toolNames: DEFAULT_TASK_TOOLS,
    timeoutMs: DEFAULT_TIMEOUT_CONFIG.defaultAgentMs,
    maxSteps: agents?.maxSubAgentSteps ?? DEFAULT_SUB_AGENT_MAX_STEPS,
    ...(agents?.subAgentModel ? { modelId: agents.subAgentModel } : {}),
    ...defined(defaults),
    ...defined(
      named
        ? {
            providerId: named.providerId,
            modelId: named.modelId,
            systemPrompt: named.systemPrompt,
            toolNames: named.toolNames,
            timeoutMs: named.timeoutMs,
            maxSteps: named.maxSteps,
          }
        : {},
    ),
    ...defined(plan.agent),
  };
}

export async function executeScheduledTask(
  input: ScheduledTaskExecutorInput,
): Promise<ScheduledTaskExecutionResult> {
  const { api, plan, config } = input;
  const agent = resolveTaskAgentConfig(plan, config.taskAgentConfig, config.agentToolsConfig);
  const selection = config.resolveModel(agent.providerId, agent.modelId);
  agent.providerId = selection.providerId;
  agent.modelId = selection.modelId;
  await input.onAgentResolved?.(agent);
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(agent.timeoutMs!),
  ]);
  signal.throwIfAborted();
  const messageIds: number[] = [];
  const deliveries: string[] = [];
  const delivered = (id: number, text: string) => {
    messageIds.push(id);
    deliveries.push(text);
  };
  // Do not install unrestricted history, personal memory or local file tools in a task session.
  const toolsetConfig: TurnToolsetConfig = {
    ...config.toolsetConfig,
    memory: undefined,
    botMemory: undefined,
    dataFiles: undefined,
  };
  const destination = plan.destination;
  const imageGenerationActor = await resolveImageGenerationActor(toolsetConfig, {
    chatId: destination.chatId,
    isPrivate: destination.chatId > 0,
    userId: input.userId,
  });
  const toolset = await createTurnToolset({
    api,
    config: toolsetConfig,
    chatId: destination.chatId,
    threadId: destination.threadId,
    userId: input.userId,
    isPrivate: destination.chatId > 0,
    privacyMode: "normal",
    imageGenerationActor,
    signal,
    entry: { kind: "continue", timerDepth: 2 },
    interaction: {
      recentBotMessageIds: messageIds,
      onceGuard: createOnceGuard(),
      telegram: { onTextMessageSent: delivered },
      behavior: { moodState: new Map(), onMultiMessageSent: (text, id) => delivered(id, text) },
    },
  });
  try {
    const tools: Record<string, Tool> = {};
    const permitted = new Set(agent.toolNames);
    for (const [name, candidate] of Object.entries(toolset.tools)) {
      if (name !== "read_task_history" && permitted.has(name)) tools[name] = candidate;
    }
    if (plan.dataScope.kind === "chat" && permitted.has("read_task_history")) {
      const until = input.now ?? new Date();
      const since = new Date(until.getTime() - (plan.dataScope.lookbackHours ?? 24) * 3_600_000);
      tools.read_task_history = tool({
        description:
          "读取已批准任务范围内的聊天记录；范围、话题、起止时间和数量由计划固定，不能扩大。complete=false 表示记录不完整。",
        inputSchema: zodToAiSchema(z.object({})),
        execute: async () => {
          signal.throwIfAborted();
          return config.readTaskHistory({
            chatId: input.chatId,
            threadId: input.threadId,
            since,
            until,
            limit: plan.dataScope.maxMessages ?? 500,
          });
        },
      });
    }
    const result = await generateText({
      model: selection.model,
      system: agent.systemPrompt,
      messages: [
        {
          role: "user",
          content: `任务：${plan.name}\n执行内容：${plan.instructions}\n批准的数据范围：${JSON.stringify(plan.dataScope)}\n本次执行时间：${(input.now ?? new Date()).toISOString()}\n请完成任务并输出结果。`,
        },
      ],
      tools,
      stopWhen: stepCountIs(agent.maxSteps!),
      abortSignal: signal,
      prepareStep: toolset.prepareStep,
    });
    signal.throwIfAborted();
    const output = result.text;
    if (output.trim() && !isTextCoveredByDeliveries(output, deliveries)) {
      for (const chunk of splitMessage(output, 4096)) {
        signal.throwIfAborted();
        const sent = await sendMarkdownWithFallback(
          api,
          destination.chatId,
          chunk,
          isRichMessageEnabled(toolsetConfig.messageConfig),
          { message_thread_id: destination.threadId },
        );
        messageIds.push(sent.message.message_id);
      }
    }
    return {
      output,
      agent,
      messageIds: [...new Set(messageIds)],
      usage: {
        inputTokens: result.totalUsage.inputTokens ?? 0,
        outputTokens: result.totalUsage.outputTokens ?? 0,
        totalTokens: result.totalUsage.totalTokens ?? 0,
      },
    };
  } finally {
    await toolset.dispose?.();
  }
}

export interface ScheduledTaskBotInput extends Omit<ScheduledTaskExecutorInput, "config" | "api"> {
  api: Api | string;
  aiConfig: import("../index.js").AiReplyBotConfig;
  taskAgentConfig?: AgentExecutionConfig;
  agentToolsConfig?: AgentToolsConfig;
  adminIds?: number[];
  readTaskHistory: ScheduledTaskExecutorConfig["readTaskHistory"];
}

const TOPIC_METHODS = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendMessageDraft",
  "sendRichMessageDraft",
  "sendPhoto",
  "sendAudio",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendVoice",
  "sendVideoNote",
  "sendMediaGroup",
  "sendLocation",
  "sendVenue",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendSticker",
  "sendChatAction",
  "copyMessage",
  "copyMessages",
  "forwardMessage",
  "forwardMessages",
]);

export function bindTaskDestinationTopic(
  api: Api,
  destination: ScheduledTaskPlan["destination"],
): void {
  if (destination.threadId === undefined) return;
  api.config.use((previous, method, payload, signal) => {
    if (
      TOPIC_METHODS.has(method) &&
      "chat_id" in payload &&
      payload.chat_id === destination.chatId
    ) {
      return previous(method, { ...payload, message_thread_id: destination.threadId }, signal);
    }
    return previous(method, payload, signal);
  });
}

export async function executeScheduledTaskWithBotConfig(
  input: ScheduledTaskBotInput,
): Promise<ScheduledTaskExecutionResult> {
  const aiConfig = await capturePromptConfig(input.aiConfig);
  const api = typeof input.api === "string" ? new Api(input.api) : input.api;
  bindTaskDestinationTopic(api, input.plan.destination);
  const reservation = await aiConfig.usageGovernance?.reserve({
    botId: aiConfig.botId,
    resource: "ai_reply",
    chatKind: input.chatId > 0 ? "private" : "group",
    chatId: input.chatId,
  });
  if (reservation && !reservation.allowed)
    throw new Error(`Task usage denied: ${reservation.reason}`);
  let succeeded = false;
  const pendingAdminActions = new PendingAdminActionRegistry();
  try {
    const result = await executeScheduledTask({
      ...input,
      api,
      config: {
        taskAgentConfig: input.taskAgentConfig,
        agentToolsConfig: input.agentToolsConfig ?? aiConfig.agentToolsConfig,
        readTaskHistory: input.readTaskHistory,
        resolveModel(providerId, modelId) {
          const provider = aiConfig.providers?.find(
            (candidate) => candidate.id === (providerId ?? aiConfig.activeProviderId),
          );
          if (!provider) throw new Error("Task Agent provider is unavailable");
          const selectedModel = modelId ?? provider.defaultModel;
          const runtime = createAiSelectionRuntime({
            providers: [provider],
            activeProviderId: provider.id,
            activeModelId: selectedModel,
            legacy: {
              apiKey: provider.apiKey,
              baseURL: provider.baseURL,
              providerFormat: provider.providerFormat,
              model: provider.defaultModel,
            },
          });
          const selection = runtime.resolve();
          return {
            model: selection.providerFactory(selectedModel),
            providerId: provider.id,
            modelId: selectedModel,
          };
        },
        toolsetConfig: {
          ...aiConfig,
          adminIds: input.adminIds,
          pendingAdminActions,
          webTools: aiConfig.webToolsConfig?.enabled
            ? createWebTools({
                config: aiConfig.webToolsConfig,
                timeoutConfig: aiConfig.timeoutConfig,
              })
            : undefined,
        },
      },
    });
    succeeded = true;
    return result;
  } finally {
    await pendingAdminActions.destroyAndDrain();
    if (reservation?.allowed && aiConfig.usageGovernance) {
      const request = {
        reservationId: reservation.reservationId,
        botId: aiConfig.botId,
        resource: "ai_reply" as const,
      };
      if (succeeded) await aiConfig.usageGovernance.settle(request);
      else await aiConfig.usageGovernance.refund(request);
    }
  }
}
