import type {
  HarnessAssistantRuntime,
  HarnessCallbackAnswer,
  HarnessCallbackRequest,
  HarnessCommandName,
  HarnessReply,
  HarnessTopicMessageRequest,
} from "@cos-tool-bot/bot";
import type { HarnessTopicSuggestion } from "@cos-tool-bot/database";
import { generateText, stepCountIs } from "ai";
import { KeyedAsyncLock } from "../services/keyed-async-lock.js";
import { historyMessages, systemPrompt } from "./assistant-prompt.js";
import { parseAssistantCallback, renderAssistantReply } from "./assistant-render.js";
import { SUGGESTABLE_COMMANDS, createAssistantTools } from "./assistant-tools.js";
import { errorText } from "./pr-actions.js";
import { formatDateTime } from "./render.js";
import type { HarnessService } from "./service.js";
import type { HarnessTopicMessageRecord } from "./topic-store.js";

export const ASSISTANT_LIMITS = {
  steps: 10,
  timeoutMs: 120_000,
  historyMessages: 30,
  historyChars: 16_000,
  userChars: 4_000,
  keepPerTopic: 200,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};

const SUGGESTABLE = new Set<string>(SUGGESTABLE_COMMANDS);
const PLACEHOLDER = "🔎 正在查…";
const TEXT = {
  failed: "助手这次没有答出来（超时或模型出错），请稍后再试，或直接使用命令。",
  cancelled: "对话已清空，这条消息没有处理。",
  empty: "这次没有得出结论，请把问题说得更具体一些。",
  missing: "按钮已失效",
  used: "这条建议已执行过",
};

/** Error kind and status only: provider messages may echo the prompt. */
function failureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? `${name} ${status}` : name;
}

/**
 * One conversation per (chat, thread): owner free text and the assistant's replies. Turns in a
 * topic run one at a time; `/new` bumps the topic's epoch so queued and running turns from
 * before the reset are dropped instead of leaking into the new conversation.
 */
