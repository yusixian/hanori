import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

const commands = [
  { command: "start", description: "显示欢迎信息～" },
  { command: "help", description: "显示帮助～" },
  {
    command: "md2tg",
    description:
      "将 Markdown 转换为 Telegram 格式，第二个可选参数为 `escape` | `remove` | `keep`, 默认为 escape",
  },
  { command: "status", description: "(admin) 查看 Bot 运行状态" },
  { command: "clear", description: "(admin) 清除当前对话历史" },
  { command: "restart", description: "(admin) 重启服务" },
  { command: "backup", description: "(admin) 创建数据库备份" },
  { command: "stop", description: "(admin) 紧急停用 AI 回复并中断正在进行的调用" },
  { command: "resume", description: "(admin) 恢复 AI 回复" },
  { command: "clearreceived", description: "(admin) 清理收到的文件缓存" },
  { command: "model", description: "查看/切换 AI 模型" },
  { command: "replymode", description: "(admin) 切换回复模式 (stream/segment)" },
  { command: "imagegen", description: "(admin) 切换群组生图权限 (on/off)" },
  { command: "draw", description: "直接生图，发送 /draw 查看参数说明" },
  { command: "imgcfg", description: "(admin) 查看/修改生图配置，发送 /imgcfg help 查看参数说明" },
  { command: "timers", description: "(admin) 查看/管理活跃定时器" },
  { command: "mcp", description: "(admin) 查看/管理 MCP 服务器" },
  { command: "summary", description: "群聊总结（/summary help 查看用法）" },
];

export { commands };

export const helpCommand: CommandMiddleware<WrapperContext> = (ctx) => {
  const contents = commands.reduce((acc, command) => {
    return acc + `/${command.command} - ${command.description}\n`;
  }, "");
  return ctx.reply("命令列表：\n" + contents);
};
