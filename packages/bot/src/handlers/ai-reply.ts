import type {
  AiGroupOverride,
  AiTriggerConfig,
  BotLogEntry,
  ConversationCallbacks,
  ConversationConfig,
  ConversationRole,
  MemoryCallbacks,
  MemoryConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { generateText } from "@xsai/generate-text";
import type { Tool } from "@xsai/shared-chat";
import type { Api, Middleware } from "grammy";
import type { WrapperContext } from "../context.js";
import { createActionTools, createMemoryTools } from "../tools/index.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { RingBuffer } from "../utils/ring-buffer.js";

export interface AiReplyConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  systemPrompt: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  adminChatIds: number[];
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  stickerPacks?: string[];
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
}

type TriggerResult = "reply" | "mention" | "keyword" | "random" | false;

interface BufferedMessage {
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
}

const MAX_MESSAGE_LENGTH = 4096;
const DEBUG_TRUNCATE_LEN = 500;

function truncate(value: unknown, maxLen = DEBUG_TRUNCATE_LEN): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (!str) return "";
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

const COOLDOWN_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_STALE_MS = 30 * 60 * 1000;

const ACTION_TOOL_NAMES = new Set(["react_to_message", "send_sticker"]);

async function safeReply(ctx: WrapperContext, text: string): Promise<void> {
  try {
    const html = markdownToTelegramHtml(text);
    await ctx.resolveWait(html, "HTML");
  } catch {
    try {
      await ctx.resolveWait(text);
    } catch {
      await ctx.directlyReply(text).catch(() => {});
    }
  }
}

const TOOL_STATUS_MAP: Record<string, string> = {
  get_profile: "🔍 查询用户档案...",
  update_profile: "📝 更新用户档案...",
  search_profiles: "🔎 搜索人物...",
  search_history: "📜 查找历史对话...",
  react_to_message: "💫 添加表情...",
  send_sticker: "🎨 发送贴纸...",
};

function resolveGroupConfig(
  config: AiReplyConfig,
  chatId: number,
): {
  enabled: boolean;
  whitelisted: boolean;
  systemPrompt: string;
  triggerConfig: AiTriggerConfig;
  conversationEnabled: boolean;
  maxContextMessages: number;
} {
  const conversationCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const override = config.groupOverrides[String(chatId)];
  if (!override) {
    return {
      enabled: config.triggerConfig !== undefined,
      whitelisted: false,
      systemPrompt: config.systemPrompt,
      triggerConfig: config.triggerConfig,
      conversationEnabled: conversationCfg.enabled,
      maxContextMessages: conversationCfg.maxContextMessages,
    };
  }
  return {
    enabled: override.enabled ?? true,
    whitelisted: override.whitelisted ?? false,
    systemPrompt: override.systemPrompt ?? config.systemPrompt,
    triggerConfig: { ...config.triggerConfig, ...override.triggerConfig },
    conversationEnabled: override.conversationEnabled ?? conversationCfg.enabled,
    maxContextMessages: override.maxContextMessages ?? conversationCfg.maxContextMessages,
  };
}

function checkTrigger(
  ctx: WrapperContext,
  triggerConfig: AiTriggerConfig,
  chatId: number,
  cooldownMap: Map<number, number>,
): TriggerResult {
  const text = ctx.message?.text ?? "";

  if (triggerConfig.replyToBot && ctx.message?.reply_to_message?.from?.id === ctx.me.id) {
    return "reply";
  }

  if (triggerConfig.mentionBot && ctx.me.username) {
    if (text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)) {
      return "mention";
    }
  }

  if (triggerConfig.triggerWords.length > 0) {
    const lowerText = text.toLowerCase();
    if (triggerConfig.triggerWords.some((w) => lowerText.includes(w.toLowerCase()))) {
      return "keyword";
    }
  }

  if (triggerConfig.randomReplyPercent > 0) {
    const now = Date.now();
    const lastTime = cooldownMap.get(chatId) ?? 0;
    const cooldownMs = triggerConfig.randomReplyCooldown * 1000;
    if (now - lastTime >= cooldownMs) {
      if (Math.random() * 100 < triggerConfig.randomReplyPercent) {
        cooldownMap.set(chatId, now);
        return "random";
      }
    }
  }

  return false;
}

