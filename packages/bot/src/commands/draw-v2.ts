import type { ImageGenerationActor, ImageGenerationPort, ImagePurpose } from "@cos-tool-bot/shared";
import type { CommandContext, CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface DrawV2CommandConfig {
  port: ImageGenerationPort;
  getActor(ctx: CommandContext<WrapperContext>): Promise<ImageGenerationActor>;
}

const HELP = [
  "用法: /draw <提示词> [--preset <key>] [--purpose anime|general]",
  "默认使用动漫插画路由；发送 /image presets 查看管理员允许的预设。",
  "示例: /draw 1girl, white dress --preset anime-default",
].join("\n");

export function createDrawV2Command(cfg: DrawV2CommandConfig): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const raw = String(ctx.match ?? "").trim();
    if (!raw || raw === "help") {
      await ctx.reply(HELP);
      return;
    }
    const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    const promptParts: string[] = [];
    let presetKey: string | undefined;
    let purpose: ImagePurpose = "anime_illustration";
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === "--preset") {
        presetKey = tokens[++index]?.replace(/^"|"$/g, "");
      } else if (token === "--purpose") {
        const value = tokens[++index];
        if (value === "general") purpose = "general_image";
        else if (value === "anime") purpose = "anime_illustration";
        else {
          await ctx.reply(HELP);
          return;
        }
      } else {
        promptParts.push(token.replace(/^"|"$/g, ""));
      }
    }
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
      await ctx.reply(HELP);
      return;
    }
    const actor = await cfg.getActor(ctx);
    const result = await cfg.port.create(actor, {
      purpose,
      prompt,
      presetKey,
      routingIntent: purpose === "general_image" ? "explicit" : "semantic",
    });
    if (!result.accepted) {
      const retry = result.retryAfterSeconds ? `，约 ${result.retryAfterSeconds} 秒后重试` : "";
      await ctx.reply(`无法开始生图：${result.message ?? result.reason}${retry}`);
      return;
    }
    await ctx.reply(`生图任务已创建：${result.generation.id}\n状态：${result.generation.state}`);
  };
}
