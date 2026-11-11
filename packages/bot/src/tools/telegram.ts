import type { ScheduledTaskPort, ScheduledTaskActor } from "@cos-tool-bot/shared";
import { sendScheduledTaskConfirmation } from "../handlers/scheduled-task-confirmation.js";
import type { ConversationCallbacks, TimeoutConfig } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG, MAX_FILE_SIZE } from "@cos-tool-bot/shared";
import { resolveAndValidate } from "@cos-tool-bot/shared/file-validation";
import type { Tool } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { PendingActionRegistry } from "../services/pending-actions.js";
import { editMarkdownMessage } from "../utils/rich-message.js";
import type { OnceGuardContext } from "./utils.js";
import { wrapOnce, zodToAiSchema } from "./utils.js";

export interface ReceivedFile {
  type: "photo" | "document" | "sticker";
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  sticker?: {
    emoji?: string;
    setName?: string;
    type: "regular" | "mask" | "custom_emoji";
    format: "static_webp" | "animated_tgs" | "video_webm";
  };
}

export interface TelegramToolsOptions {
  scheduledTasks?: ScheduledTaskPort;
  scheduledTaskActor?: ScheduledTaskActor;
  api: Api;
  chatId: number;
  userId?: number;
  recentBotMessageIds: number[];
  conversation?: ConversationCallbacks;
  richMessageEnabled?: boolean;
  onTextMessageSent?: (messageId: number, content: string) => void;
  onOwnMessageEdited?: (messageId: number, content: string) => void;
  ttsEndpoint?: string;
  pendingActions?: PendingActionRegistry;
  onTimerFired?: (chatId: number, timerId: string, reason: string) => Promise<void>;
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
    handle: ReturnType<typeof setTimeout>;
  }) => void | Promise<void>;
  onTimerCancel?: (timerId: string) => void | Promise<void>;
  onTimerFiredPersist?: (timerId: string) => Promise<void>;
  onceGuard?: OnceGuardContext;
  dataDir?: string;
  token?: string;
  receivedFiles?: ReceivedFile[];
  timeoutConfig?: TimeoutConfig;
  /**
   * Telegram message IDs the model was actually shown this turn. `reply_to_specific`
   * refuses every other ID, because nothing else in the prompt carries a message ID and
   * a guessed number lands on an unrelated message that Telegram accepts without error.
   * Read lazily so callers can fill the list after the tools are built.
   */
  getReplyableMessageIds?: () => readonly number[];
  /** Legacy stored preference; no longer limits durable task dates. */
  timerMaxSeconds?: number;
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

/**
 * Rejects a reply target the model was never shown. It wraps the tool outside the once
 * guard: a rejected call sends nothing, so the guard must stay free for the corrected retry.
 */
function wrapReplyTargetCheck(
  getReplyable: () => Set<number>,
  /** `any` is needed to match AI SDK's dynamic tool execute signature */
  execute: (...args: any[]) => PromiseLike<any>,
): (...args: any[]) => PromiseLike<any> {
  return async (input: { reply_to_message_id: number }, ...rest: any[]) => {
    const replyable = getReplyable();
    if (replyable.has(input.reply_to_message_id)) return execute(input, ...rest);
    return {
      error: `message_id ${input.reply_to_message_id} 不在你本轮看到的消息里，无法确认它指向哪条消息。只能回复上下文中 [#数字] 标注的消息或你自己刚发出的消息；目标已不在上下文时请直接普通回复。`,
      available_message_ids: [...replyable].sort((a, b) => a - b),
    };
  };
}

const MIN_TIMER_SECONDS = 5;

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