export class HarnessTopicAssistant {
  private readonly lock = new KeyedAsyncLock();
  private readonly epochs = new Map<string, number>();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly service: HarnessService) {}

  private allowed(chatId: number, userId: number): boolean {
    return (
      this.service.active &&
      this.service.port.isHarnessChat(chatId) &&
      this.service.port.isOwner(userId)
    );
  }

  private repoFor(threadId: number | undefined): string | undefined {
    const key = this.service.projectKeyForThread(threadId);
    return key ? this.service.file.projects[key]?.repo : undefined;
  }

  async handleMessage(
    request: HarnessTopicMessageRequest,
    runtime: HarnessAssistantRuntime,
  ): Promise<void> {
    const telegram = this.service.telegram;
    if (!telegram || !this.allowed(request.chatId, request.userId)) return;
    const thread = request.threadId ?? 0;
    const key = `${request.chatId}:${thread}`;
    const epoch = this.epochs.get(key) ?? 0;
    const placeholder = await telegram
      .send(request.chatId, {
        html: PLACEHOLDER,
        threadId: request.threadId,
        replyToMessageId: request.messageId,
      })
      .catch(() => null);
    const show = async (html: string) => {
      if (placeholder) {
        await telegram
          .edit(request.chatId, placeholder.messageId, "text", { html })
          .catch(() => {});
      }
    };
    await this.lock.run(key, async () => {
      if ((this.epochs.get(key) ?? 0) !== epoch) return show(TEXT.cancelled);
      const controller = new AbortController();
      this.running.set(key, controller);
      try {
        await this.turn(request, runtime, { key, thread, epoch, controller, placeholder, show });
      } catch (error) {
        this.service.logger.warn(
          `Dev Harness assistant topic ${key} failed: ${failureKind(error)}`,
        );
        await show(controller.signal.aborted ? TEXT.cancelled : TEXT.failed);
      } finally {
        if (this.running.get(key) === controller) this.running.delete(key);
      }
    });
  }

  private async turn(
    request: HarnessTopicMessageRequest,
    runtime: HarnessAssistantRuntime,
    state: {
      key: string;
      thread: number;
      epoch: number;
      controller: AbortController;
      placeholder: { messageId: number } | null;
      show: (html: string) => Promise<void>;
    },
  ) {
    const { service } = this;
    const { store } = service;
    const text = request.text.slice(0, ASSISTANT_LIMITS.userChars);
    await store.appendTopicMessage({
      chatId: request.chatId,
      threadId: state.thread,
      role: "user",
      text,
      messageId: request.messageId,
    });
    const history = await store.listTopicMessages(
      request.chatId,
      state.thread,
      ASSISTANT_LIMITS.historyMessages,
    );
    const projectKey = service.projectKeyForThread(request.threadId);
    const repo = this.repoFor(request.threadId);
    const suggestions: HarnessTopicSuggestion[] = [];
    const started = Date.now();
    state.controller.signal.throwIfAborted();
    const result = await generateText({
      model: runtime.model,
      system: systemPrompt({
        project: projectKey && repo ? { key: projectKey, repo } : undefined,
        projects: service
          .projectKeys()
          .map((k) => ({ key: k, repo: service.file.projects[k]!.repo })),
        now: formatDateTime(service.now(), service.globalView().config.telegram.notify.timezone),
      }),
      messages: historyMessages(history, ASSISTANT_LIMITS.historyChars),
      tools: createAssistantTools({ service, fixedProject: projectKey, suggestions }),
      stopWhen: stepCountIs(ASSISTANT_LIMITS.steps),
      maxRetries: 1,
      abortSignal: AbortSignal.any([
        state.controller.signal,
        AbortSignal.timeout(ASSISTANT_LIMITS.timeoutMs),
      ]),
    });
    const durationMs = Date.now() - started;
    runtime.recordUsage?.({
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      totalTokens: result.totalUsage.totalTokens,
      durationMs,
    });
    if ((this.epochs.get(state.key) ?? 0) !== state.epoch) return state.show(TEXT.cancelled);
    const reply = result.text.trim() || (suggestions.length > 0 ? "" : TEXT.empty);
    const messageId = await this.deliver(request, state.placeholder, {
      text: reply,
      suggestions,
      usedMask: 0,
      repo,
    });
    await store.appendTopicMessage({
      chatId: request.chatId,
      threadId: state.thread,
      role: "assistant",
      text: reply,
      messageId,
      suggestions: suggestions.length > 0 ? suggestions : null,
    });
    await store.pruneTopicMessages({
      chatId: request.chatId,
      threadId: state.thread,
      keep: ASSISTANT_LIMITS.keepPerTopic,
      before: new Date(service.now().getTime() - ASSISTANT_LIMITS.retentionMs),
    });
    const tools = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    service.logger.info(
      `Dev Harness assistant topic ${state.key} replied in ${durationMs}ms · steps ${result.steps.length} · tools ${tools.join(",") || "none"} · history ${history.length} · in ${text.length} chars · out ${reply.length} chars · suggestions ${suggestions.length}`,
    );
  }

  /** Edits the placeholder into the first chunk; the keyboard rides on the last message. */
  private async deliver(
    request: HarnessTopicMessageRequest,
    placeholder: { messageId: number } | null,
    input: Parameters<typeof renderAssistantReply>[0],
  ): Promise<number> {
    const telegram = this.service.telegram!;
    const { chunks, keyboard } = renderAssistantReply(input);
    let lastId = 0;
    for (const [index, html] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const markup = isLast && keyboard.length > 0 ? keyboard : undefined;
      if (index === 0 && placeholder) {
        const edited = await telegram.edit(request.chatId, placeholder.messageId, "text", {
          html,
          keyboard: markup,
        });
        if (edited !== "missing") {
          lastId = placeholder.messageId;
          continue;
        }
      }
      const sent = await telegram.send(request.chatId, {
        html,
        keyboard: markup,
        threadId: request.threadId,
        replyToMessageId: index === 0 ? request.messageId : undefined,
      });
      lastId = sent.messageId;
    }
    return lastId;
  }

  /** `/new`: waits for the topic's running turn to abort, then drops the whole conversation. */
  async reset(chatId: number, threadId: number | undefined): Promise<HarnessReply> {
    const thread = threadId ?? 0;
    const key = `${chatId}:${thread}`;
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.running.get(key)?.abort();
    const removed = await this.lock.run(key, () => this.service.store.clearTopic(chatId, thread));
    this.service.logger.info(`Dev Harness assistant topic ${key} reset: ${removed} messages`);
    return {
      html:
        removed > 0
          ? "已清空本话题的助手对话，接下来的消息从新对话开始。"
          : "本话题还没有助手对话，直接发消息即可开始。",
    };
  }

  /** A suggestion button runs the same handler as the typed command, once per suggestion. */
  async handleCallback(request: HarnessCallbackRequest): Promise<HarnessCallbackAnswer> {
    const index = parseAssistantCallback(request.data);
    if (index === null) return { text: TEXT.missing };
    if (!this.allowed(request.chatId, request.userId)) return { text: "无权限" };
    const { service } = this;
    const row = await service.store.findTopicMessage(request.chatId, request.messageId);
    const suggestion = row?.role === "assistant" ? row.suggestions?.[index] : undefined;
    if (!row || !suggestion || !SUGGESTABLE.has(suggestion.command)) {
      return { text: TEXT.missing };
    }
    let threadId = request.threadId;
    if (suggestion.project) {
      if (!service.projectKeys().includes(suggestion.project))
        return { text: "该项目已不在配置中" };
      threadId = service.projectThread(suggestion.project);
      if (threadId === undefined) return { text: "该项目的话题尚未创建", alert: true };
    }
    if (!(await service.store.useTopicSuggestion(row.id, index))) return { text: TEXT.used };
    const sameTopic = threadId === request.threadId;
    let reply: HarnessReply;
    try {
      reply = await service.port.handleCommand({
        command: suggestion.command as HarnessCommandName,
        args: suggestion.args,
        chatId: request.chatId,
        threadId,
        userId: request.userId,
        messageId: sameTopic ? request.messageId : undefined,
      });
    } catch (error) {
      return { text: `执行失败：${errorText(error)}`, alert: true };
    }
    await this.sendCommandReply(
      request.chatId,
      threadId,
      reply,
      sameTopic ? request.messageId : undefined,
    );
    await this.markUsed(request, row);
    await service.recordEvent({
      type: "assistant.suggestion_run",
      projectKey: suggestion.project ?? service.projectKeyForThread(request.threadId) ?? null,
      actorId: request.userId,
      payload: { command: suggestion.command, argsLength: suggestion.args.length },
    });
    return { text: `已执行 /${suggestion.command}` };
  }

  private async sendCommandReply(
    chatId: number,
    threadId: number | undefined,
    reply: HarnessReply,
    replyToMessageId: number | undefined,
  ) {
    const telegram = this.service.telegram;
    if (!telegram) return;
    if (reply.document) {
      await telegram.sendDocument(chatId, { ...reply.document, caption: reply.html, threadId });
    } else if (reply.html) {
      await telegram.send(chatId, {
        html: reply.html,
        keyboard: reply.keyboard,
        threadId,
        replyToMessageId,
      });
    }
  }

  private async markUsed(request: HarnessCallbackRequest, row: HarnessTopicMessageRecord) {
    const fresh = await this.service.store.findTopicMessage(request.chatId, request.messageId);
    const { chunks, keyboard } = renderAssistantReply({
      text: row.text,
      suggestions: row.suggestions ?? [],
      usedMask: fresh?.suggestionsUsed ?? row.suggestionsUsed,
      repo: this.repoFor(request.threadId),
    });
    await this.service.telegram
      ?.edit(request.chatId, request.messageId, "text", { html: chunks.at(-1)!, keyboard })
      .catch(() => {});
  }
}
