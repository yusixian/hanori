import { botLogs, imageGenerations, rssCollections } from "@cos-tool-bot/database";
import { USAGE_RESOURCES, USAGE_WINDOWS } from "@cos-tool-bot/shared";
import type {
  ImageGenerationState,
  RuntimeDiagnosticResponse,
  UsageSnapshot,
} from "@cos-tool-bot/shared";
import { sql } from "drizzle-orm";
import { resolveDeploymentVersion } from "../../runtime-health.js";
import { RuntimeDiagnostics } from "../runtime-diagnostics.js";
import type { BotRuntimeHost, BotRuntimeInput, BotRuntimeServices } from "./types.js";

type RuntimeSnapshot = NonNullable<RuntimeDiagnosticResponse["runtime"]>;
const TASK_WINDOW_MS = 3_600_000;
const IMAGE_STATES: readonly ImageGenerationState[] = [
  "preparing",
  "awaiting_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "waiting_stopped",
  "cancel_rejected",
  "cancel_requested",
  "attention_required",
  "cancelled",
];

export function createRuntimeDiagnostics(
  { bot, token, aiRuntime }: Pick<BotRuntimeInput, "bot" | "token" | "aiRuntime">,
  services: Readonly<BotRuntimeServices>,
  host: Pick<BotRuntimeHost, "getRuntimeStatus">,
): RuntimeDiagnostics {
  const botId = bot.id;
  const bootedAt = Date.now();
  const version = resolveDeploymentVersion({ environmentValue: process.env.APP_VERSION });
  const environment = process.env.NODE_ENV;
  const reads = new Map<string, Promise<unknown>>();

  // Timed-out database work keeps its slot until it settles, bounding work during an outage.
  async function readBounded<T>(key: string, read: () => PromiseLike<T>): Promise<T | null> {
    let pending = reads.get(key) as Promise<T> | undefined;
    if (!pending) {
      if (reads.size >= 8) return null;
      pending = Promise.resolve()
        .then(read)
        .finally(() => reads.delete(key));
      reads.set(key, pending);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 1000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return new RuntimeDiagnostics({
    adminIds: bot.adminChatIds,
    secrets: [
      token,
      ...(aiRuntime?.providers ?? []).map((provider) => provider.apiKey),
      aiRuntime?.githubToken ?? "",
      aiRuntime?.embeddingApiKey ?? "",
      aiRuntime?.engagement.apiKey ?? "",
      ...collectDiagnosticSecrets(aiRuntime?.config),
    ],
    audit: async ({
      actor,
      operation,
      outcome,
      windowMs,
      limit,
      offset,
      resultCount,
      traceId,
      messageId,
      toolCallId,
      previous,
    }) => {
      await services.db.insert(botLogs).values({
        botId,
        level: "info",
        message: "Runtime diagnostics query",
        meta: {
          event: "runtime_diagnostics_query",
          userId: actor.userId,
          chatId: actor.chatId,
          messageId: actor.messageId,
          operation,
          outcome,
          windowMs,
          limit,
          offset,
          resultCount,
          traceId,
          targetMessageId: messageId,
          toolCallId,
          previous,
        },
      });
    },
    runtime: async (chatId, userId) => {
      const cutoff = new Date(Date.now() - TASK_WINDOW_MS);
      const [database, images, rss, quota] = await Promise.all([
        readBounded("database", () => services.db.execute(sql`select 1`)),
        readBounded(`images:${chatId}`, () =>
          services.db.execute<{ state: string; total: number }>(sql`
          select ${imageGenerations.state} as state, count(*)::integer as total
          from ${imageGenerations}
          where ${imageGenerations.botId} = ${botId} and ${imageGenerations.chatId} = ${chatId}
            and (${imageGenerations.updatedAt} >= ${cutoff.toISOString()}
              or ${imageGenerations.state} not in ('succeeded', 'failed', 'cancelled'))
          group by ${imageGenerations.state}
        `),
        ),
        readBounded(`rss:${chatId}`, () =>
          services.db.execute<{ active: number; lastDigestAt: string | null }>(sql`
          select count(*) filter (where ${rssCollections.isActive})::integer as active,
            max(${rssCollections.lastDigestAt}) as "lastDigestAt"
          from ${rssCollections}
          where ${rssCollections.botId} = ${botId} and ${rssCollections.chatId} = ${chatId}
        `),
        ),
        services.usageGovernance
          ? readBounded(`quota:${chatId}:${userId}`, () =>
              services.usageGovernance!.getSnapshot({
                botId,
                chatId,
                userId,
                chatKind: chatId < 0 ? "group" : "private",
              }),
            )
          : null,
      ]);
      let imageTasks: RuntimeSnapshot["imageTasks"] = "unobserved";
      if (images) {
        const states: Partial<Record<ImageGenerationState | "unknown", number>> = {};
        for (const row of images) {
          const state = IMAGE_STATES.find((state) => state === row.state) ?? "unknown";
          states[state] = (states[state] ?? 0) + count(row.total);
        }
        imageTasks = { windowMs: TASK_WINDOW_MS, states };
      }
      const status = host.getRuntimeStatus?.(botId);
      return {
        botStatus: status?.status ?? "unknown",
        uptimeMs: status?.uptime ?? null,
        server: "responding",
        telegramMode: "polling",
        database: database === null ? "unavailable" : "reachable",
        redis: "not_configured",
        model: "unknown",
        telegram: "unknown",
        version,
        environment:
          environment === "production" || environment === "development" || environment === "test"
            ? environment
            : "unknown",
        startedAt: bootedAt,
        checkedAt: Date.now(),
        rss: rss
          ? {
              activeCollections: count(rss[0]?.active),
              lastDigestAt: timestamp(rss[0]?.lastDigestAt) ?? null,
            }
          : "unobserved",
        imageTasks,
        githubTasks: "unobserved",
        quota: quota ? projectQuota(quota) : "unobserved",
        activeTimers: services.timerRegistry
          .listActive({ botId })
          .filter((timer) => timer.chatId === chatId).length,
      };
    },
  });
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function timestamp(value: unknown): number | undefined {
  const time =
    value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}
function projectQuota(snapshot: UsageSnapshot): RuntimeSnapshot["quota"] {
  return snapshot.resources
    .filter(
      (resource) =>
        (resource.scope === "chat" || resource.scope === "chat_user") &&
        USAGE_RESOURCES.includes(resource.resource),
    )
    .slice(0, 6)
    .map((resource) => ({
      resource: resource.resource,
      scope: resource.scope as "chat" | "chat_user",
      active: count(resource.active),
      ...(resource.concurrencyLimit !== undefined
        ? { concurrencyLimit: count(resource.concurrencyLimit) }
        : {}),
      windows: resource.windows
        .filter((window) => USAGE_WINDOWS.includes(window.window))
        .slice(0, 4)
        .map((window) => ({
          window: window.window,
          used: count(window.used),
          limit: count(window.limit),
          remaining: Math.max(0, count(window.limit) - count(window.used)),
          resetsAt: timestamp(window.resetsAt),
        })),
    }));
}

/** Collect credential values only; configuration itself is never passed into diagnostic output. */
function collectDiagnosticSecrets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const values: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /key|token|secret|password|credential/i.test(key))
      values.push(entry);
    else if (entry && typeof entry === "object") values.push(...collectDiagnosticSecrets(entry));
  }
  return values;
}