export function createTelegramTools(options: TelegramToolsOptions): Record<string, Tool> {
  const { api, chatId, recentBotMessageIds, dataDir } = options;
  // The shared list survives turns; only newly sent messages are visible through this
  // turn's tool results. Older bot IDs must not make guessed reply targets valid.
  const previousBotMessageIds = new Set(recentBotMessageIds);

  const tools: Record<string, Tool> = {
    send_photo: tool({
      description:
        "发送图片给当前聊天。支持 URL、file_id，或 local:photo.png 发送 data 目录本地文件。可选 has_spoiler 遮罩（NSFW 内容）。",
      inputSchema: zodToAiSchema(
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
      inputSchema: zodToAiSchema(
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
      description: "批量发送多张同类型图片或文档。支持 URL、file_id、local:xxx 来源。最多 10 张。",
      inputSchema: zodToAiSchema(
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
          const mediaType = media[0]!.type;
          if (media.some((item) => item.type !== mediaType)) {
            return { error: "Telegram media groups cannot mix photos and documents" };
          }
          const sent =
            mediaType === "photo"
              ? await api.sendMediaGroup(
                  chatId,
                  await Promise.all(
                    media.map(async (item) => ({
                      type: "photo" as const,
                      media: await resolveInput(item.source, dataDir),
                      caption: item.caption,
                      has_spoiler: item.has_spoiler ?? false,
                    })),
                  ),
                )
              : await api.sendMediaGroup(
                  chatId,
                  await Promise.all(
                    media.map(async (item) => ({
                      type: "document" as const,
                      media: await resolveInput(item.source, dataDir),
                      caption: item.caption,
                    })),
                  ),
                );
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
      inputSchema: zodToAiSchema(
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
              options.userId,
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
      inputSchema: zodToAiSchema(
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
          options.onTextMessageSent?.(sent.message_id, prompt);
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
      inputSchema: zodToAiSchema(
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
        "提出一次性定时任务。配置持久任务服务时发送管理员确认卡，批准后生效；复杂或周期任务使用 propose_scheduled_task。兼容旧服务时到期通知 AI 继续对话。",
      inputSchema: zodToAiSchema(
        z.object({
          seconds: z
            .number()
            .min(MIN_TIMER_SECONDS)
            .describe(`定时秒数，至少 ${MIN_TIMER_SECONDS} 秒；远期计划需要持久化调度`),
          reason: z.string().describe("定时器用途说明，到期后会作为上下文提供给你"),
        }),
      ),
      execute: async ({ seconds, reason }) => {
        try {
          if (
            !Number.isFinite(seconds) ||
            seconds < MIN_TIMER_SECONDS ||
            !Number.isSafeInteger(Math.ceil(seconds * 1000)) ||
            !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())
          ) {
            return { error: "定时秒数必须为有效日期范围内的正数" };
          }
          if (options.scheduledTasks && options.scheduledTaskActor) {
            const actor = options.scheduledTaskActor;
            const task = await options.scheduledTasks.propose(actor, {
              name: reason.slice(0, 80),
              instructions: reason,
              dataScope: { kind: "none" },
              destination: { chatId, threadId: actor.threadId },
              schedule: {
                kind: "once",
                at: new Date(Date.now() + seconds * 1000).toISOString(),
                timezone: "UTC",
              },
              agent: {},
            });
            await sendScheduledTaskConfirmation(api, options.scheduledTasks, actor, task);
            return { task_id: task.id, status: "awaiting_admin_confirmation" };
          }
          if (!options.onTimerCreate && seconds * 1000 > 2_147_483_647)
            return { error: "远期任务需要持久化调度服务" };
          if (!options.pendingActions || !options.onTimerFired) {
            return { error: "Timer features not available" };
          }
          // Register first so timerId is available in the closure
          const pending = options.pendingActions.registerTimer(
            chatId,
            reason,
            // Placeholder handle, replaced below
            setTimeout(() => {}, 0),
            true, // persistent: managed by DB
            seconds * 1000,
          );
          clearTimeout(pending.handle);
          if (options.onTimerCreate) {
            try {
              await options.onTimerCreate({
                timerId: pending.timerId,
                chatId,
                seconds,
                reason,
                handle: pending.handle,
              });
            } catch (error) {
              options.pendingActions.removeTimer(pending.timerId);
              throw error;
            }
          } else {
            const handle = setTimeout(() => {
              const timer = options.pendingActions!.removeTimer(pending.timerId);
              if (timer) {
                void options.onTimerFired!(chatId, timer.timerId, timer.reason)
                  .then(() => options.onTimerFiredPersist?.(timer.timerId))
                  .catch(() => {
                    // Standalone Bot runtimes have no durable scheduler to retry through.
                  });
              }
            }, seconds * 1000);
            handle.unref();
            pending.handle = handle;
          }

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
      inputSchema: zodToAiSchema(
        z.object({
          timer_id: z.string().describe("要取消的定时器 ID"),
        }),
      ),
      execute: async ({ timer_id }) => {
        try {
          if (!options.pendingActions) {
            return { error: "Timer features not available" };
          }
          const pending = options.pendingActions.getTimer(timer_id);
          if (!pending || pending.chatId !== chatId) {
            return { error: "Timer not found or already expired" };
          }
          await options.onTimerCancel?.(timer_id);
          options.pendingActions.removeTimer(timer_id);
          return { success: true, cancelled_timer_id: timer_id };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_dice: tool({
      description: "发送骰子/随机动画 emoji。可用的 emoji: 🎲🎯🏀⚽🎳🎰。趣味互动用。",
      inputSchema: zodToAiSchema(
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
      inputSchema: zodToAiSchema(
        z.object({
          message_id: z.number().describe("要编辑的消息 ID（必须是 bot 自己发的消息）"),
          text: z.string().describe("新的消息内容"),
        }),
      ),
      execute: async ({ message_id, text }) => {
        const visible =
          options.getReplyableMessageIds?.().includes(message_id) ||
          (recentBotMessageIds.includes(message_id) && !previousBotMessageIds.has(message_id));
        if (!visible) return { error: "只能编辑本轮上下文中可见的 bot 消息" };
        let persisted = false;
        try {
          persisted = (await options.conversation?.findOwnMessage?.(chatId, message_id)) ?? false;
          if (!persisted && !recentBotMessageIds.includes(message_id)) {
            return { error: "无法确认消息属于当前 bot 和聊天" };
          }
          try {
            await editMarkdownMessage(
              api,
              chatId,
              message_id,
              text,
              options.richMessageEnabled ?? false,
            );
          } catch (error) {
            const e = error as { error_code?: number; description?: string };
            if (e?.error_code !== 400 || !/message is not modified/i.test(e.description ?? ""))
              throw error;
          }
        } catch (err) {
          return { error: String(err) };
        }
        options.onOwnMessageEdited?.(message_id, text);
        if (persisted) {
          try {
            await options.conversation!.updateOwnMessage!(chatId, message_id, text);
          } catch (err) {
            return {
              success: true,
              history_synced: false,
              error: `Telegram 已修改，历史同步失败；可用相同内容重试同步：${String(err)}`,
            };
          }
        }
        return { success: true, history_synced: true };
      },
    }),

    delete_own_message: tool({
      description: '删除 bot 之前发过的消息。模拟"撤回"效果。只能删除 bot 自己发的消息。',
      inputSchema: zodToAiSchema(
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
      inputSchema: zodToAiSchema(
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
      inputSchema: zodToAiSchema(z.object({})),
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
      description:
        "回复聊天中的某条特定历史消息。目标 ID 只能取自上下文中 [#数字] 标注的消息，或你自己刚发出的消息；不要猜测、推算或沿用其它数字。目标不在上下文里时改用普通回复。",
      inputSchema: zodToAiSchema(
        z.object({
          reply_to_message_id: z
            .number()
            .describe("要回复的目标消息 ID，必须来自上下文中 [#数字] 标注"),
          text: z.string().describe("回复内容"),
        }),
      ),
      execute: async ({ reply_to_message_id, text }) => {
        try {
          const sent = await api.sendMessage(chatId, text, {
            reply_parameters: { message_id: reply_to_message_id },
          });
          recentBotMessageIds.push(sent.message_id);
          options.onTextMessageSent?.(sent.message_id, text);
          return {
            success: true,
            message_id: sent.message_id,
            replied_to_message_id: reply_to_message_id,
          };
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
      inputSchema: zodToAiSchema(
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

  // Conditionally add save_received_file if token and dataDir are available
  if (options.token && dataDir) {
    const token = options.token;
    const receivedFiles = options.receivedFiles ?? [];
    const receivedDir = path.join(dataDir, "received");

    tools.save_received_file = tool({
      description:
        "保存用户发来的文件/图片到 data/received 目录。保存后可用 send_photo/send_document 的 local:received/filename 发送回去。",
      inputSchema: zodToAiSchema(
        z.object({
          index: z.number().optional().describe("附件序号（从0开始），默认0"),
          filename: z.string().describe("保存的文件名，如 photo.jpg、report.pdf"),
        }),
      ),
      execute: async ({ index, filename }) => {
        const idx = index ?? 0;
        if (!receivedFiles.length) return { error: "当前没有收到文件附件" };
        if (idx < 0 || idx >= receivedFiles.length)
          return { error: `无效序号，当前有 ${receivedFiles.length} 个附件` };

        const file = receivedFiles[idx]!;
        const resolved = resolveAndValidate(receivedDir, filename);
        if (!resolved) return { error: "无效文件名或路径" };

        try {
          const tgFile = await api.getFile(file.file_id);
          if (!tgFile.file_path) return { error: "无法获取文件路径" };

          const url = `https://api.telegram.org/file/bot${token}/${tgFile.file_path}`;
          const imageDownloadMs =
            options.timeoutConfig?.imageDownloadMs ?? DEFAULT_TIMEOUT_CONFIG.imageDownloadMs;
          const res = await fetch(url, { signal: AbortSignal.timeout(imageDownloadMs) });
          if (!res.ok) return { error: `下载失败: HTTP ${res.status}` };

          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length > MAX_FILE_SIZE) return { error: "文件过大（超过 20MB）" };

          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, buffer);
          return { ok: true, path: `received/${filename}`, size: buffer.length };
        } catch (err) {
          return { error: `保存失败: ${err instanceof Error ? err.message : String(err)}` };
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

  const replyTool = tools.reply_to_specific;
  if (replyTool && "execute" in replyTool && typeof replyTool.execute === "function") {
    replyTool.execute = wrapReplyTargetCheck(
      () =>
        new Set([
          ...(options.getReplyableMessageIds?.() ?? []),
          ...recentBotMessageIds.filter((id) => !previousBotMessageIds.has(id)),
        ]),
      replyTool.execute,
    );
  }

  return tools;
}
