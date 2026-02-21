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
];

export { commands };

export const helpCommand: CommandMiddleware<WrapperContext> = (ctx) => {
  const contents = commands.reduce((acc, command) => {
    return acc + `/${command.command} - ${command.description}\n`;
  }, "");
  return ctx.reply("命令列表：\n" + contents);
};