function getUserDisplayName(ctx: WrapperContext): string {
  const from = ctx.from;
  if (!from) return "Unknown";
  if (from.first_name && from.last_name) return `${from.first_name} ${from.last_name}`;
  return from.first_name || from.username || "Unknown";
}

function formatGroupContextMessages(messages: BufferedMessage[]): string {
  return messages.map((m) => `[${m.userName}]: ${m.text}`).join("\n");
}

const MEMORY_SYSTEM_PROMPT = `
你拥有记忆管理工具，可以记住和搜索关于用户的信息。

可用工具:
- get_profile: 获取用户档案（备注、特征、兴趣等）
- update_profile: 更新用户档案（备注会追加，特征和兴趣会合并去重）
- search_profiles: 模糊搜索人物档案
- search_history: 搜索历史对话记录

使用指南:
- 当用户分享个人信息（喜好、工作、名字等）时，主动使用 update_profile 记录
- 当用户问「你还记得…」或需要回忆之前的对话时，使用 search_history
- 不要在每条消息都调用工具，只在有需要时使用
- 不要告诉用户你在使用工具，自然地回复即可
`.trim();

function buildActionToolsPrompt(hasStickerPacks: boolean): string {
  const lines = [
    "你还可以使用以下互动工具:",
    "- react_to_message: 对当前消息添加 emoji 表情回应（如 👍 ❤ 🔥 😂 😢 🎉 🤩 😱 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 等），在觉得合适时自然使用",
  ];
  if (hasStickerPacks) {
    lines.push("- send_sticker: 发送一个贴纸来表达情绪，提供一个 emoji 来匹配合适的贴纸");
  }
  lines.push("注意: 这些工具用于增强互动体验，不要每条消息都使用。");
  lines.push("重要: 无论是否使用了工具，你都必须生成文字回复内容，不要只调用工具而不回复文字。");
  return lines.join("\n");
}

async function loadStickerPacks(
  api: Api,
  packNames: string[],
  cache: Map<string, string[]>,
): Promise<void> {
  for (const name of packNames) {
    try {
      const set = await api.getStickerSet(name);
      for (const sticker of set.stickers) {
        if (sticker.emoji) {
          const existing = cache.get(sticker.emoji);
          if (existing) {
            existing.push(sticker.file_id);
          } else {
            cache.set(sticker.emoji, [sticker.file_id]);
          }
        }
      }
    } catch {
      // ignore invalid sticker pack names
    }
  }
}

