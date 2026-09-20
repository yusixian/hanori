import type { CosInsideTarget } from "@cos-tool-bot/shared";
import { GrammyError, type CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export const COS_INSIDE_MAX_BODY_LENGTH = 4_000;
export const COS_INSIDE_RATE_LIMIT = 5;
export const COS_INSIDE_RATE_WINDOW_MS = 60_000;
const COS_INSIDE_MAX_FAILURE_REASON_LENGTH = 200;

const USAGE = "用法：/cosinside <别名> [reply:<消息ID>] <正文>";
const NO_TARGETS = "尚未配置代发目标群。";
const CAPTION_UNSUPPORTED = "只支持纯文本代发，请不要把命令写在图片或文件的说明里。";

/** Relay outcome record. It carries identifiers and sizes only: the relayed text, and any
 *  excerpt of it, must never reach a Bot log or an audit row. */
export interface CosInsideAuditEntry {
  actorUserId: number;
  targetChatId: number;
  alias: string;
  bodyLength: number;
  hasReplyTarget: boolean;
  outcome: "succeeded" | "failed";
  failureReason?: string;
}

export interface CosInsideCommandConfig {
  targets: CosInsideTarget[];
  onAudit?: (entry: CosInsideAuditEntry) => void | Promise<void>;
  history?: CosInsideHistoryConfig;
  now?: () => number;
}

export interface CosInsideHistoryEntry {
  targetChatId: number;
  body: string;
  tgMessageId: number;
  actorUserId: number;
  actorName: string;
  replyToMessageId?: number;
}

export interface CosInsideHistoryFailure {
  actorUserId: number;
  targetChatId: number;
  alias: string;
  tgMessageId: number;
}

export interface CosInsideHistoryConfig {
  isEnabled(targetChatId: number): boolean;
  save(entry: CosInsideHistoryEntry): Promise<void>;
  onFailure?: (entry: CosInsideHistoryFailure) => void | Promise<void>;
}

export type CosInsideMutationRunner = <T>(
  targetChatId: number,
  actorUserId: number,
  operation: () => Promise<T>,
) => Promise<T>;

export type CosInsideRequest =
  | { kind: "usage" }
  | { kind: "unknown_alias" }
  | { kind: "too_long"; length: number }
  | { kind: "ok"; alias: string; body: string; replyToMessageId?: number };

/** Resolves the target alias and the body. The alias may be omitted only when a single
 *  target is configured; a chat ID is never accepted from the command text. */
export function parseCosInsideRequest(raw: string, aliases: string[]): CosInsideRequest {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "usage" };

  const separator = trimmed.search(/\s/);
  const head = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const matched = aliases.find((alias) => alias.toLowerCase() === head.toLowerCase());

  let alias: string;
  let rest: string;
  if (matched !== undefined) {
    alias = matched;
    rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  } else if (aliases.length === 1) {
    alias = aliases[0]!;
    rest = trimmed;
  } else {
    return { kind: "unknown_alias" };
  }

  let replyToMessageId: number | undefined;
  const reply = /^reply:(\d{1,15})(?:\s|$)/.exec(rest);
  if (reply) {
    const messageId = Number(reply[1]);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return { kind: "usage" };
    replyToMessageId = messageId;
    rest = rest.slice(reply[0].length).trim();
  }

  if (!rest) return { kind: "usage" };
  if (rest.length > COS_INSIDE_MAX_BODY_LENGTH) return { kind: "too_long", length: rest.length };
  return {
    kind: "ok",
    alias,
    body: rest,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };
}

function createRateLimiter(now: () => number) {
  const attempts = new Map<number, number[]>();
  return (userId: number): boolean => {
    const current = now();
    const recent = (attempts.get(userId) ?? []).filter(
      (at) => current - at < COS_INSIDE_RATE_WINDOW_MS,
    );
    if (recent.length >= COS_INSIDE_RATE_LIMIT) {
      attempts.set(userId, recent);
      return false;
    }
    recent.push(current);
    attempts.set(userId, recent);
    return true;
  };
}

function describeFailure(error: unknown): string {
  const description =
    error instanceof GrammyError
      ? error.description
      : error instanceof Error
        ? error.message
        : String(error);
  return description.slice(0, COS_INSIDE_MAX_FAILURE_REASON_LENGTH);
}

function getActorName(from: WrapperContext["from"]): string {
  if (!from) return "Unknown";
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return fullName || from.username || "Unknown";
}

