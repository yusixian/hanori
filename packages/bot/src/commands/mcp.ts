import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface McpCommandConfig {
  listServers: () => Promise<
    Array<{
      id: number;
      name: string;
      connected: boolean;
      toolCount: number;
      enabled: boolean;
      error: string | null;
    }>
  >;
  addServer: (serverId: number) => Promise<{ ok: boolean; error?: string }>;
  removeServer: (serverId: number) => Promise<{ ok: boolean; error?: string }>;
}

export function createMcpCommand(config: McpCommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const args = ctx.match?.toString().trim() ?? "";

    if (!args) {
      const servers = await config.listServers();
      if (servers.length === 0) {
        await ctx.reply("没有可用的 MCP 服务器", { parse_mode: "HTML" });
        return;
      }

      const lines = ["<b>MCP 服务器</b>", ""];
      for (let i = 0; i < servers.length; i++) {
        const s = servers[i]!;
        const status = s.connected ? `✅ 已连接 · ${s.toolCount} tools` : "❌ 未连接";
        const enabled = s.enabled ? "🟢 已启用" : "🔴 未启用";
        lines.push(`${i + 1}. <b>${escapeHtml(s.name)}</b> (ID: ${s.id})`);
        lines.push(`   ${status} · ${enabled}`);
        if (s.error) {
          lines.push(`   ⚠️ ${escapeHtml(s.error)}`);
        }
        lines.push("");
      }
      lines.push("/mcp add &lt;ID&gt; 启用 · /mcp remove &lt;ID&gt; 禁用");
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const idStr = parts[1];

    if ((sub === "add" || sub === "remove") && idStr) {
      const serverId = Number.parseInt(idStr, 10);
      if (Number.isNaN(serverId)) {
        await ctx.reply("ID 必须是数字", { parse_mode: "HTML" });
        return;
      }

      const result =
        sub === "add" ? await config.addServer(serverId) : await config.removeServer(serverId);

      if (!result.ok) {
        await ctx.reply(`操作失败: ${escapeHtml(result.error ?? "未知错误")}`, {
          parse_mode: "HTML",
        });
        return;
      }

      const action = sub === "add" ? "已启用" : "已禁用";
      await ctx.reply(`${action} MCP 服务器 #${serverId}，bot 将在 2 秒后重启`, {
        parse_mode: "HTML",
      });
      return;
    }

    await ctx.reply(
      "用法:\n/mcp — 查看所有 MCP 服务器\n/mcp add &lt;ID&gt; — 启用\n/mcp remove &lt;ID&gt; — 禁用",
      { parse_mode: "HTML" },
    );
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
