import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export const startCommand: CommandMiddleware<WrapperContext> = (ctx) =>
  ctx.reply("欢迎，请尽情的享受咱吧～\n输入 /help 查看帮助哦");
