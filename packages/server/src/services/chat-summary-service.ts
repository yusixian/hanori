import { InFlightTasks } from "../utils/in-flight-tasks.js";
import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  telegramChats,
  conversationMessages,
  chatSummaries,
  globalSummaryScheduleClaims,
  summaryConfigs,
} from "@cos-tool-bot/database";
import type {
  SummaryMode,
  SummaryRequest,
  SummaryToolResult,
  HistoryCoverage,
} from "@cos-tool-bot/shared";
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_TIMEZONE,
  DEFAULT_ROLE_FILTER,
  MIN_MESSAGES_FOR_SUMMARY,
  MAX_COUNT,
  MAX_HOURS,
} from "./summary-prompts.js";
import type { SummaryRunner } from "./summary-runner.js";

const CHECK_INTERVAL_MS = 60_000;

export type SendSummaryFn = (botId: string, chatId: number, html: string) => Promise<void>;

export type IsBotRunningFn = (botId: string) => boolean;

export interface BotSummaryCfg {
  enabled: boolean;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  timezone?: string;
  roleFilter?: ("user" | "context" | "assistant")[];
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
  contentRaw?: string;
  messageCount?: number;
  coverage?: HistoryCoverage;
}

interface ManualSummaryOptions {
  botId: string;
  chatId: number;
  userId: number;
  mode: SummaryMode;
  signal?: AbortSignal;
  bypassCooldown?: boolean;
  threadId?: number | null;
  instructions?: string;
  window?: { since: Date; until: Date; limit: number };
  originalMessagesOnly?: boolean;
  independentExecution?: boolean;
  maxMessages?: number;
  owner?: boolean;
  skipSend?: boolean;
  deliver?: (html: string) => Promise<void>;
}

