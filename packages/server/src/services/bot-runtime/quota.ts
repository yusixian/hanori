import type { BotConfig } from "@cos-tool-bot/bot";
import type { UsageResource, UsageScope, UsageWindow } from "@cos-tool-bot/shared";
import type { BotRuntimeHost, BotRuntimeServices } from "./types.js";

function usageSnapshotLabel(resource: UsageResource, scope: UsageScope): string {
  const resourceLabel = resource === "image" ? "图片生成" : "AI 回复";
  const scopeLabel =
    scope === "bot"
      ? "Bot"
      : scope === "chat"
        ? "当前群聊"
        : scope === "user_global"
          ? "你的跨群用量"
          : "你在当前群聊";
  return `${resourceLabel} · ${scopeLabel}`;
}

function usageWindowLabel(window: UsageWindow): string {
  if (window === "minute") return "近 1 分钟";
  if (window === "hour") return "近 1 小时";
  if (window === "day") return "今日";
  return "本月";
}

export function createQuotaConfig(
  botId: string,
  adminChatIds: number[],
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
): BotConfig["quota"] {
  return services.usageGovernance
    ? {
        getUsage: async ({ chatId, userId, chatType }) => {
          const snapshot = await services.usageGovernance!.getSnapshot({
            botId,
            chatKind: chatType === "private" ? "private" : "group",
            chatId,
            userId,
            resources: ["ai_reply", "image"],
          });
          return {
            timezone: snapshot.timezone,
            resources: snapshot.resources.map((resource) => ({
              label: usageSnapshotLabel(resource.resource, resource.scope),
              windows: resource.windows.map((window) => ({
                label: usageWindowLabel(window.window),
                used: window.used,
                limit: window.limit,
                resetsAt: window.resetsAt?.toISOString(),
              })),
              active: resource.active,
              concurrencyLimit: resource.concurrencyLimit,
            })),
          };
        },
        tighten: async (input) => {
          const authorized =
            adminChatIds.includes(input.actorUserId) ||
            (await host.isDelegatedGroupAdmin(botId, input.chatId, input.actorUserId));
          if (!authorized) {
            return { ok: false, message: "需要 Bot 管理员授权且当前仍是 Telegram 群管理员。" };
          }
          if (!services.usageGovernance?.tightenGroupPolicy) {
            return { ok: false, message: "用量治理服务不可用。" };
          }
          try {
            await services.usageGovernance.tightenGroupPolicy({
              botId,
              chatId: input.chatId,
              actorUserId: input.actorUserId,
              resource: input.resource,
              targetUserId: input.targetUserId,
              limits: {
                hour: input.hourly,
                day: input.daily,
                cooldownMs:
                  input.cooldownSeconds === undefined ? undefined : input.cooldownSeconds * 1_000,
              },
            });
            return { ok: true };
          } catch {
            return { ok: false, message: "新设置只能比现有上限更严格，且只能作用于当前群聊。" };
          }
        },
      }
    : undefined;
}
