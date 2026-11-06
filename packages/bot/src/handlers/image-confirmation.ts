import type {
  ImageGenerationActor,
  ImageGenerationPort,
  ImageGenerationView,
} from "@cos-tool-bot/shared";
import type { Api } from "grammy";

export interface ImageConfirmationOptions {
  api: Api;
  botId: string;
  adminIds: readonly number[];
  port: ImageGenerationPort;
}

interface CallbackContext {
  callbackQuery: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number; message_thread_id?: number };
  };
}

const pattern = /^cos:image:([a-f0-9-]{36}):(confirm|cancel|edit|edit_prompt|apply|cancel_edit)$/i;

export function imageConfirmationText(generation: ImageGenerationView, suffix?: string): string {
  return [
    "🔐 生图确认",
    `任务：${generation.id}`,
    `后端：${generation.provider}${generation.presetKey ? ` / ${generation.presetKey}` : ""}`,
    ...(generation.confirmationVersion
      ? [
          `确认版本：v${generation.confirmationVersion}`,
          `Seed：${generation.confirmationSeed ?? "未设置"}`,
        ]
      : []),
    "确认后才会提交到图片供应商；确认前不会产生供应商任务或费用。",
    suffix ?? "请确认或取消。",
  ].join("\n\n");
}

export async function sendImageConfirmationMessage(
  api: Api,
  chatId: number,
  generation: ImageGenerationView,
  threadId?: number,
): Promise<number> {
  if (generation.state !== "awaiting_approval" || generation.approval !== "required")
    throw new Error("image_confirmation_unavailable");
  const message = await api.sendMessage(chatId, imageConfirmationText(generation), {
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "确认生成", callback_data: `cos:image:${generation.id}:confirm` },
          { text: "修改 Seed", callback_data: `cos:image:${generation.id}:edit` },
          { text: "修改提示词", callback_data: `cos:image:${generation.id}:edit_prompt` },
          { text: "取消", callback_data: `cos:image:${generation.id}:cancel` },
        ],
      ],
    },
  });
  return message.message_id;
}

export function createImageConfirmationReplyHandler(options: ImageConfirmationOptions) {
  return async (ctx: {
    message?: {
      message_id: number;
      chat: { id: number };
      message_thread_id?: number;
      reply_to_message?: { message_id: number };
    };
    from?: { id: number };
    text?: string;
  }): Promise<boolean> => {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo || !ctx.message || !ctx.from || !ctx.text) return false;
    const actor: ImageGenerationActor = {
      botId: options.botId,
      chatId: ctx.message.chat.id,
      userId: ctx.from.id,
      chatType: ctx.message.chat.id < 0 ? "supergroup" : "private",
      isBotAdmin: options.adminIds.includes(ctx.from.id),
      isDelegatedGroupAdmin: false,
      imageConfirmationPolicy: "never",
    };
    const generation = await options.port.findConfirmationByMessage?.(actor, replyTo.message_id);
    if (!generation) return false;
    const updated = await options.port.editConfirmationPrompt?.(actor, generation.id, ctx.text);
    if (!updated) return false;
    await options.api
      .editMessageText(
        ctx.message.chat.id,
        replyTo.message_id,
        imageConfirmationText(updated, "提示词已保存为草稿；请在卡片上应用修改并重新确认。"),
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "应用修改并重新确认", callback_data: `cos:image:${updated.id}:apply` },
                { text: "撤销修改", callback_data: `cos:image:${updated.id}:cancel_edit` },
              ],
            ],
          },
        },
      )
      .catch(() => {});
    return true;
  };
}