export class ChatSummaryService {
  private closing = false;
  private closeTask?: Promise<void>;
  private readonly tasks = new InFlightTasks();
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
    if (this.closing || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.closing) return this.tasks.track(this.tick());
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

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.stop();
    this.closeTask = this.tasks.drain();
    return this.closeTask;
  }

  triggerManual(opts: ManualSummaryOptions): Promise<TriggerManualResult> {
    if (this.closing) return Promise.resolve({ ok: false, reason: "disabled" });
    return this.tasks.track(this.triggerManualImpl(opts));
  }

  /** No delivery side effect. The caller binds the actor and current chat, never the model. */
  async summarize(opts: {
    botId: string;
    chatId: number;
    threadId?: number | null;
    userId: number;
    request: SummaryRequest;
    signal?: AbortSignal;
    owner?: boolean;
    originalMessagesOnly?: boolean;
    approvedWindow?: { since: Date; until: Date; limit: number };
  }): Promise<SummaryToolResult> {
    const request = opts.request;
    if (
      request.maxMessages !== undefined &&
      (!Number.isInteger(request.maxMessages) ||
        request.maxMessages < 1 ||
        request.maxMessages > MAX_COUNT)
    )
      return { ok: false, reason: "invalid_range" };
    if ((request.since || request.until) && request.mode)
      return { ok: false, reason: "ambiguous_range" };
    let window = opts.approvedWindow;
    if (window && (request.since || request.until || request.mode))
      return { ok: false, reason: "outside_approved_scope" };
    if (!window && (request.since || request.until)) {
      const since = new Date(request.since ?? ""),
        until = new Date(request.until ?? "");
      if (
        !Number.isFinite(since.getTime()) ||
        !Number.isFinite(until.getTime()) ||
        since >= until ||
        until.getTime() - since.getTime() > MAX_HOURS * 3600_000 ||
        until.getTime() > Date.now()
      )
        return { ok: false, reason: "invalid_time_range" };
      window = { since, until, limit: MAX_COUNT };
    }
    const mode = request.mode ?? { kind: "default" };
    if (
      (mode.kind === "hours" &&
        (!Number.isInteger(mode.hours) || mode.hours < 1 || mode.hours > MAX_HOURS)) ||
      (mode.kind === "recent" &&
        (!Number.isInteger(mode.count) || mode.count < 1 || mode.count > MAX_COUNT))
    )
      return { ok: false, reason: "invalid_range" };
    const [bot] = await this.db
      .select({ adminChatIds: bots.adminChatIds })
      .from(bots)
      .where(eq(bots.id, opts.botId));
    const result = await this.triggerManual({
      botId: opts.botId,
      chatId: opts.chatId,
      threadId: opts.threadId,
      userId: opts.userId,
      mode,
      window,
      instructions: request.instructions,
      originalMessagesOnly: !!opts.approvedWindow || opts.originalMessagesOnly,
      maxMessages: request.maxMessages,
      independentExecution: !!opts.approvedWindow || opts.owner,
      bypassCooldown:
        !!opts.approvedWindow || opts.owner || bot?.adminChatIds.includes(opts.userId) === true,
      owner: !!opts.approvedWindow || opts.owner,
      skipSend: true,
      signal: opts.signal,
    });
    return {
      ok: result.ok,
      reason: result.reason,
      summaryId: result.summaryId,
      contentRaw: result.contentRaw,
      messageCount: result.messageCount,
      coverage: result.coverage,
    };
  }

  private async triggerManualImpl(opts: ManualSummaryOptions): Promise<TriggerManualResult> {
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

    if (row?.accessMode === "admin" && !opts.owner) {
      const [bot] = await this.db
        .select({ adminChatIds: bots.adminChatIds })
        .from(bots)
        .where(eq(bots.id, opts.botId));
      if (!bot?.adminChatIds.includes(opts.userId)) return { ok: false, reason: "no_access" };
    }

    // Atomically claim the manual cooldown before running. The initial read supplies
    // per-chat overrides, but only this conditional update decides who may proceed.
    if (!opts.independentExecution && !opts.bypassCooldown && row) {
      const cooldownSeconds = row.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      const claimed = await this.db
        .update(summaryConfigs)
        .set({ lastManualAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(summaryConfigs.botId, opts.botId),
            eq(summaryConfigs.chatId, opts.chatId),
            eq(summaryConfigs.id, row.id),
            or(
              isNull(summaryConfigs.lastManualAt),
              lte(
                summaryConfigs.lastManualAt,
                sql`CURRENT_TIMESTAMP - ${cooldownSeconds} * INTERVAL '1 second'`,
              ),
            ),
          ),
        )
        .returning({ id: summaryConfigs.id });
      if (claimed.length === 0) {
        return { ok: false, reason: "cooldown" };
      }
    } else if (!opts.independentExecution && opts.bypassCooldown && row) {
      await this.db
        .update(summaryConfigs)
        .set({ lastManualAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(summaryConfigs.botId, opts.botId),
            eq(summaryConfigs.chatId, opts.chatId),
            eq(summaryConfigs.id, row.id),
          ),
        );
    }

    const result = await this.runner.run({
      botId: opts.botId,
      chatId: opts.chatId,
      mode: opts.mode,
      signal: opts.signal,
      threadId: opts.threadId,
      window: opts.window,
      instructions: opts.instructions,
      originalMessagesOnly: opts.originalMessagesOnly,
      maxMessages: opts.maxMessages,
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
        messageCount: result.messageCount,
        coverage: result.coverage,
      };
    }

    if (opts.deliver) {
      await opts.deliver(result.contentHtml!);
    } else if (!opts.skipSend) {
      try {
        await this.send(opts.botId, opts.chatId, result.contentHtml!);
      } catch (err) {
        this.logger.warn(
          { err, botId: opts.botId, chatId: opts.chatId },
          "Failed to send manual summary",
        );
      }
    }
    return {
      ok: true,
      summaryId: result.summaryId,
      contentHtml: result.contentHtml,
      contentRaw: result.contentRaw,
      messageCount: result.messageCount,
      coverage: result.coverage,
    };
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();
      await this.processScheduledConfigs(now);
      await this.processGlobalFallbacks(now);
    } catch (err) {
      this.logger.error({ err }, "ChatSummaryService tick failed");
    }
  }

  private async processScheduledConfigs(now: Date): Promise<void> {
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
      if (this.closing) break;
      try {
        if (!this.isBotRunning(cfg.botId)) continue;

        const botCfg = await getBotCfg(cfg.botId);
        // Respect the bot-level summaryConfig.enabled kill-switch in the scheduled path too.
        if (this.closing) break;
        if (!botCfg?.enabled) continue;

        // scheduleHour/Minute are stored in the bot's configured timezone (default Asia/Shanghai),
        // not UTC, so users see/set wall-clock time consistent with other in-product timestamps.
        const tz = cfg.timezone ?? botCfg.timezone ?? DEFAULT_TIMEZONE;
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
      } catch (err) {
        this.logger.error(
          { err, botId: cfg.botId, chatId: cfg.chatId },
          "Scheduled summary failed",
        );
      }
    }
  }

  private async processGlobalFallbacks(now: Date): Promise<void> {
    if (this.closing) return;
    const botRows = await this.db.execute<{ id: string }>(sql`
      SELECT ${bots.id} AS id FROM ${bots}
      WHERE ${bots.isActive} = true AND ${bots.platform} = 'telegram'
    `);
    const windowStart = new Date(now.getTime() - 24 * 3600_000);
    const cooldownBefore = new Date(now.getTime() - 23 * 3600_000);
    for (const { id: botId } of botRows) {
      if (this.closing) break;
      if (!this.isBotRunning(botId)) continue;
      try {
        const cfg = await this.getBotSummaryCfg(botId);
        if (this.closing) break;
        if (!this.isBotRunning(botId)) continue;
        if (!cfg?.enabled || cfg.globalScheduleHour == null || cfg.globalScheduleMinute == null) {
          continue;
        }
        const { hour, minute } = hourMinuteInTz(now, cfg.timezone ?? DEFAULT_TIMEZONE);
        if (hour !== cfg.globalScheduleHour || minute !== cfg.globalScheduleMinute) continue;
        const roles = cfg.roleFilter ?? [...DEFAULT_ROLE_FILTER];
        if (roles.length === 0) continue;
        const chats = await this.db.execute<{ chatId: number }>(sql`
          SELECT ${conversationMessages.chatId}::float8 AS "chatId"
          FROM ${conversationMessages}
          WHERE ${conversationMessages.botId} = ${botId}
            AND EXISTS (
              SELECT 1 FROM ${telegramChats}
              WHERE ${telegramChats.botId} = ${botId}
                AND ${telegramChats.chatId} = ${conversationMessages.chatId}
                AND ${telegramChats.type} IN ('group', 'supergroup')
                AND ${telegramChats.leftAt} IS NULL
                AND ${telegramChats.migratedToChatId} IS NULL
            )
            AND ${conversationMessages.createdAt} >= ${windowStart.toISOString()}::timestamp
            AND ${conversationMessages.createdAt} <= ${now.toISOString()}::timestamp
            AND ${conversationMessages.role} IN (${sql.join(
              roles.map((role) => sql`${role}`),
              sql`, `,
            )})
            AND NOT EXISTS (
              SELECT 1 FROM ${summaryConfigs}
              WHERE ${summaryConfigs.botId} = ${botId}
                AND ${summaryConfigs.chatId} = ${conversationMessages.chatId}
            )
          GROUP BY ${conversationMessages.chatId}
          HAVING count(*) >= ${MIN_MESSAGES_FOR_SUMMARY}
          ORDER BY ${conversationMessages.chatId}
        `);
        for (const { chatId } of chats) {
          if (this.closing || !this.isBotRunning(botId)) break;
          try {
            // Claim before calling the model. Failures retain the cooldown, just like
            // explicit schedules. Recheck overrides and history at the write boundary.
            const claimed = await this.db.execute(sql`
              INSERT INTO ${globalSummaryScheduleClaims} (bot_id, chat_id, last_scheduled_at)
              SELECT ${botId}::uuid, ${chatId}::bigint, ${now.toISOString()}::timestamp
              WHERE NOT EXISTS (
                SELECT 1 FROM ${summaryConfigs}
                WHERE ${summaryConfigs.botId} = ${botId} AND ${summaryConfigs.chatId} = ${chatId}
              ) AND NOT EXISTS (
                SELECT 1 FROM ${chatSummaries}
                WHERE ${chatSummaries.botId} = ${botId} AND ${chatSummaries.chatId} = ${chatId}
                  AND ${chatSummaries.trigger} = 'scheduled'
                  AND ${chatSummaries.createdAt} >= ${cooldownBefore.toISOString()}::timestamp
              )
              ON CONFLICT (bot_id, chat_id) DO UPDATE
                SET last_scheduled_at = EXCLUDED.last_scheduled_at
                WHERE ${globalSummaryScheduleClaims.lastScheduledAt} < ${cooldownBefore.toISOString()}::timestamp
              RETURNING chat_id
            `);
            if (claimed.length === 0) continue;
            const result = await this.runner.run({
              botId,
              chatId,
              mode: { kind: "default" },
              trigger: "scheduled",
            });
            if (result.ok && result.contentHtml) {
              await this.send(botId, chatId, result.contentHtml);
            } else {
              this.logger.info(
                { botId, chatId, error: result.error },
                "Global scheduled summary skipped",
              );
            }
          } catch (err) {
            this.logger.error({ err, botId, chatId }, "Global scheduled summary failed");
          }
        }
      } catch (err) {
        this.logger.error({ err, botId }, "Global summary scheduling failed");
      }
    }
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
