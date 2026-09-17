import type { Api } from "grammy";
import type { PollAnswer } from "grammy/types";
import type { PendingActionRegistry } from "../services/pending-actions.js";
import type { PendingAdminActionRegistry } from "../services/pending-github-actions.js";
import type { ContinueChatConfig } from "../services/continue-chat.js";
import { ContinuationNotDeliveredError, continueChat } from "../services/continue-chat.js";
import { AiRunCancelledError } from "../services/ai-execution-coordinator.js";

// Debounce durations
const PRIVATE_DEBOUNCE_MS = 500;
const GROUP_DEBOUNCE_MS = 5000;

function isExpectedContinuationCancellation(error: unknown): boolean {
  if (error instanceof AiRunCancelledError) return true;
  if (!(error instanceof ContinuationNotDeliveredError)) return false;
  return (
    error.reason === "ai_disabled" ||
    error.reason === "privacy_off" ||
    error.reason === "execution_cancelled"
  );
}

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

    const continuationConfig = getContinueChatConfig(choice.chatId);
    choice.resolved = true;
    const selectedOption = choice.options[optionIndex] ?? `选项${optionIndex}`;

    // Telegram acknowledgement is best-effort. The choice has already been claimed, so a stale
    // callback query must not prevent the durable continuation from running.
    try {
      await api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: `你选择了: ${selectedOption}`,
      });
    } catch (error) {
      continuationConfig.onLog?.({
        level: "warn",
        message: "Failed to acknowledge send_choice callback",
        meta: {
          chatId: choice.chatId,
          userId: ctx.callbackQuery.from.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // Edit message to remove inline keyboard and show result
    if (ctx.callbackQuery.message) {
      try {
        await api.editMessageText(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          `${choice.prompt}\n\n> 已选择: ${selectedOption}`,
        );
      } catch (error) {
        continuationConfig.onLog?.({
          level: "warn",
          message: "Failed to update resolved send_choice message",
          meta: {
            chatId: choice.chatId,
            userId: ctx.callbackQuery.from.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
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
      const delivered = await continueChat(api, continuationConfig, {
        chatId: choice.chatId,
        eventDescription,
        userId: ctx.callbackQuery.from.id,
        userName,
        requireDelivery: true,
        failureMessage: `已记录你的选择「${selectedOption}」，但暂时无法继续处理，请稍后再试。`,
      });
      if (!delivered) {
        continuationConfig.onLog?.({
          level: "warn",
          message: "send_choice continuation completed without delivery",
          meta: { chatId: choice.chatId, userId: ctx.callbackQuery.from.id },
        });
      }
    } catch (error) {
      const cancelled = isExpectedContinuationCancellation(error);
      continuationConfig.onLog?.({
        level: cancelled ? "info" : "error",
        message: cancelled
          ? "send_choice continuation cancelled"
          : "send_choice continuation failed",
        meta: {
          chatId: choice.chatId,
          userId: ctx.callbackQuery.from.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}

export interface AdminActionCallbackQueryHandlerOptions {
  api: Api;
  pendingActions: PendingAdminActionRegistry;
  adminIds: readonly number[];
}

export function createAdminActionCallbackQueryHandler(
  options: AdminActionCallbackQueryHandlerOptions,
) {
  return async (ctx: {
    callbackQuery: {
      id: string;
      data?: string;
      from: { id: number };
      message?: { chat: { id: number }; message_id: number; text?: string };
    };
  }): Promise<boolean> => {
    const data = ctx.callbackQuery.data;
    if (!data?.startsWith("cos:gh:") && !data?.startsWith("cos:rss:")) return false;
    const [, namespace, actionId, decision] = data.split(":");
    if (!actionId || (decision !== "yes" && decision !== "no")) return true;

    const action = options.pendingActions.get(actionId);
    const callbackChatId = ctx.callbackQuery.message?.chat.id;
    const kindMatches =
      action &&
      ((namespace === "gh" && action.kind === "github") ||
        (namespace === "rss" && action.kind.startsWith("rss:")));
    if (!action || !kindMatches) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "该管理员请求已过期或已处理",
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

    const claimedAction = options.pendingActions.take(actionId);
    if (!claimedAction) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "该管理员请求已过期或已处理",
        show_alert: true,
      });
      return true;
    }
    const isGitHub = claimedAction.kind === "github";
    const title = isGitHub ? "GitHub 管理员确认" : "RSS 管理员确认";
    if (decision === "no") {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: ctx.callbackQuery.id,
        text: "已取消",
      });
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            claimedAction.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 ${title}\n\n${claimedAction.description}\n\n❌ 已取消`,
          )
          .catch(() => {});
      }
      return true;
    }

    await options.api.raw.answerCallbackQuery({
      callback_query_id: ctx.callbackQuery.id,
      text: isGitHub ? "正在执行 GitHub 操作" : "正在执行 RSS 操作",
    });
    try {
      const result = await options.pendingActions.run(claimedAction);
      const url = isGitHub && result.url ? `\n${result.url}` : "";
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            claimedAction.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 ${title}\n\n${claimedAction.description}\n\n✅ ${result.summary}${url}`,
          )
          .catch(() => {});
      }
    } catch (error) {
      const message = isGitHub
        ? error instanceof Error
          ? error.message
          : String(error)
        : "执行失败，请稍后重试";
      if (ctx.callbackQuery.message) {
        await options.api
          .editMessageText(
            claimedAction.chatId,
            ctx.callbackQuery.message.message_id,
            `🔐 ${title}\n\n${claimedAction.description}\n\n❌ 执行失败：${message}`,
          )
          .catch(() => {});
      }
    }
    return true;
  };
}

export const createGitHubCallbackQueryHandler = createAdminActionCallbackQueryHandler;
export type GitHubCallbackQueryHandlerOptions = AdminActionCallbackQueryHandlerOptions;
