import type { Database } from "@cos-tool-bot/database";
import { summaryConfigs } from "@cos-tool-bot/database";
import type { SummaryMode } from "@cos-tool-bot/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import { DEFAULT_COOLDOWN_SECONDS } from "./summary-prompts.js";
import type { SummaryRunner } from "./summary-runner.js";

const CHECK_INTERVAL_MS = 60_000;

export type SendSummaryFn = (botId: string, chatId: number, html: string) => Promise<void>;

export type IsBotRunningFn = (botId: string) => boolean;

export interface BotSummaryCfg {
  enabled: boolean;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
}

export type BotSummaryCfgAccessor = (botId: string) => Promise<BotSummaryCfg | null>;

export type ManualReason =
  | "cooldown"
  | "disabled"
  | "no_access"
  | "too_few_messages"
  | "llm_failed"
  | "no_provider";

export interface TriggerManualResult {
  ok: boolean;
  reason?: ManualReason;
  summaryId?: number;
  contentHtml?: string;
}

export class ChatSummaryService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private logger: Logger,
    private runner: SummaryRunner,
    private send: SendSummaryFn,
    private isBotRunning: IsBotRunningFn,
    private getBotSummaryCfg: BotSummaryCfgAccessor,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
    this.logger.info("ChatSummaryService started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("ChatSummaryService stopped");
  }

  async triggerManual(opts: {
    botId: string;
    chatId: number;
    userId: number;
    mode: SummaryMode;
    bypassCooldown?: boolean;
  }): Promise<TriggerManualResult> {
    if (!this.isBotRunning(opts.botId)) {
      return { ok: false, reason: "disabled" };
    }
    const cfg = await this.getBotSummaryCfg(opts.botId);
    if (!cfg?.enabled) {
      return { ok: false, reason: "disabled" };
    }

    const [row] = await this.db
      .select()
      .from(summaryConfigs)
      .where(and(eq(summaryConfigs.botId, opts.botId), eq(summaryConfigs.chatId, opts.chatId)));

    // Cooldown check (bypassable for panel admin button)
    if (!opts.bypassCooldown && row) {
      const cooldownSeconds = row.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      if (row.lastManualAt) {
        const elapsed = Date.now() - row.lastManualAt.getTime();
        if (elapsed < cooldownSeconds * 1000) {
          return { ok: false, reason: "cooldown" };
        }
      }
    }

    // Mark manual timestamp before run (race protection)
    if (row) {
      await this.db
        .update(summaryConfigs)
        .set({ lastManualAt: new Date() })
        .where(eq(summaryConfigs.id, row.id));
    }

    const result = await this.runner.run({
      botId: opts.botId,
      chatId: opts.chatId,
      mode: opts.mode,
      trigger: "manual",
      triggeredBy: opts.userId,
      configOverrides: row
        ? {
            customPrompt: row.customPrompt,
            modelId: row.modelId,
            maxMessages: row.maxMessages,
          }
        : undefined,
    });

    if (!result.ok) {
      return {
        ok: false,
        reason: (result.error as ManualReason) ?? "llm_failed",
        summaryId: result.summaryId,
      };
    }

    try {
      await this.send(opts.botId, opts.chatId, result.contentHtml!);
    } catch (err) {
      this.logger.warn(
        { err, botId: opts.botId, chatId: opts.chatId },
        "Failed to send manual summary",
      );
    }
    return { ok: true, summaryId: result.summaryId, contentHtml: result.contentHtml };
  }

  private async tick(): Promise<void> {
    try {
      await this.processScheduledConfigs();
      await this.processGlobalFallbacks();
    } catch (err) {
      this.logger.error({ err }, "ChatSummaryService tick failed");
    }
  }

  private async processScheduledConfigs(): Promise<void> {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000);

    const candidates = await this.db
      .select()
      .from(summaryConfigs)
      .where(
        and(
          eq(summaryConfigs.isActive, true),
          eq(summaryConfigs.scheduleHour, hour),
          eq(summaryConfigs.scheduleMinute, minute),
          or(
            isNull(summaryConfigs.lastScheduledAt),
            lt(summaryConfigs.lastScheduledAt, twentyThreeHoursAgo),
          ),
        ),
      );

    for (const cfg of candidates) {
      if (!this.isBotRunning(cfg.botId)) continue;

      // Optimistic lock: only proceed if the row is still stale.
      const updated = await this.db
        .update(summaryConfigs)
        .set({ lastScheduledAt: now })
        .where(
          and(
            eq(summaryConfigs.id, cfg.id),
            or(
              isNull(summaryConfigs.lastScheduledAt),
              lt(summaryConfigs.lastScheduledAt, twentyThreeHoursAgo),
            ),
          ),
        )
        .returning({ id: summaryConfigs.id });

      if (updated.length === 0) continue; // another instance already took it

      const result = await this.runner.run({
        botId: cfg.botId,
        chatId: cfg.chatId,
        mode: { kind: "hours", hours: cfg.windowHours },
        trigger: "scheduled",
        configOverrides: {
          customPrompt: cfg.customPrompt,
          modelId: cfg.modelId,
          maxMessages: cfg.maxMessages,
        },
      });

      if (result.ok && result.contentHtml) {
        try {
          await this.send(cfg.botId, cfg.chatId, result.contentHtml);
        } catch (err) {
          this.logger.warn(
            { err, botId: cfg.botId, chatId: cfg.chatId },
            "Failed to send scheduled summary",
          );
        }
      } else {
        this.logger.info(
          { botId: cfg.botId, chatId: cfg.chatId, error: result.error },
          "Scheduled summary skipped",
        );
      }
    }
  }

  private async processGlobalFallbacks(): Promise<void> {
    // v1: Not implemented. per-chat configs only (see processScheduledConfigs).
    // v2: iterate bots with aiConfig.summaryConfig.globalScheduleHour/Minute matching
    //     current UTC H:M, select chats with >=5 messages in 24h that lack a
    //     summary_configs row and haven't been scheduled-summarized in 23h, and
    //     trigger runner with default settings.
  }
}
