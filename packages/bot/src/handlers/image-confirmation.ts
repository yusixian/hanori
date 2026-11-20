import { escapeHtml } from "../utils/format.js";
import { sendConfirmationCard } from "./confirmation-card.js";
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
    message?: {
      chat: { id: number };
      message_id: number;
      message_thread_id?: number;
      is_topic_message?: boolean;
    };
  };
}

const pattern =
  /^cos:image:([a-f0-9-]{36}):(confirm|cancel|edit|edit_prompt|apply|cancel_edit)(?::([1-9]\d{0,9}))?$/i;

function promptQuote(label: string, value: string, limit: number): string {
  const characters = Array.from(value);
  const truncated = characters.length > limit;
  const excerpt = truncated ? characters.slice(0, limit).join("") + "…" : value;
  return `${label}${truncated ? `（共 ${characters.length} 字符）` : ""}\n<blockquote expandable>${escapeHtml(excerpt)}</blockquote>`;
}

export function imageConfirmationText(generation: ImageGenerationView, suffix?: string): string {
  const preview = generation.confirmationPreview;
  return [
    "🔐 生图确认",
    `任务：${escapeHtml(generation.id)}`,
    `后端：${generation.provider}${generation.presetKey ? ` / ${escapeHtml(generation.presetKey)}` : ""}`,
    ...(generation.confirmationVersion
      ? [
          `确认版本：v${generation.confirmationVersion}`,
          `Seed：${generation.confirmationSeed ?? "未设置"}`,
        ]
      : []),
    ...(preview
      ? [
          promptQuote("提示词", preview.prompt, 1100),
          ...(preview.negativePrompt
            ? [promptQuote("负面提示词", preview.negativePrompt, 450)]
            : []),
          [
            preview.modelId && `模型：${escapeHtml(preview.modelId)}`,
            `尺寸：${escapeHtml(preview.size ?? "默认")}`,
            `比例：${escapeHtml(preview.aspectRatio ?? "默认")}`,
            `质量：${escapeHtml(preview.quality ?? "默认")}`,
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      : []),
    ...(awaitsImageConfirmation(generation) ? ["确认后才会提交到图片供应商。"] : []),
    escapeHtml(suffix ?? "请确认或取消。"),
  ].join("\n\n");
}

export function awaitsImageConfirmation(generation: ImageGenerationView): boolean {
  return (
    generation.state === "awaiting_approval" &&
    generation.approval === "required" &&
    !generation.providerOperationId
  );
}

function confirmationKeyboard({ id, confirmationVersion }: ImageGenerationView) {
  return {
    inline_keyboard: [
      [
        { text: "确认生成", callback_data: `cos:image:${id}:confirm:${confirmationVersion ?? 1}` },
        { text: "修改 Seed", callback_data: `cos:image:${id}:edit` },
        { text: "修改提示词", callback_data: `cos:image:${id}:edit_prompt` },
        { text: "取消", callback_data: `cos:image:${id}:cancel` },
      ],
    ],
  };
}

export async function sendImageConfirmationMessage(
  api: Api,
  chatId: number,
  generation: ImageGenerationView,
  threadId?: number,
): Promise<number> {
  if (!awaitsImageConfirmation(generation)) throw new Error("image_confirmation_unavailable");
  return sendConfirmationCard(
    api,
    chatId,
    imageConfirmationText(generation),
    confirmationKeyboard(generation),
    threadId,
    "HTML",
  );
}

export function createImageConfirmationReplyHandler(options: ImageConfirmationOptions) {
  return async (ctx: {
    message?: {
      message_id: number;
      chat: { id: number };
      message_thread_id?: number;
      is_topic_message?: boolean;
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
    if (
      !generation ||
      !awaitsImageConfirmation(generation) ||
      generation.deliveryTarget?.chatId !== ctx.message.chat.id ||
      generation.deliveryTarget.threadId !==
        (ctx.message.is_topic_message ? ctx.message.message_thread_id : undefined)
    )
      return false;
    const updated = await options.port.editConfirmationPrompt?.(actor, generation.id, ctx.text);
    if (!updated || !awaitsImageConfirmation(updated)) return false;
    await options.api
      .editMessageText(
        ctx.message.chat.id,
        replyTo.message_id,
        imageConfirmationText(updated, "提示词已保存为草稿；请在卡片上应用修改并重新确认。"),
        {
          parse_mode: "HTML",
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
    const threadId = query.message.is_topic_message ? query.message.message_thread_id : undefined;
    const actor: ImageGenerationActor = {
      botId: options.botId,
      chatId,
      userId: query.from.id,
      chatType: chatId < 0 ? "supergroup" : "private",
      isBotAdmin: options.adminIds.includes(query.from.id),
      isDelegatedGroupAdmin: false,
      imageConfirmationPolicy: "never",
      ...(threadId === undefined ? {} : { requestContext: { threadId } }),
    };
    const action = match[2];
    const generationId = match[1]!;
    const current = await options.port.get(actor, generationId, { confirmationPreview: true });
    if (
      !current ||
      !awaitsImageConfirmation(current) ||
      current.deliveryTarget?.chatId !== chatId ||
      current.deliveryTarget.threadId !== threadId
    ) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "当前确认已失效或无权操作",
        show_alert: true,
      });
      return true;
    }
    // Buttons from before revisioned callbacks were introduced represent the original draft.
    const expectedVersion = Number(match[3] ?? 1);
    if (action === "confirm" && expectedVersion !== (current.confirmationVersion ?? 1)) {
      await options.api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "草稿已更新，请核对后重新确认。",
        show_alert: true,
      });
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          imageConfirmationText(current, "草稿已更新，请核对后重新确认。"),
          {
            parse_mode: "HTML",
            reply_markup: confirmationKeyboard(current),
          },
        )
        .catch(() => {});
      return true;
    }
    await options.api.raw.answerCallbackQuery({
      callback_query_id: query.id,
      text:
        match[2] === "confirm"
          ? "正在确认生图"
          : match[2] === "cancel"
            ? "正在取消生图"
            : "正在更新确认草稿",
    });
    if (action === "edit") {
      const current = await options.port.editConfirmation?.(actor, match[1]!, {
        seed: Math.floor(Date.now() / 1000) % 4_294_967_296,
      });
      if (current && awaitsImageConfirmation(current)) {
        await options.api
          .editMessageText(
            chatId,
            query.message.message_id,
            imageConfirmationText(current, "已生成修改草稿。应用修改后必须重新确认。"),
            {
              parse_mode: "HTML",
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
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          imageConfirmationText(current, "请直接回复这张卡，发送新的提示词。取消修改请点击撤销。"),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "撤销修改", callback_data: `cos:image:${generationId}:cancel_edit` }],
              ],
            },
          },
        )
        .catch(() => {});
      return true;
    }
    if (action === "cancel_edit") {
      const current = await options.port.discardConfirmationEdit?.(actor, match[1]!);
      if (!current || !awaitsImageConfirmation(current)) return true;
      await options.api
        .editMessageText(chatId, query.message.message_id, imageConfirmationText(current), {
          parse_mode: "HTML",
          reply_markup: confirmationKeyboard(current),
        })
        .catch(() => {});
      return true;
    }
    if (action === "apply") {
      await options.api
        .editMessageText(
          chatId,
          query.message.message_id,
          imageConfirmationText(current, "修改已应用，请重新确认。"),
          { parse_mode: "HTML", reply_markup: confirmationKeyboard(current) },
        )
        .catch(() => {});
      return true;
    }
    const result =
      action === "confirm"
        ? await options.port.confirm?.(actor, generationId, expectedVersion)
        : await options.port.cancelConfirmation?.(actor, match[1]!);
    if (!result) {
      await options.api
        .editMessageText(chatId, query.message.message_id, "❌ 当前版本不支持生图确认")
        .catch(() => {});
      return true;
    }
    const accepted = "accepted" in result ? result.accepted : result.ok;
    let generation = result.generation;
    if (action === "confirm" && !accepted) {
      const current = await options.port.get(actor, match[1]!, { confirmationPreview: true });
      // A stale or unauthorized click must not overwrite the owner's current receipt.
      if (!current || (!generation && !awaitsImageConfirmation(current))) return true;
      if (awaitsImageConfirmation(current) || !generation) generation = current;
      else if ("reason" in result && result.reason === "invalid_request") return true;
    }
    const failureMessage = "message" in result ? result.message : undefined;
    const text = accepted
      ? action === "confirm"
        ? "✅ 已确认，任务已进入生成流程。"
        : "❌ 已取消生图"
      : `❌ ${failureMessage ?? "该确认已失效或无权操作"}`;
    await options.api
      .editMessageText(
        chatId,
        query.message.message_id,
        generation ? imageConfirmationText(generation, text) : escapeHtml(text),
        {
          parse_mode: "HTML",
          reply_markup:
            !accepted && action === "confirm" && generation && awaitsImageConfirmation(generation)
              ? confirmationKeyboard(generation)
              : { inline_keyboard: [] },
        },
      )
      .catch(() => {});
    return true;
  };
}
