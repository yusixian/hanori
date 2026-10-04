import type { AiReplyBotConfig } from "@cos-tool-bot/bot";
import { bots, mcpServers } from "@cos-tool-bot/database";
import { eq } from "drizzle-orm";
import type { McpClientManager } from "../mcp-client-manager.js";
import type { BotRuntimeHost, BotRuntimeServices } from "./types.js";

export function createMcpCallbacks(
  botId: string,
  services: Readonly<BotRuntimeServices>,
  host: BotRuntimeHost,
) {
  const db = services.db;
  return services.mcpClientManager
    ? {
        listServers: async () => {
          const allServers = await db
            .select()
            .from(mcpServers)
            .where(eq(mcpServers.isActive, true));
          const [currentBot] = await db.select().from(bots).where(eq(bots.id, botId));
          const enabledIds = new Set(currentBot?.aiConfig?.mcpServerIds ?? []);
          const statuses = services.mcpClientManager!.getStatus();
          const statusMap = new Map(statuses.map((s) => [s.serverId, s]));
          return allServers.map((s) => ({
            id: s.id,
            name: s.name,
            connected: statusMap.get(s.id)?.connected ?? false,
            toolCount: statusMap.get(s.id)?.toolCount ?? 0,
            enabled: enabledIds.has(s.id),
            error: statusMap.get(s.id)?.error ?? null,
          }));
        },
        addServer: async (serverId: number) => {
          const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
          if (!server) return { ok: false as const, error: "服务器不存在" };
          const result = await host.withAiConfigLock(botId, async () => {
            const [current] = await db.select().from(bots).where(eq(bots.id, botId));
            if (!current?.aiConfig) return { ok: false as const, error: "AI 未配置" };
            const ids = new Set(current.aiConfig.mcpServerIds ?? []);
            if (ids.has(serverId)) return { ok: false as const, error: "已启用" };
            ids.add(serverId);
            await db
              .update(bots)
              .set({ aiConfig: { ...current.aiConfig, mcpServerIds: [...ids] } })
              .where(eq(bots.id, botId));
            return { ok: true as const };
          });
          if (result.ok) setTimeout(() => host.restartBot(botId).catch(() => {}), 2000);
          return result;
        },
        removeServer: async (serverId: number) => {
          const result = await host.withAiConfigLock(botId, async () => {
            const [current] = await db.select().from(bots).where(eq(bots.id, botId));
            if (!current?.aiConfig) return { ok: false as const, error: "AI 未配置" };
            const ids = new Set(current.aiConfig.mcpServerIds ?? []);
            if (!ids.has(serverId)) return { ok: false as const, error: "未启用" };
            ids.delete(serverId);
            await db
              .update(bots)
              .set({ aiConfig: { ...current.aiConfig, mcpServerIds: [...ids] } })
              .where(eq(bots.id, botId));
            return { ok: true as const };
          });
          if (result.ok) setTimeout(() => host.restartBot(botId).catch(() => {}), 2000);
          return result;
        },
      }
    : undefined;
}

export function createMcpToolsConfig(
  mcpClientManager: McpClientManager | undefined,
  mcpServerIds?: number[],
): AiReplyBotConfig["mcpTools"] {
  if (!mcpClientManager || !mcpServerIds?.length) return undefined;

  return {
    getTools: () => mcpClientManager.getToolsForServers(mcpServerIds),
    callTool: (serverId: number, toolName: string, args: unknown, signal?: AbortSignal) =>
      mcpClientManager.callTool(serverId, toolName, args, signal),
  };
}
