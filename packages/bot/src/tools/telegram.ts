import { resolveAndValidate } from "@cos-tool-bot/shared";
import type { CoreTool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { PendingActionRegistry } from "../services/pending-actions.js";
import type { OnceGuardContext } from "./utils.js";
import { wrapOnce, zodToAiSchema } from "./utils.js";

export interface TelegramToolsOptions {
  api: Api;
  chatId: number;
  recentBotMessageIds: number[];
  ttsEndpoint?: string;
  pendingActions?: PendingActionRegistry;
  onTimerFired?: (chatId: number, timerId: string, reason: string) => void;
  onceGuard?: OnceGuardContext;
  dataDir?: string;
}

async function resolveInput(source: string, dataDir?: string): Promise<string | InputFile> {
  if (source.startsWith("local:") && dataDir) {
    const filePath = source.slice(6);
    const resolved = resolveAndValidate(dataDir, filePath);
    if (!resolved) throw new Error("Invalid file path");
    const buffer = await fs.readFile(resolved);
    return new InputFile(buffer, path.basename(resolved));
  }
  return source;
}

/** Tool names whose execute functions should be guarded against duplicate calls. */
const ONCE_GUARDED_TELEGRAM_TOOLS = [
  "send_photo",
  "send_document",
  "send_media_group",
  "send_poll",
  "send_choice",
  "send_dice",
  "reply_to_specific",
  "send_voice",
] as const;

export function createTelegramTools(options: TelegramToolsOptions): Record<string, CoreTool> {
  const { api, chatId, recentBotMessageIds, dataDir } = options;

  const tools: Record<string, CoreTool> = {
    send_photo: tool({
      description:
        "发送图片给当前聊天。支持 URL、file_id，或 local:photo.png 发送 data 目录本地文件。可选 has_spoiler 遮罩（NSFW 内容）。",
      parameters: zodToAiSchema(
        z.object({
          photo: z.string().describe("图片 URL、file_id，或 local:filename 发送本地文件"),
          caption: z.string().optional().describe("图片说明文字"),
          has_spoiler: z.boolean().optional().describe("是否添加剧透/NSFW 遮罩，默认 false"),
        }),
      ),
      execute: async ({ photo, caption, has_spoiler }) => {
        try {
          const input = await resolveInput(photo, dataDir);
          const sent = await api.sendPhoto(chatId, input, {
            caption,
            has_spoiler: has_spoiler ?? false,
          });
          recentBotMessageIds.push(sent.message_id);
          return { success: true, message_id: sent.message_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_document: tool({
      description:
        "发送文件给当前聊天。支持 URL、file_id，或 local:report.csv 发送 data 目录本地文件。",
      parameters: zodToAiSchema(
        z.object({
          document: z.string().describe("文件 URL、file_id，或 local:filename 发送本地文件"),
          caption: z.string().optional().describe("文件说明文字"),
        }),
      ),
      execute: async ({ document, caption }) => {
        try {
          const input = await resolveInput(document, dataDir);
          const sent = await api.sendDocument(chatId, input, { caption });
          recentBotMessageIds.push(sent.message_id);
          return { success: true, message_id: sent.message_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_media_group: tool({
      description: "批量发送多张图片或文档。支持 URL、file_id、local:xxx 混合。最多 10 张。",
      parameters: zodToAiSchema(
        z.object({
          media: z
            .array(
              z.object({
                type: z.enum(["photo", "document"]).describe("媒体类型"),
                source: z.string().describe("URL、file_id 或 local:filename"),
                caption: z.string().optional().describe("说明文字"),
                has_spoiler: z.boolean().optional().describe("是否遮罩（仅 photo）"),
              }),
            )
            .min(2)
            .max(10)
            .describe("媒体列表"),
        }),
      ),
      execute: async ({ media }) => {
        try {
          const inputMedia = await Promise.all(
            media.map(async (m) => {
              const input = await resolveInput(m.source, dataDir);
              if (m.type === "photo") {
                return {
                  type: "photo" as const,
                  media: input,
                  caption: m.caption,
                  has_spoiler: m.has_spoiler ?? false,
                };
              }
              return {
                type: "document" as const,
                media: input,
                caption: m.caption,
              };
            }),
          );
          const sent = await api.sendMediaGroup(chatId, inputMedia);
          for (const msg of sent) {
            recentBotMessageIds.push(msg.message_id);
          }
          return {
            success: true,
            message_ids: sent.map((m) => m.message_id),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_poll: tool({
      description:
        "在当前聊天发起投票。默认为非匿名投票，投票结果会自动通知你（AI），你可以根据结果继续对话。",
      parameters: zodToAiSchema(
        z.object({
          question: z.string().describe("投票问题"),
          poll_options: z.array(z.string()).min(2).max(10).describe("选项列表"),
          is_anonymous: z.boolean().optional().describe("是否匿名投票，默认 false"),
        }),
      ),
      execute: async ({ question, poll_options, is_anonymous }) => {
        try {
          const anonymous = is_anonymous ?? false;
          const sent = await api.sendPoll(
            chatId,
            question,
            poll_options.map((o) => ({ text: o })),
            { is_anonymous: anonymous },
          );
          recentBotMessageIds.push(sent.message_id);

          // Register non-anonymous polls for result tracking
          if (!anonymous && options.pendingActions && sent.poll) {
            options.pendingActions.registerPoll(
              sent.poll.id,
              chatId,
              sent.message_id,
              question,
              poll_options,
            );
          }

          return {
            success: true,
            message_id: sent.message_id,
            poll_id: sent.poll?.id,
            is_anonymous: anonymous,
            note: anonymous ? undefined : "投票结果会在用户投票后自动通知你，你不需要主动查询。",
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_choice: tool({
      description:
        "发送 inline keyboard 选择按钮，用于快速选择场景（如 galgame 分支、问答、互动游戏等）。用户点击后你会自动收到通知并可继续对话。",
      parameters: zodToAiSchema(
        z.object({
          prompt: z.string().describe("选择提示文字，显示在按钮上方"),
          options: z.array(z.string()).min(2).max(8).describe("选项列表"),
          target_user_id: z
            .number()
            .optional()
            .describe("限制只有指定用户能点击，不填则所有人可点"),
        }),
      ),
      execute: async ({ prompt, options: choiceOptions, target_user_id }) => {
        try {
          if (!options.pendingActions) {
            return { error: "Interactive features not available" };
          }
          const choiceId = options.pendingActions.generateChoiceId();
          const keyboard = new InlineKeyboard();
          for (let i = 0; i < choiceOptions.length; i++) {
            keyboard.text(choiceOptions[i]!, `cos:c:${choiceId}:${i}`);
            if (i % 2 === 1 || i === choiceOptions.length - 1) keyboard.row();
          }
          const sent = await api.sendMessage(chatId, prompt, {
            reply_markup: keyboard,
          });
          recentBotMessageIds.push(sent.message_id);
          options.pendingActions.registerChoice(
            choiceId,
            chatId,
            sent.message_id,
            prompt,
            choiceOptions,
            target_user_id,
          );
          return {
            success: true,
            message_id: sent.message_id,
            choice_id: choiceId,
            note: "用户点击后你会自动收到通知并可继续对话。",
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    close_poll: tool({
      description: "手动关闭一个投票并获取最终结果。投票关闭后用户无法再投票。",
      parameters: zodToAiSchema(
        z.object({
          message_id: z.number().describe("投票消息的 message_id"),
        }),
      ),
      execute: async ({ message_id }) => {
        try {
          const result = await api.stopPoll(chatId, message_id);
          return {
            success: true,
            question: result.question,
            total_voter_count: result.total_voter_count,
            options: result.options.map((o) => ({
              text: o.text,
              voter_count: o.voter_count,
            })),
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    set_timer: tool({
      description:
        "设置一个定时器。到期后你（AI）会自动收到通知并可继续对话。可用于投票倒计时、游戏节奏控制、定时提醒等。",
      parameters: zodToAiSchema(
        z.object({
          seconds: z.number().min(5).max(3600).describe("定时秒数（5-3600）"),
          reason: z.string().describe("定时器用途说明，到期后会作为上下文提供给你"),
        }),
      ),
      execute: async ({ seconds, reason }) => {
        try {
          if (!options.pendingActions || !options.onTimerFired) {
            return { error: "Timer features not available" };
          }
          // Register first so timerId is available in the closure
          const pending = options.pendingActions.registerTimer(
            chatId,
            reason,
            // Placeholder handle, replaced below
            setTimeout(() => {}, 0),
          );
          clearTimeout(pending.handle);
          const handle = setTimeout(() => {
            const timer = options.pendingActions!.removeTimer(pending.timerId);
            if (timer) {
              options.onTimerFired!(chatId, timer.timerId, timer.reason);
            }
          }, seconds * 1000);
          handle.unref();
          pending.handle = handle;
          return {
            success: true,
            timer_id: pending.timerId,
            seconds,
            reason,
            note: "定时器到期后你会自动收到通知。",
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    cancel_timer: tool({
      description: "取消一个之前设置的定时器。",
      parameters: zodToAiSchema(
        z.object({
          timer_id: z.string().describe("要取消的定时器 ID"),
        }),
      ),
      execute: async ({ timer_id }) => {
        try {
          if (!options.pendingActions) {
            return { error: "Timer features not available" };
          }
          const removed = options.pendingActions.removeTimer(timer_id);
          if (!removed) return { error: "Timer not found or already expired" };
          return { success: true, cancelled_timer_id: timer_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_dice: tool({
      description: "发送骰子/随机动画 emoji。可用的 emoji: 🎲🎯🏀⚽🎳🎰。趣味互动用。",
      parameters: zodToAiSchema(
        z.object({
          emoji: z
            .enum(["🎲", "🎯", "🏀", "⚽", "🎳", "🎰"])
            .optional()
            .describe("骰子 emoji 类型，默认 🎲"),
        }),
      ),
      execute: async ({ emoji }) => {
        try {
          const sent = await api.sendDice(chatId, emoji ?? "🎲");
          recentBotMessageIds.push(sent.message_id);
          return { success: true, value: sent.dice?.value };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    edit_own_message: tool({
      description:
        '编辑 bot 之前发过的消息内容。可以用来"改口"或更新信息。只能编辑 bot 自己发的消息。',
      parameters: zodToAiSchema(
        z.object({
          message_id: z.number().describe("要编辑的消息 ID（必须是 bot 自己发的消息）"),
          text: z.string().describe("新的消息内容"),
        }),
      ),
      execute: async ({ message_id, text }) => {
        if (!recentBotMessageIds.includes(message_id)) {
          return { error: "只能编辑 bot 最近发送的消息" };
        }
        try {
          await api.editMessageText(chatId, message_id, text);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    delete_own_message: tool({
      description: '删除 bot 之前发过的消息。模拟"撤回"效果。只能删除 bot 自己发的消息。',
      parameters: zodToAiSchema(
        z.object({
          message_id: z.number().describe("要删除的消息 ID（必须是 bot 自己发的消息）"),
        }),
      ),
      execute: async ({ message_id }) => {
        if (!recentBotMessageIds.includes(message_id)) {
          return { error: "只能删除 bot 最近发送的消息" };
        }
        try {
          await api.deleteMessage(chatId, message_id);
          const idx = recentBotMessageIds.indexOf(message_id);
          if (idx !== -1) recentBotMessageIds.splice(idx, 1);
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    pin_message: tool({
      description: "置顶一条消息。需要 bot 有管理员权限，无权限时会优雅降级。",
      parameters: zodToAiSchema(
        z.object({
          message_id: z.number().describe("要置顶的消息 ID"),
          disable_notification: z.boolean().optional().describe("是否静默置顶，默认 false"),
        }),
      ),
      execute: async ({ message_id, disable_notification }) => {
        try {
          await api.pinChatMessage(chatId, message_id, {
            disable_notification: disable_notification ?? false,
          });
          return { success: true };
        } catch (err) {
          return { error: `Bot 没有管理员权限或无法置顶: ${String(err)}` };
        }
      },
    }),

    get_chat_info: tool({
      description: "获取当前聊天的信息，包括群名、类型、人数、描述等。",
      parameters: zodToAiSchema(z.object({})),
      execute: async () => {
        try {
          const [chat, memberCount] = await Promise.all([
            api.getChat(chatId),
            api.getChatMemberCount(chatId).catch(() => null),
          ]);
          return {
            id: chat.id,
            type: chat.type,
            title: "title" in chat ? chat.title : undefined,
            description: "description" in chat ? chat.description : undefined,
            member_count: memberCount,
            username: "username" in chat ? chat.username : undefined,
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    reply_to_specific: tool({
      description: "回复聊天中的某条特定历史消息。用于引用之前的某条消息进行回复。",
      parameters: zodToAiSchema(
        z.object({
          reply_to_message_id: z.number().describe("要回复的目标消息 ID"),
          text: z.string().describe("回复内容"),
        }),
      ),
      execute: async ({ reply_to_message_id, text }) => {
        try {
          const sent = await api.sendMessage(chatId, text, {
            reply_parameters: { message_id: reply_to_message_id },
          });
          recentBotMessageIds.push(sent.message_id);
          return { success: true, message_id: sent.message_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };

  // Conditionally add send_voice if TTS endpoint is configured
  if (options.ttsEndpoint) {
    const ttsEndpoint = options.ttsEndpoint;
    tools.send_voice = tool({
      description: "发送语音消息。将文本转为语音后发送。",
      parameters: zodToAiSchema(
        z.object({
          text: z.string().describe("要转换为语音的文本"),
        }),
      ),
      execute: async ({ text }) => {
        try {
          const res = await fetch(ttsEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) return { error: `TTS request failed: HTTP ${res.status}` };
          const buffer = Buffer.from(await res.arrayBuffer());
          const sent = await api.sendVoice(chatId, new InputFile(buffer, "voice.ogg"));
          recentBotMessageIds.push(sent.message_id);
          return { success: true, message_id: sent.message_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    });
  }

  // Wrap side-effect tools with once guard
  if (options.onceGuard) {
    const guard = options.onceGuard;
    for (const name of ONCE_GUARDED_TELEGRAM_TOOLS) {
      const t = tools[name];
      if (t && "execute" in t && typeof t.execute === "function") {
        t.execute = wrapOnce(name, guard, t.execute);
      }
    }
  }

  return tools;
}