export function createAiReplyHandler(config: AiReplyConfig): Middleware<WrapperContext> {
  const cooldownMap = new Map<number, number>();

  // Memory tools setup
  const memoryCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  let memoryTools: Tool[] | undefined;
  if (memoryCfg.enabled && config.memory) {
    memoryTools = createMemoryTools(config.memory);
  }
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    const maxCooldown = config.triggerConfig.randomReplyCooldown * 1000;
    for (const [chatId, lastTime] of cooldownMap) {
      if (now - lastTime > maxCooldown * 2) cooldownMap.delete(chatId);
    }
  }, COOLDOWN_CLEANUP_INTERVAL);
  cleanupTimer.unref();

  // Sticker cache: emoji → file_id[]
  const stickerCache = new Map<string, string[]>();
  let stickerCachePromise: Promise<void> | null = null;

  // Group chat ring buffers
  const conversationCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const groupBuffers = new Map<
    number,
    { buffer: RingBuffer<BufferedMessage>; lastActive: number }
  >();

  const bufferCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of groupBuffers) {
      if (now - entry.lastActive > BUFFER_STALE_MS) groupBuffers.delete(chatId);
    }
  }, BUFFER_CLEANUP_INTERVAL);
  bufferCleanupTimer.unref();

  function getOrCreateBuffer(chatId: number): RingBuffer<BufferedMessage> {
    let entry = groupBuffers.get(chatId);
    if (!entry) {
      entry = {
        buffer: new RingBuffer<BufferedMessage>(conversationCfg.groupBufferSize),
        lastActive: Date.now(),
      };
      groupBuffers.set(chatId, entry);
    } else {
      entry.lastActive = Date.now();
    }
    return entry.buffer;
  }

  return async (ctx, next) => {
    if (!ctx.message?.text) return next();

    // Skip commands
    const entities = ctx.message.entities ?? [];
    if (entities.some((e) => e.type === "bot_command" && e.offset === 0)) {
      return next();
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const isPrivate = ctx.chat?.type === "private";
    const userId = ctx.from?.id;
    if (!userId) return next();

    const isAdmin = config.adminChatIds.includes(userId);
    const userName = getUserDisplayName(ctx);

    // Push to ring buffer for group chats (before trigger check)
    if (!isPrivate) {
      const buffer = getOrCreateBuffer(chatId);
      buffer.push({
        userId,
        userName,
        text: ctx.message.text,
        timestamp: Date.now(),
      });
    }

    let effectivePrompt = config.systemPrompt;
    let triggerResult: TriggerResult = false;
    let groupConversationEnabled = conversationCfg.enabled;
    let groupMaxContext = conversationCfg.maxContextMessages;

    if (isPrivate) {
      if (!isAdmin) return next();
      triggerResult = "reply"; // Private always triggers
    } else {
      const groupCfg = resolveGroupConfig(config, chatId);
      if (!groupCfg.enabled) return next();
      if (!groupCfg.whitelisted && !isAdmin) return next();

      triggerResult = checkTrigger(ctx, groupCfg.triggerConfig, chatId, cooldownMap);
      if (!triggerResult) return next();

      effectivePrompt = groupCfg.systemPrompt;
      groupConversationEnabled = groupCfg.conversationEnabled;
      groupMaxContext = groupCfg.maxContextMessages;
    }

    // Determine if conversation history is enabled
    const useConversation =
      config.conversation && (isPrivate ? conversationCfg.enabled : groupConversationEnabled);

    try {
      await ctx.replyWithChatAction("typing");

      // Lazy-load sticker packs (deduped via shared promise)
      if (!stickerCachePromise && config.stickerPacks?.length) {
        stickerCachePromise = loadStickerPacks(ctx.api, config.stickerPacks, stickerCache);
      }
      if (stickerCachePromise) await stickerCachePromise;

      // Create per-request action tools
      const actionTools = createActionTools({
        api: ctx.api,
        chatId,
        messageId: ctx.message.message_id,
        stickerCache,
      });

      // Build messages array
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
      const historyFormat = conversationCfg.historyFormat ?? "prompt";

      if (useConversation) {
        const maxContext = isPrivate ? conversationCfg.maxContextMessages : groupMaxContext;
        const history = await config.conversation!.getHistory(chatId, maxContext);

        // Collect group context from ring buffer
        let ringBufferContext = "";
        if (!isPrivate) {
          const shouldIncludeContext =
            conversationCfg.groupContextMode === "all" ||
            (conversationCfg.groupContextMode === "random_only" && triggerResult === "random");

          if (shouldIncludeContext) {
            const buffer = groupBuffers.get(chatId);
            if (buffer) {
              const allMessages = buffer.buffer.getAll();
              const contextMessages = allMessages.slice(0, -1);
              if (contextMessages.length > 0) {
                ringBufferContext = formatGroupContextMessages(contextMessages);
              }
            }
          }
        }

        if (historyFormat === "prompt") {
          // Pack everything into system prompt for maximum compatibility
          const parts: string[] = [effectivePrompt];

          if (history.summary) {
            parts.push(`[对话摘要]\n${history.summary}`);
          }

          if (history.messages.length > 0) {
            const historyLines = history.messages.map((msg) => {
              if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
              const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
              return `${prefix}: ${msg.content}`;
            });
            parts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
          }

          if (ringBufferContext) {
            parts.push(`[近期群聊消息]\n${ringBufferContext}`);
          }

          messages.push({ role: "system", content: parts.join("\n\n") });
        } else {
          // Standard multi-turn messages format
          messages.push({ role: "system", content: effectivePrompt });

          if (history.summary) {
            messages.push({ role: "system", content: `[对话摘要] ${history.summary}` });
          }

          for (const msg of history.messages) {
            if (msg.role === "context") {
              messages.push({ role: "system", content: `[近期群聊消息]\n${msg.content}` });
            } else {
              const role = msg.role === "assistant" ? "assistant" : "user";
              const content =
                !isPrivate && msg.userName && msg.role === "user"
                  ? `[${msg.userName}]: ${msg.content}`
                  : msg.content;
              messages.push({ role, content });
            }
          }

          if (ringBufferContext) {
            messages.push({ role: "system", content: `[近期群聊消息]\n${ringBufferContext}` });
          }
        }
      } else {
        messages.push({ role: "system", content: effectivePrompt });
      }

      // Memory system: inject system prompt and auto-read profile
      if (memoryTools && config.memory) {
        // Append memory management instructions to the first system message
        if (messages.length > 0 && messages[0]!.role === "system") {
          messages[0]!.content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
        }

        // Auto-read profile: inject current user profile as context
        if (memoryCfg.autoReadProfile && userId) {
          try {
            const profile = await config.memory.getProfile(userId);
            if (profile) {
              const profileInfo = [
                `Telegram ID: ${profile.telegramId}`,
                profile.displayName && `名称: ${profile.displayName}`,
                profile.username && `用户名: @${profile.username}`,
                profile.notes && `备注: ${profile.notes}`,
                profile.traits?.length && `特征: ${profile.traits.join(", ")}`,
                profile.interests?.length && `兴趣: ${profile.interests.join(", ")}`,
                profile.relationship && `关系: ${profile.relationship}`,
              ]
                .filter(Boolean)
                .join("\n");
              messages.push({
                role: "system",
                content: `[当前对话用户档案]\n${profileInfo}`,
              });
            }
          } catch {
            // ignore profile read errors
          }
        }

        // Auto-update lastSeen
        if (memoryCfg.autoUpdateLastSeen && userId) {
          config.memory.touchProfile(userId, userName, ctx.from?.username).catch(() => {});
        }
      }

      // Inject action tools prompt
      if (messages.length > 0 && messages[0]!.role === "system") {
        const actionPrompt = buildActionToolsPrompt(!!config.stickerPacks?.length);
        messages[0]!.content += `\n\n${actionPrompt}`;
      }

      // Current user message
      const currentContent = !isPrivate ? `[${userName}]: ${ctx.message.text}` : ctx.message.text;
      messages.push({ role: "user", content: currentContent });

      // Combine all tools
      const allTools = [...(memoryTools ?? []), ...actionTools];
      const maxSteps = Math.max(memoryCfg.maxSteps || 3, 2);
      const toolChoice = memoryCfg.toolChoice ?? "auto";

      // Debug: AI request
      const startTime = Date.now();
      config.onLog?.({
        level: "debug",
        message: "AI request",
        meta: {
          model: config.model,
          baseURL: config.baseURL,
          messagesCount: messages.length,
          systemPromptLength: messages[0]?.role === "system" ? messages[0].content.length : 0,
          toolsEnabled: allTools.map((t) => t.function.name),
          maxSteps,
          toolChoice,
          chatId,
          userId,
          userName,
          isPrivate,
          trigger: triggerResult,
        },
      });

      let stepCounter = 0;
      const result = await generateText({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        tools: allTools,
        maxSteps,
        toolChoice,
        onStepFinish: (step) => {
          stepCounter++;
          if (step.toolCalls?.length) {
            const lastTool = step.toolCalls[step.toolCalls.length - 1]!.toolName;
            const status = TOOL_STATUS_MAP[lastTool] ?? `🔧 ${lastTool}...`;
            // First tool call sends the status message; subsequent ones edit it
            if (ctx.waiting_message) {
              ctx.resolveWait(status).catch(() => {});
            } else {
              ctx.wait(status).catch(() => {});
            }

            // Debug: AI tool calls
            for (const tc of step.toolCalls) {
              config.onLog?.({
                level: "debug",
                message: "AI tool call",
                meta: {
                  step: stepCounter,
                  toolName: tc.toolName,
                  args: truncate(tc.args),
                  toolCallId: tc.toolCallId,
                },
              });
            }
          }
          // Debug: AI tool results
          if (step.toolResults?.length) {
            for (const tr of step.toolResults) {
              config.onLog?.({
                level: "debug",
                message: "AI tool result",
                meta: {
                  step: stepCounter,
                  toolName: tr.toolName,
                  result: truncate(tr.result),
                  toolCallId: tr.toolCallId,
                },
              });
            }
          }
        },
      });

      const durationMs = Date.now() - startTime;
      let text = result.text?.trim();

      // Fallback: if text is empty, retry without tools to force text generation
      if (!text) {
        config.onLog?.({
          level: "warn",
          message: "AI returned empty text, retrying without tools",
          meta: {
            chatId,
            userId,
            reasoningText: truncate(result.reasoningText ?? "", 200),
          },
        });
        const retryResult = await generateText({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          model: config.model,
          messages,
          maxSteps: 1,
        });
        text = retryResult.text?.trim();
      }

      // Debug: AI response
      const totalToolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
      const totalToolResults = result.steps.reduce((n, s) => n + s.toolResults.length, 0);
      config.onLog?.({
        level: "debug",
        message: "AI response",
        meta: {
          durationMs,
          responseLength: text?.length ?? 0,
          responsePreview: truncate(text ?? "", 200),
          totalSteps: result.steps.length,
          finishReason: result.finishReason,
          usage: result.usage,
          totalToolCalls,
          totalToolResults,
        },
      });

      // Save messages to conversation history (before checking text emptiness)
      if (useConversation) {
        const toSave: Array<{
          chatId: number;
          role: ConversationRole;
          content: string;
          userId?: number;
          userName?: string;
          meta?: Record<string, unknown>;
        }> = [];

        // Save group context if configured
        if (!isPrivate) {
          const shouldSaveContext =
            conversationCfg.saveGroupContext === "all" ||
            (conversationCfg.saveGroupContext === "random_only" && triggerResult === "random");

          if (shouldSaveContext) {
            const buffer = groupBuffers.get(chatId);
            if (buffer) {
              const allMessages = buffer.buffer.getAll();
              const contextMessages = allMessages.slice(0, -1);
              if (contextMessages.length > 0) {
                toSave.push({
                  chatId,
                  role: "context",
                  content: formatGroupContextMessages(contextMessages),
                });
              }
            }
          }
        }

        // Save user message
        toSave.push({
          chatId,
          role: "user",
          content: ctx.message.text,
          userId,
          userName,
        });

        // Save tool calls and results from steps (skip action tools that don't need history)
        for (const step of result.steps) {
          for (const tc of step.toolCalls) {
            if (ACTION_TOOL_NAMES.has(tc.toolName)) continue;
            toSave.push({
              chatId,
              role: "tool_call",
              content: tc.toolName,
              meta: {
                toolName: tc.toolName,
                args: tc.args,
                toolCallId: tc.toolCallId,
              },
            });
          }
          for (const tr of step.toolResults) {
            if (ACTION_TOOL_NAMES.has(tr.toolName)) continue;
            toSave.push({
              chatId,
              role: "tool_result",
              content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
              meta: {
                toolName: tr.toolName,
                toolCallId: tr.toolCallId,
              },
            });
          }
        }

        // Save assistant reply with usage meta (even if empty text)
        toSave.push({
          chatId,
          role: "assistant",
          content: text || "",
          meta: {
            model: config.model,
            trigger: triggerResult,
            usage: result.usage,
          },
        });

        config.conversation!.addMessages(toSave).catch((err) => {
          config.onLog?.({
            level: "error",
            message: `Failed to save conversation: ${err instanceof Error ? err.message : String(err)}`,
            meta: { chatId },
          });
        });

        // Trigger compression check asynchronously
        config.conversation!.triggerCompression(chatId);
      }

      // Final response: edit the waiting message
      if (text) {
        const replyText =
          text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + "..." : text;
        await safeReply(ctx, replyText);
      } else {
        // Check if any action tools produced visible effects (sticker, reaction)
        const hasVisibleAction = result.steps.some((s) =>
          s.toolCalls.some((tc) => ACTION_TOOL_NAMES.has(tc.toolName)),
        );
        if (hasVisibleAction) {
          await ctx.deleteWaiting();
        } else {
          await safeReply(ctx, "(AI 未生成回复内容)");
        }
      }

      config.onLog?.({
        level: "info",
        message: "AI reply sent",
        meta: {
          chatId,
          userId,
          isPrivate,
          textLength: text?.length ?? 0,
          trigger: triggerResult,
          conversationEnabled: !!useConversation,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      config.onLog?.({
        level: "error",
        message: `AI reply failed: ${errMsg}`,
        meta: { chatId, userId },
      });
      const errorReply = `AI 回复时出错:\n${errMsg}`;
      try {
        await ctx.resolveWait(errorReply);
      } catch {
        await ctx.directlyReply(errorReply).catch(() => {});
      }
    }
  };
}
