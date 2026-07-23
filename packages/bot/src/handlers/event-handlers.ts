import type { Api } from "grammy";
import type { PollAnswer } from "grammy/types";
import type { PendingActionRegistry } from "../services/pending-actions.js";
import type { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import type { ContinueChatConfig } from "../services/continue-chat.js";
import { continueChat } from "../services/continue-chat.js";

// Debounce durations
const PRIVATE_DEBOUNCE_MS = 500;
const GROUP_DEBOUNCE_MS = 5000;

export interface PollAnswerHandlerOptions {
  api: Api;
  pendingActions: PendingActionRegistry;
  getContinueChatConfig: (chatId?: number) => ContinueChatConfig;
  isPrivateChat: (chatId: number) => boolean;
}

export function createPollAnswerHandler(options: PollAnswerHandlerOptions) {
  const { api, pendingActions, getContinueChatConfig, isPrivateChat } = options;

  return async (pollAnswer: PollAnswer) => {
    const poll = pendingActions.getPoll(pollAnswer.poll_id);
    if (!poll) return; // Not our poll
    if (!pollAnswer.user) return; // Anonymous poll (shouldn't happen for tracked polls)

    const userId = pollAnswer.user.id;
    const userName =
      pollAnswer.user.first_name +
      (pollAnswer.user.last_name ? ` ${pollAnswer.user.last_name}` : "");

    // Update answers map
    if (pollAnswer.option_ids.length === 0) {
      // User retracted their vote
      poll.answers.delete(userId);
    } else {
      poll.answers.set(userId, { userId, userName, optionIds: pollAnswer.option_ids });
    }

    // Debounce: clear previous timer and set new one
    if (poll.debounceTimer) clearTimeout(poll.debounceTimer);

    const debounceMs = isPrivateChat(poll.chatId) ? PRIVATE_DEBOUNCE_MS : GROUP_DEBOUNCE_MS;

    poll.debounceTimer = setTimeout(async () => {
      // Build event description
      const answerLines: string[] = [];
      for (const answer of poll.answers.values()) {
        const chosen = answer.optionIds.map((i) => poll.options[i] ?? `选项${i}`).join(", ");
        answerLines.push(`- ${answer.userName} 选择了: ${chosen}`);
      }

      const eventDescription = [
        `投票「${poll.question}」收到了 ${poll.answers.size} 票:`,
        `选项: ${poll.options.map((o, i) => `${i + 1}. ${o}`).join(", ")}`,
        ...answerLines,
        "请根据投票结果继续对话。",
      ].join("\n");

      try {
        await continueChat(api, getContinueChatConfig(poll.chatId), {
          chatId: poll.chatId,
          eventDescription,
          userId: poll.ownerUserId ?? userId,
        });
      } catch {
        // logged inside continueChat
      }
    }, debounceMs);
  };
}

export interface CallbackQueryHandlerOptions {
  api: Api;
  pendingActions: PendingActionRegistry;
  getContinueChatConfig: (chatId?: number) => ContinueChatConfig;
}

export function createCallbackQueryHandler(options: CallbackQueryHandlerOptions) {
  const { api, pendingActions, getContinueChatConfig } = options;

  return async (ctx: {
    callbackQuery: {
      id: string;
      data?: string;
      from: { id: number; first_name: string; last_name?: string };
      message?: { chat: { id: number }; message_id: number };
    };
  }) => {
    const data = ctx.callbackQuery.data;
    if (!data?.startsWith("cos:c:")) return;

    const parts = data.split(":");
    if (parts.length !== 4) return;

    const choiceId = parts[2]!;
    const optionIndex = Number.parseInt(parts[3]!, 10);
    if (Number.isNaN(optionIndex)) return;

    const choice = pendingActions.getChoice(choiceId);
    if (!choice || choice.resolved) {
      await api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "该选择已过期",
      });
      return;
    }

    // Check target user restriction
    if (choice.targetUserId && ctx.callbackQuery.from.id !== choice.targetUserId) {
      await api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "这个选择不是给你的哦",
        show_alert: true,
      });
      return;
    }

    choice.resolved = true;
    const selectedOption = choice.options[optionIndex] ?? `选项${optionIndex}`;

    // Answer callback query
    await api.raw.answerCallbackQuery({
      callback_query_id: ctx.callbackQuery.id,
      text: `你选择了: ${selectedOption}`,
    });

    // Edit message to remove inline keyboard and show result
    if (ctx.callbackQuery.message) {
      try {
        await api.editMessageText(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          `${choice.prompt}\n\n> 已选择: ${selectedOption}`,
        );
      } catch {
        // ignore edit errors (message may have been deleted)
      }
    }

    pendingActions.removeChoice(choiceId);

    const userName =
      ctx.callbackQuery.from.first_name +
      (ctx.callbackQuery.from.last_name ? ` ${ctx.callbackQuery.from.last_name}` : "");

    const eventDescription = [
      `用户 ${userName} 在选择「${choice.prompt}」中选择了: ${selectedOption}`,
      `所有选项: ${choice.options.join(", ")}`,
      "请根据用户的选择继续对话。",
    ].join("\n");

    try {
      await continueChat(api, getContinueChatConfig(choice.chatId), {
        chatId: choice.chatId,
        eventDescription,
        userId: ctx.callbackQuery.from.id,
        userName,
      });
    } catch {
      // logged inside continueChat
    }
  };
}

export interface GitHubCallbackQueryHandlerOptions {
  api: Api;
  pendingActions: PendingGitHubActionRegistry;
  adminIds: readonly number[];
}

export function createGitHubCallbackQueryHandler(options: GitHubCallbackQueryHandlerOptions) {
  return async (ctx: {
    callbackQuery: {
      id: string;
      data?: string;
      from: { id: number };
      message?: { chat: { id: number }; message_id: number; text?: string };
    };
  }): Promise<boolean> => {
    const data = ctx.callbackQuery.data;
    if (!data?.startsWith("cos:gh:")) return false;
    const [, , actionId, decision] = data.split(":");
    if (!actionId || (decision !== "yes" && decision !== "no")) return true;

    const action = options.pendingActions.get(actionId);
    const callbackChatId = ctx.callbackQuery.message?.chat.id;
    if (!action) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "该 GitHub 请求已过期或已处理",
        show_alert: true,
      });
      return true;
    }
    if (
      !options.adminIds.includes(ctx.callbackQuery.from.id) ||
      action.userId !== ctx.callbackQuery.from.id ||
      action.chatId !== callbackChatId
    ) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "只有发起该请求的管理员可以确认",
        show_alert: true,
      });
      return true;
    }

    options.pendingActions.take(actionId);
    if (decision === "no") {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "已取消",
      });
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            action.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 GitHub 管理员确认\n\n${action.description}\n\n❌ 已取消`,
          )
          .catch(() => {});
      }
      return true;
    }

    await options.api.raw.answerCallbackQuery({
      callback_query_id: ctx.callbackQuery.id,
      text: "正在执行 GitHub 操作",
    });
    try {
      const result = await options.pendingActions.run(action);
      const url = result.url ? `\n${result.url}` : "";
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            action.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 GitHub 管理员确认\n\n${action.description}\n\n✅ ${result.summary}${url}`,
          )
          .catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            action.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 GitHub 管理员确认\n\n${action.description}\n\n❌ 执行失败：${message}`,
          )
          .catch(() => {});
      }
    }
    return true;
  };
}
