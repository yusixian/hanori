import type { Logger } from "pino";
import type { HistoryLimitResult } from "./conversation-store.js";
import type { ConversationStore } from "./conversation-store.js";

const HARD_LIMIT_SUMMARY_GRACE_MS = 15_000;

export interface ConversationHistoryGovernanceOptions {
  botId: string;
  chatId: number;
  maxRawMessagesPerChat: number;
  summaryGraceMs?: number;
  summarize: () => Promise<void>;
}

export class ConversationHistoryGovernor {
  private warnedChats = new Set<string>();

  constructor(
    private store: ConversationStore,
    private logger: Pick<Logger, "warn">,
  ) {}

  async run(options: ConversationHistoryGovernanceOptions): Promise<HistoryLimitResult> {
    const countBefore =
      options.maxRawMessagesPerChat > 0
        ? await this.store.getMessageCount(options.botId, options.chatId)
        : 0;
    const key = `${options.botId}:${options.chatId}`;
    const warningThreshold =
      options.maxRawMessagesPerChat > 0 ? Math.floor(options.maxRawMessagesPerChat * 0.8) : 0;
    if (warningThreshold > 0 && countBefore >= warningThreshold && !this.warnedChats.has(key)) {
      this.warnedChats.add(key);
      this.logger.warn(
        {
          botId: options.botId,
          chatId: options.chatId,
          limit: options.maxRawMessagesPerChat,
          count: countBefore,
          warningThreshold,
        },
        "Conversation history reached the warning threshold",
      );
    }
    const atHardLimit =
      options.maxRawMessagesPerChat > 0 && countBefore >= options.maxRawMessagesPerChat;
    const summarization = options.summarize().catch((error) => {
      this.logger.warn(
        { error, botId: options.botId, chatId: options.chatId },
        "Conversation summarization failed before history-limit enforcement",
      );
    });

    const summaryGraceMs = atHardLimit ? HARD_LIMIT_SUMMARY_GRACE_MS : options.summaryGraceMs;
    if (summaryGraceMs !== undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const gracePeriod = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), Math.max(0, summaryGraceMs));
        timeout.unref?.();
      });
      const outcome = await Promise.race([
        summarization.then(() => "summarized" as const),
        gracePeriod,
      ]);
      if (timeout) clearTimeout(timeout);
      if (outcome === "timeout") {
        this.logger.warn(
          { botId: options.botId, chatId: options.chatId, graceMs: summaryGraceMs, atHardLimit },
          "Conversation summarization grace period expired; continuing history governance",
        );
      }
    } else {
      await summarization;
    }

    const result = await this.store.enforceHistoryLimit(
      options.botId,
      options.chatId,
      options.maxRawMessagesPerChat,
    );

    if (result.prunedCount > 0) {
      this.warnedChats.add(key);
      this.logger.warn(
        {
          botId: options.botId,
          chatId: options.chatId,
          limit: result.limit,
          countBefore: result.countBefore,
          countAfter: result.countAfter,
          prunedCount: result.prunedCount,
        },
        "Conversation history hard limit enforced",
      );
    } else if (result.warning && !this.warnedChats.has(key)) {
      this.warnedChats.add(key);
      this.logger.warn(
        {
          botId: options.botId,
          chatId: options.chatId,
          limit: result.limit,
          count: result.countBefore,
          warningThreshold: result.warningThreshold,
        },
        "Conversation history reached the warning threshold",
      );
    } else if (!result.warning) {
      this.warnedChats.delete(key);
    }

    return result;
  }
}
