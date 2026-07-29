import type {
  UserPrivacyCallbacks,
  UserPrivacyForgetResult,
  UserPrivacyMode,
} from "@cos-tool-bot/shared";
import type { CommandMiddleware } from "grammy";
import type { WrapperContext } from "../context.js";

export interface PrivacyCommandCallbacks extends UserPrivacyCallbacks {
  waitForPendingProfileUpdate?: (userId: number) => Promise<void>;
  beforeMutate?: (userId: number) => Promise<void>;
  runMutation?: (userId: number, operation: () => Promise<void>) => Promise<void>;
}

export type PrivacyCommandAction =
  | { kind: "status" }
  | { kind: "set"; mode: UserPrivacyMode }
  | { kind: "forget"; confirmed: boolean }
  | { kind: "help" };

export function parsePrivacyAction(raw: string): PrivacyCommandAction {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "status") return { kind: "status" };
  if (normalized === "normal" || normalized === "isolated" || normalized === "off") {
    return { kind: "set", mode: normalized };
  }
  if (normalized === "forget") return { kind: "forget", confirmed: false };
  if (normalized === "forget confirm") return { kind: "forget", confirmed: true };
  return { kind: "help" };
}

const HELP = [
  "/privacy status - 查看当前个人化模式",
  "/privacy normal - 启用个人化和跨 Chat 连续性",
  "/privacy isolated - 仅使用当前 Chat 的个人化数据",
  "/privacy off - 关闭个人化和被动触发",
  "/privacy forget - 删除可直接归属于你的既有数据",
  "",
  "群聊是公开空间：off 不会阻止群消息进入共享群历史或群总结。",
].join("\n");

function describeMode(mode: UserPrivacyMode): string {
  switch (mode) {
    case "normal":
      return "normal：启用个人化，并可参考你在其他 Chat 的近期发言。";
    case "isolated":
      return "isolated：启用当前 Chat 的个人化，但不读取其他 Chat。";
    case "off":
      return "off：关闭个人化和被动触发。群消息仍属于共享群历史。";
  }
}

function formatForgetResult(result: UserPrivacyForgetResult): string {
  return [
    "已删除可直接归属于你的既有数据，并切换为 off：",
    `- 对话消息：${result.conversationMessages}`,
    `- 个人档案：${result.profiles}`,
    `- 个人长期记忆：${result.personalMemories}`,
    "",
    "这不会撤回 Telegram 群内原消息，也无法从已经发布的共享群摘要中选择性删除内容。你之后继续在群里发言时，新消息仍会作为公开群历史保存。",
  ].join("\n");
}

export function createPrivacyCommand(
  deps: PrivacyCommandCallbacks,
): CommandMiddleware<WrapperContext> {
  return async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const action = parsePrivacyAction(String(ctx.match ?? ""));

    if (action.kind === "help") {
      await ctx.reply(HELP);
      return;
    }

    if (action.kind === "status") {
      const mode = await deps.getMode(userId);
      await ctx.reply(`当前个人化模式：${describeMode(mode)}\n\n${HELP}`);
      return;
    }

    if (action.kind === "forget" && !action.confirmed) {
      await ctx.reply(
        [
          "这会删除助手数据库中可直接归属于你的对话消息、个人档案、头像文件和个人长期记忆，并将模式切换为 off。",
          "",
          "群聊是公开空间：这不会撤回群内原消息，也无法从已经发布的共享群摘要中选择性删除内容；以后继续在群里发言仍会进入共享群历史。",
          "",
          "如确认，请发送：/privacy forget confirm",
        ].join("\n"),
      );
      return;
    }

    const mutate = async () => {
      await deps.beforeMutate?.(userId);
      await deps.runExclusive(userId, async () => {
        await deps.waitForPendingProfileUpdate?.(userId);
        if (action.kind === "set") {
          await deps.setMode(userId, action.mode);
          await ctx.reply(`已切换个人化模式：${describeMode(action.mode)}`);
          return;
        }
        const result = await deps.forget(userId);
        await ctx.reply(formatForgetResult(result));
      });
    };
    if (deps.runMutation) await deps.runMutation(userId, mutate);
    else await mutate();
  };
}
