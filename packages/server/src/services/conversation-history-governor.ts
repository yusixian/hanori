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

interface GovernanceFlightState {
  pending: boolean;
  options: ConversationHistoryGovernanceOptions;
}

interface GovernanceFlight {
  state: GovernanceFlightState;
  promise: Promise<HistoryLimitResult>;
}

export class ConversationHistoryGovernor {
  private warnedChats = new Set<string>();
  private flights = new Map<string, GovernanceFlight>();

  constructor(
    private store: ConversationStore,
    private logger: Pick<Logger, "warn">,
  ) {}

  run(options: ConversationHistoryGovernanceOptions): Promise<HistoryLimitResult> {
    const key = `${options.botId}:${options.chatId}`;
    const existing = this.flights.get(key);
    if (existing) {
      existing.state.pending = true;
      existing.state.options = options;
      return existing.promise;
    }

    const state: GovernanceFlightState = {
      pending: false,
      options,
    };
    const flight: GovernanceFlight = {
      state,
      promise: this.runFlight(state).finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      }),
    };
    this.flights.set(key, flight);
    return flight.promise;
  }

  private async runFlight(state: GovernanceFlightState): Promise<HistoryLimitResult> {
    while (true) {
      state.pending = false;
      try {
        const result = await this.runOnce(state.options);
        if (!state.pending) return result;
      } catch (error) {
        if (!state.pending) throw error;
      }
    }
  }

  private async runOnce(
    options: ConversationHistoryGovernanceOptions,
  ): Promise<HistoryLimitResult> {
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