export function createImageConfirmationCallbackQueryHandler(options: ImageConfirmationOptions) {
  return async (ctx: CallbackContext): Promise<boolean> => {
    const query = ctx.callbackQuery;
    if (!query.data?.startsWith("cos:image:")) return false;
    const match = pattern.exec(query.data);
    if (!match || !query.message) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "该生图确认无效",
        show_alert: true,
      });
      return true;
    }
    const chatId = query.message.chat.id;
    const actor: ImageGenerationActor = {
      botId: options.botId,
      chatId,
      userId: query.from.id,
      chatType: chatId < 0 ? "supergroup" : "private",
      isBotAdmin: options.adminIds.includes(query.from.id),
      isDelegatedGroupAdmin: false,
      imageConfirmationPolicy: "never",
      ...(query.message.message_thread_id === undefined
        ? {}
        : { requestContext: { threadId: query.message.message_thread_id } }),
    };
    await options.api.raw.answerCallbackQuery({
      callback_query_id: query.id,
      text:
        match[2] === "confirm"
          ? "正在确认生图"
          : match[2] === "cancel"
            ? "正在取消生图"
            : "正在更新确认草稿",
    });
    const action = match[2];
    if (action === "edit") {
      const current = await options.port.editConfirmation?.(actor, match[1]!, {
        seed: Math.floor(Date.now() / 1000) % 4_294_967_296,
      });
      if (!current) {
        await options.api
          .editMessageText(chatId, query.message.message_id, "❌ 当前确认已失效或无权修改")
          .catch(() => {});
      } else {
        await options.api
          .editMessageText(
            chatId,
            query.message.message_id,
            imageConfirmationText(current, "已生成修改草稿。应用修改后必须重新确认。"),
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "应用修改并重新确认", callback_data: `cos:image:${current.id}:apply` },
                    { text: "撤销修改", callback_data: `cos:image:${current.id}:cancel_edit` },
                  ],
                ],
              },
            },
          )
          .catch(() => {});
      }
      return true;
    }
    if (action === "edit_prompt") {
      const current = await options.port.get(actor, match[1]!);
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          current
            ? imageConfirmationText(
                current,
                "请直接回复这张卡，发送新的提示词。取消修改请点击撤销。",
              )
            : "❌ 当前确认已失效",
          {
            reply_markup: current
              ? {
                  inline_keyboard: [
                    [{ text: "撤销修改", callback_data: `cos:image:${match[1]}:cancel_edit` }],
                  ],
                }
              : { inline_keyboard: [] },
          },
        )
        .catch(() => {});
      return true;
    }
    if (action === "cancel_edit") {
      const current = await options.port.discardConfirmationEdit?.(actor, match[1]!);
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          current ? imageConfirmationText(current) : "❌ 修改草稿已失效",
          {
            reply_markup: current
              ? {
                  inline_keyboard: [
                    [
                      { text: "确认生成", callback_data: `cos:image:${current.id}:confirm` },
                      { text: "修改 Seed", callback_data: `cos:image:${current.id}:edit` },
                      { text: "取消", callback_data: `cos:image:${current.id}:cancel` },
                    ],
                  ],
                }
              : { inline_keyboard: [] },
          },
        )
        .catch(() => {});
      return true;
    }
    if (action === "apply") {
      const current = await options.port.get(actor, match[1]!);
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          current
            ? imageConfirmationText(current, "修改已应用，请重新确认。")
            : "❌ 修改草稿已失效",
          {
            reply_markup: current
              ? {
                  inline_keyboard: [
                    [
                      { text: "确认生成", callback_data: `cos:image:${match[1]}:confirm` },
                      { text: "修改 Seed", callback_data: `cos:image:${match[1]}:edit` },
                      { text: "取消", callback_data: `cos:image:${match[1]}:cancel` },
                    ],
                  ],
                }
              : { inline_keyboard: [] },
          },
        )
        .catch(() => {});
      return true;
    }
    const result =
      action === "confirm"
        ? await options.port.confirm?.(actor, match[1]!)
        : await options.port.cancelConfirmation?.(actor, match[1]!);
    if (!result) {
      await options.api
        .editMessageText(chatId, query.message.message_id, "❌ 当前版本不支持生图确认")
        .catch(() => {});
      return true;
    }
    const generation = "generation" in result ? result.generation : undefined;
    const accepted = action === "confirm" ? result.accepted : result.ok;
    const failureMessage = "message" in result ? result.message : undefined;
    const text = accepted
      ? action === "confirm"
        ? "✅ 已确认，生图任务已提交。"
        : "❌ 已取消生图"
      : `❌ ${failureMessage ?? "该确认已失效或无权操作"}`;
    await options.api
      .editMessageText(
        chatId,
        query.message.message_id,
        generation ? imageConfirmationText(generation, text) : text,
        {
          reply_markup: { inline_keyboard: [] },
        },
      )
      .catch(() => {});
    return true;
  };
}
