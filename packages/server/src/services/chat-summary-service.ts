import type { Database } from "@cos-tool-bot/database";
import { summaryConfigs } from "@cos-tool-bot/database";
import type { SummaryMode } from "@cos-tool-bot/shared";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import { DEFAULT_COOLDOWN_SECONDS, DEFAULT_TIMEZONE } from "./summary-prompts.js";
import type { SummaryRunner } from "./summary-runner.js";

const CHECK_INTERVAL_MS = 60_000;

export type SendSummaryFn = (botId: string, chatId: number, html: string) => Promise<void>;

export type IsBotRunningFn = (botId: string) => boolean;

export interface BotSummaryCfg {
  enabled: boolean;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  timezone?: string;
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
    skipSend?: boolean;
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
            providerId: row.providerId,
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

    if (!opts.skipSend) {
      try {
        await this.send(opts.botId, opts.chatId, result.contentHtml!);
      } catch (err) {
        this.logger.warn(
          { err, botId: opts.botId, chatId: opts.chatId },
          "Failed to send manual summary",
        );
      }
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
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 3600_000);

    const candidates = await this.db
      .select()
      .from(summaryConfigs)
      .where(
        and(
          eq(summaryConfigs.isActive, true),
          isNotNull(summaryConfigs.scheduleHour),
          isNotNull(summaryConfigs.scheduleMinute),
          or(
            isNull(summaryConfigs.lastScheduledAt),
            lt(summaryConfigs.lastScheduledAt, twentyThreeHoursAgo),
          ),
        ),
      );

    // Resolve per-bot enabled flag + timezone once per tick to avoid N extra reads per row.
    const botCfgCache = new Map<string, BotSummaryCfg | null>();
    const getBotCfg = async (botId: string) => {
      if (botCfgCache.has(botId)) return botCfgCache.get(botId)!;
      const cfg = await this.getBotSummaryCfg(botId);
      botCfgCache.set(botId, cfg);
      return cfg;
    };

    for (const cfg of candidates) {
      if (!this.isBotRunning(cfg.botId)) continue;

      const botCfg = await getBotCfg(cfg.botId);
      // Respect the bot-level summaryConfig.enabled kill-switch in the scheduled path too.
      if (!botCfg?.enabled) continue;

      // scheduleHour/Minute are stored in the bot's configured timezone (default Asia/Shanghai),
      // not UTC, so users see/set wall-clock time consistent with other in-product timestamps.
      const tz = botCfg.timezone ?? DEFAULT_TIMEZONE;
      const { hour, minute } = hourMinuteInTz(now, tz);
      if (hour !== cfg.scheduleHour || minute !== cfg.scheduleMinute) continue;

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
          providerId: cfg.providerId,
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
    //     the bot-local H:M (via hourMinuteInTz), select chats with >=5 messages in 24h
    //     that lack a summary_configs row and haven't been scheduled-summarized in 23h,
    //     and trigger runner with default settings.
  }
}

function hourMinuteInTz(now: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { hour, minute };
}