export function createCosInsideCommand(
  config: CosInsideCommandConfig,
  runMutation?: CosInsideMutationRunner,
): CommandMiddleware<WrapperContext> {
  const allowAttempt = createRateLimiter(config.now ?? (() => Date.now()));
  const record = async (entry: CosInsideAuditEntry) => {
    await Promise.resolve()
      .then(() => config.onAudit?.(entry))
      .catch(() => {});
  };

  return async (ctx) => {
    const actorUserId = ctx.from?.id;
    if (actorUserId === undefined) return;

    const aliases = config.targets.map((target) => target.alias);
    if (aliases.length === 0) {
      await ctx.reply(NO_TARGETS);
      return;
    }

    // grammY also matches a command in a media caption. Relaying only the caption would
    // drop the attachment while still reporting success.
    if (ctx.message?.text === undefined) {
      await ctx.reply(CAPTION_UNSUPPORTED);
      return;
    }

    const request = parseCosInsideRequest(ctx.match?.toString() ?? "", aliases);
    if (request.kind === "usage") {
      await ctx.reply(USAGE);
      return;
    }
    if (request.kind === "unknown_alias") {
      await ctx.reply(`未知目标别名。已配置：${aliases.join("、")}`);
      return;
    }
    if (request.kind === "too_long") {
      await ctx.reply(
        `正文超过 ${COS_INSIDE_MAX_BODY_LENGTH} 字符上限，当前 ${request.length} 字符。`,
      );
      return;
    }
    if (!allowAttempt(actorUserId)) {
      await ctx.reply(
        `代发过于频繁，每 ${COS_INSIDE_RATE_WINDOW_MS / 1_000} 秒最多 ${COS_INSIDE_RATE_LIMIT} 条。`,
      );
      return;
    }

    const target = config.targets.find(({ alias }) => alias === request.alias)!;
    const audit = {
      actorUserId,
      targetChatId: target.chatId,
      alias: target.alias,
      bodyLength: request.body.length,
      hasReplyTarget: request.replyToMessageId !== undefined,
    } as const;

    const state: {
      sentMessageId?: number;
      historyOutcome: "saved" | "skipped" | "failed";
    } = { historyOutcome: "skipped" };
    let historyFailureReported = false;
    const reportHistoryFailure = async () => {
      const messageId = state.sentMessageId;
      if (messageId === undefined || historyFailureReported) return;
      historyFailureReported = true;
      await Promise.resolve()
        .then(() =>
          config.history?.onFailure?.({
            actorUserId,
            targetChatId: target.chatId,
            alias: target.alias,
            tgMessageId: messageId,
          }),
        )
        .catch(() => {});
    };
    const relay = async () => {
      const sent = await ctx.api.sendMessage(
        target.chatId,
        request.body,
        request.replyToMessageId === undefined
          ? undefined
          : { reply_parameters: { message_id: request.replyToMessageId } },
      );
      state.sentMessageId = sent.message_id;

      if (!config.history?.isEnabled(target.chatId)) return;
      try {
        await config.history.save({
          targetChatId: target.chatId,
          body: request.body,
          tgMessageId: sent.message_id,
          actorUserId,
          actorName: getActorName(ctx.from),
          ...(request.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: request.replyToMessageId }),
        });
        state.historyOutcome = "saved";
      } catch {
        state.historyOutcome = "failed";
        await reportHistoryFailure();
      }
    };

    try {
      if (runMutation) await runMutation(target.chatId, actorUserId, relay);
      else await relay();
    } catch (error) {
      if (state.sentMessageId !== undefined) {
        state.historyOutcome = "failed";
        await reportHistoryFailure();
        await record({ ...audit, outcome: "succeeded" });
        await ctx.reply(`已代发至 ${target.alias}，但保存到对话历史失败；消息不会重复发送。`);
        return;
      }
      const failureReason = describeFailure(error);
      await record({ ...audit, outcome: "failed", failureReason });
      await ctx.reply(`代发失败：${failureReason}`);
      return;
    }

    await record({ ...audit, outcome: "succeeded" });
    if (state.historyOutcome === "failed") {
      await ctx.reply(`已代发至 ${target.alias}，但保存到对话历史失败；消息不会重复发送。`);
    } else if (state.historyOutcome === "skipped") {
      await ctx.reply(`已代发至 ${target.alias}，但该群的对话历史未启用，未保存至上下文。`);
    } else {
      await ctx.reply(`已代发至 ${target.alias}。`);
    }
  };
}
