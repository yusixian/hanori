/**
 * ContextAssembler — extracts the prompt assembly logic from ai-reply.ts and continue-chat.ts.
 *
 * Message ordering is optimised for AI provider prefix caching (OpenAI, Anthropic, etc.):
 *   messages[0] — STATIC: systemPrompt + behavioral + data files + memory/tools instructions
 *   messages[1] — DYNAMIC: env info + mood
 *   messages[2…] — DYNAMIC: user profile, bot memories, conversation history
 *
 * All requests sharing the same bot config will have an identical messages[0],
 * allowing the provider to cache that prefix and skip re-processing it.
 */

import { countTokens } from "gpt-tokenizer";
import type {
  AgentToolsConfig,
  BotMemory,
  BotMemoryCallbacks,
  BotMemoryConfig,
  ConversationCallbacks,
  ConversationConfig,
  MemoryCallbacks,
  MemoryConfig,
  MessageConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { getAvailableAgentNames } from "../tools/index.js";
import type { MoodInfo } from "../tools/index.js";
import { type DataFilesConfig, injectDataFiles } from "../utils/data-files.js";
import {
  buildExtendedToolsPrompt,
  type ExtendedToolsPromptOptions,
} from "../utils/tools-prompt.js";

export interface ContextAssemblyInput {
  /** Base system prompt (may be group-specific override) */
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;

  /** Chat environment */
  isPrivate: boolean;
  chatId: number;
  userName: string;
  userUsername?: string;
  chatTitle?: string;

  /** Conversation history */
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  historyFormat?: "prompt" | "messages";
  maxContextMessages: number;

  /** Ring buffer context for group chats */
  ringBufferContext?: string;

  /** Memory system */
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  userId?: number;
  memoryTools?: Record<string, Tool>;

  /** Bot memory */
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  botMemoryTools?: Record<string, Tool>;

  /** Mood state */
  currentMood?: MoodInfo;

  /** Tools prompt config */
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  webTools?: Record<string, Tool>;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  dataFiles?: DataFilesConfig;

  /** Message splitting hint */
  messageConfig?: MessageConfig;
}

export interface AssembledContext {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
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
- 在对话中发现有价值的信息时积极记录，不必等用户要求
- 不要告诉用户你在使用工具，自然地回复即可
`.trim();

const BOT_MEMORY_SYSTEM_PROMPT = `
你拥有长期记忆管理工具，可以保存和检索跨对话持久保存的信息。

可用工具:
- save_memory: 保存一条记忆（通用或关联特定用户）
- recall_memories: 搜索已保存的记忆（支持按关键词、分类、用户过滤）
- delete_memory: 删除不再准确或不再需要的记忆

使用指南:
- 当你学到重要事实、规则或偏好时，使用 save_memory 保存
- 当你需要回忆之前保存的信息时，使用 recall_memories
- 通用记忆（不指定 telegram_id）对所有对话可见
- 用户专属记忆（指定 telegram_id）仅在与该用户对话时可见
- 使用 category 来组织记忆（如 fact、preference、rule、event）
- 学到重要信息时及时保存，不必犹豫
`.trim();

/* ------------------------------------------------------------------ */
/*  Helper: build the static system message content                    */
/* ------------------------------------------------------------------ */

interface StaticPromptInput {
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  isPrivate: boolean;
  dataFiles?: DataFilesConfig;
  memoryTools?: Record<string, Tool>;
  botMemoryTools?: Record<string, Tool>;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  webTools?: Record<string, Tool>;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  messageConfig?: MessageConfig;
}

/**
 * Build the fully-static portion of the system prompt.
 * The result is identical for every request with the same bot config + chat type.
 */
async function buildStaticSystemContent(input: StaticPromptInput): Promise<string> {
  // 1. Base system prompt
  const parts: string[] = [input.systemPrompt];

  // 2. Behavioral prompts
  if (input.behavioralPrompt) parts.push(input.behavioralPrompt);
  if (!input.isPrivate && input.groupBehavioralPrompt) parts.push(input.groupBehavioralPrompt);

  // Join into one block so data-files inject into it
  const msg = { content: parts.join("\n\n") };

  // 3. Data files (IDENTITY.md, SOUL.md, etc.)
  if (input.dataFiles) {
    await injectDataFiles(msg, input.dataFiles);
  }

  // 4. Memory system prompt
  if (input.memoryTools) {
    msg.content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
  }

  // 5. Bot memory system prompt
  if (input.botMemoryTools) {
    msg.content += `\n\n${BOT_MEMORY_SYSTEM_PROMPT}`;
  }

  // 6. Extended tools prompt
  const availableAgents = input.agentToolsConfig?.enabled
    ? getAvailableAgentNames(input.agentToolsConfig, input.webToolsConfig)
    : [];
  const extendedPrompt = buildExtendedToolsPrompt({
    hasStickerPacks: !!input.stickerPacks?.length,
    hasTTS: false,
    hasWebTools: !!input.webToolsConfig?.enabled,
    hasSearchTool: !!input.webTools?.web_search,
    hasImageGeneration: !!input.webToolsConfig?.imageGeneration,
    hasAgentTools: !!input.agentToolsConfig?.enabled,
    availableAgents,
    hasBotMemory: !!input.botMemoryTools,
    hasArtworkTools: !!input.artworkToolsEnabled,
    hasFileTools: !!input.hasFileTools,
    isPrivate: input.isPrivate,
  });
  msg.content += `\n\n${extendedPrompt}`;

  // 7. Message splitting hint
  if ((input.messageConfig?.autoSplitThreshold ?? 0) > 0) {
    msg.content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
  }

  return msg.content;
}

/* ------------------------------------------------------------------ */
/*  Helper: build the dynamic runtime context message                  */
/* ------------------------------------------------------------------ */

function buildDynamicContext(input: {
  isPrivate: boolean;
  userName: string;
  userUsername?: string;
  chatTitle?: string;
  chatId: number;
  currentMood?: MoodInfo;
}): string {
  // Environment info
  let envInfo: string;
  if (input.isPrivate) {
    envInfo = `[System: The user "${input.userName}"${input.userUsername ? ` (@${input.userUsername})` : ""} is chatting with you in a PRIVATE chat.]`;
  } else {
    const chatTitle = input.chatTitle ?? "Unknown";
    envInfo = `[System: The user "${input.userName}"${input.userUsername ? ` (@${input.userUsername})` : ""} is chatting with you in a GROUP CHAT named "${chatTitle}" (chatId: ${input.chatId}).]`;
  }

  // Mood state
  if (input.currentMood) {
    const moodStr = input.currentMood.reason
      ? `[当前情绪: ${input.currentMood.mood}，原因: ${input.currentMood.reason}]`
      : `[当前情绪: ${input.currentMood.mood}]`;
    return `${envInfo}\n\n${moodStr}`;
  }

  return envInfo;
}

/**
 * Assemble context messages for AI generation.
 *
 * Message layout (optimised for prefix caching):
 *   [0] system — static cacheable prefix (same for every request with same bot config)
 *   [1] system — dynamic runtime context (env info + mood)
 *   [2…] system — user profile, bot memories (optional)
 *   [...] conversation history (prompt or messages format)
 */
export async function assembleContext(input: ContextAssemblyInput): Promise<AssembledContext> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const conversationCfg = input.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const historyFormat = input.historyFormat ?? conversationCfg.historyFormat ?? "prompt";
  const memoryCfg = input.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemoryCfg = input.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;

  const useConversation = input.conversation && (input.isPrivate ? conversationCfg.enabled : true);

  // ── messages[0]: STATIC cacheable prefix ──────────────────────────
  const staticContent = await buildStaticSystemContent({
    systemPrompt: input.systemPrompt,
    behavioralPrompt: input.behavioralPrompt,
    groupBehavioralPrompt: input.groupBehavioralPrompt,
    isPrivate: input.isPrivate,
    dataFiles: input.dataFiles,
    memoryTools: input.memoryTools,
    botMemoryTools: input.botMemoryTools,
    stickerPacks: input.stickerPacks,
    webToolsConfig: input.webToolsConfig,
    webTools: input.webTools,
    agentToolsConfig: input.agentToolsConfig,
    artworkToolsEnabled: input.artworkToolsEnabled,
    hasFileTools: input.hasFileTools,
    messageConfig: input.messageConfig,
  });
  messages.push({ role: "system", content: staticContent });

  // ── messages[1]: DYNAMIC runtime context (env info + mood) ────────
  const dynamicContent = buildDynamicContext({
    isPrivate: input.isPrivate,
    userName: input.userName,
    userUsername: input.userUsername,
    chatTitle: input.chatTitle,
    chatId: input.chatId,
    currentMood: input.currentMood,
  });
  messages.push({ role: "system", content: dynamicContent });

  // ── User profile (auto-read) ──────────────────────────────────────
  if (input.memoryTools && input.memory) {
    if (memoryCfg.autoReadProfile && input.userId) {
      try {
        const profile = await input.memory.getProfile(input.userId);
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
    if (memoryCfg.autoUpdateLastSeen && input.userId) {
      input.memory.touchProfile(input.userId, input.userName, input.userUsername).catch(() => {});
    }
  }

  // ── Bot memories (auto-inject) ────────────────────────────────────
  if (input.botMemoryTools && input.botMemory && botMemoryCfg.autoInjectMemories) {
    try {
      const memories = await input.botMemory.getMemoriesForPrompt(
        input.userId,
        botMemoryCfg.maxMemories,
      );
      if (memories.length > 0) {
        const lines = memories.map((m: BotMemory) =>
          m.category ? `- [${m.category}] ${m.content}` : `- ${m.content}`,
        );
        messages.push({ role: "system", content: `[长期记忆]\n${lines.join("\n")}` });
      }
    } catch (err) {
      console.error("Failed to load bot memories for prompt:", err);
    }
  }

  // ── Conversation history ──────────────────────────────────────────
  if (useConversation) {
    const history = await input.conversation!.getHistory(input.chatId, input.maxContextMessages);

    if (historyFormat === "prompt") {
      const historyParts: string[] = [];

      if (history.summary) {
        historyParts.push(`[对话摘要]\n${history.summary}`);
      }

      if (history.messages.length > 0) {
        const historyLines = history.messages.map((msg) => {
          if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
          const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
          return `${prefix}: ${msg.content}`;
        });
        historyParts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
      }

      if (input.ringBufferContext) {
        historyParts.push(`[近期群聊消息]\n${input.ringBufferContext}`);
      }

      if (historyParts.length > 0) {
        messages.push({ role: "system", content: historyParts.join("\n\n") });
      }
    } else {
      // Standard multi-turn messages format
      if (history.summary) {
        messages.push({ role: "system", content: `[对话摘要] ${history.summary}` });
      }

      for (const msg of history.messages) {
        if (msg.role === "context") {
          messages.push({ role: "system", content: `[近期群聊消息]\n${msg.content}` });
        } else {
          const role = msg.role === "assistant" ? "assistant" : "user";
          const content =
            !input.isPrivate && msg.userName && msg.role === "user"
              ? `[${msg.userName}]: ${msg.content}`
              : msg.content;
          messages.push({ role, content });
        }
      }

      if (input.ringBufferContext) {
        messages.push({ role: "system", content: `[近期群聊消息]\n${input.ringBufferContext}` });
      }
    }
  }

  return { messages };
}

/* ------------------------------------------------------------------ */
/*  Prompt Preview (static / lightweight)                             */
/* ------------------------------------------------------------------ */

export interface PromptPreviewInput {
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  isPrivate: boolean;
  memoryEnabled: boolean;
  botMemoryEnabled: boolean;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  dataFiles?: DataFilesConfig;
  messageConfig?: MessageConfig;
}

export interface PromptPreviewResult {
  fullPrompt: string;
  estimatedTokens: number;
}

const PLACEHOLDER_ENV_INFO = "[环境信息: 运行时动态注入 — 用户名、聊天类型等]";
const PLACEHOLDER_PROFILE = "[当前对话用户档案: 运行时动态注入]";
const PLACEHOLDER_MOOD = "[当前情绪: 运行时动态注入]";
const PLACEHOLDER_BOT_MEMORY = "[长期记忆: 运行时动态注入]";
const PLACEHOLDER_HISTORY = "[对话历史: 运行时动态注入]";

/**
 * Assemble a **preview** of the system prompt for the management panel.
 *
 * Reflects the actual message layout used at runtime:
 *   Section 1 — Static cacheable prefix (computed accurately)
 *   Section 2 — Dynamic runtime context (placeholder markers)
 *   Section 3 — Conversation history (placeholder)
 */
export async function assemblePromptPreview(
  input: PromptPreviewInput,
): Promise<PromptPreviewResult> {
  // ── Section 1: Static cacheable prefix ────────────────────────────
  const parts: string[] = [];

  // 1. Base system prompt
  parts.push(input.systemPrompt);

  // 2. Behavioral prompts
  if (input.behavioralPrompt) {
    parts.push(input.behavioralPrompt);
  }
  if (!input.isPrivate && input.groupBehavioralPrompt) {
    parts.push(input.groupBehavioralPrompt);
  }

  // Join into one block so data-files inject into it
  let content = parts.join("\n\n");

  // 3. Data files (real content from disk)
  if (input.dataFiles) {
    const msg = { content };
    await injectDataFiles(msg, input.dataFiles);
    content = msg.content;
  }

  // 4. Memory system prompt
  if (input.memoryEnabled) {
    content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
  }

  // 5. Bot memory system prompt
  if (input.botMemoryEnabled) {
    content += `\n\n${BOT_MEMORY_SYSTEM_PROMPT}`;
  }

  // 6. Extended tools prompt (computed accurately)
  const availableAgents = input.agentToolsConfig?.enabled
    ? getAvailableAgentNames(input.agentToolsConfig, input.webToolsConfig)
    : [];
  const extendedPrompt = buildExtendedToolsPrompt({
    hasStickerPacks: !!input.stickerPacks?.length,
    hasTTS: false,
    hasWebTools: !!input.webToolsConfig?.enabled,
    hasSearchTool: !!input.webToolsConfig?.enabled && !!input.webToolsConfig.search,
    hasImageGeneration: !!input.webToolsConfig?.imageGeneration,
    hasAgentTools: !!input.agentToolsConfig?.enabled,
    availableAgents,
    hasBotMemory: input.botMemoryEnabled,
    hasArtworkTools: !!input.artworkToolsEnabled,
    hasFileTools: !!input.hasFileTools,
    isPrivate: input.isPrivate,
  });
  content += `\n\n${extendedPrompt}`;

  // 7. Message splitting hint
  if ((input.messageConfig?.autoSplitThreshold ?? 0) > 0) {
    content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
  }

  // ── Section 2: Dynamic runtime context ────────────────────────────
  content += `\n\n--- 以下为动态内容（每次请求不同） ---`;
  content += `\n\n${PLACEHOLDER_ENV_INFO}`;
  content += `\n\n${PLACEHOLDER_MOOD}`;

  // Dynamic user profile
  if (input.memoryEnabled) {
    content += `\n\n${PLACEHOLDER_PROFILE}`;
  }

  // Dynamic bot memories
  if (input.botMemoryEnabled) {
    content += `\n\n${PLACEHOLDER_BOT_MEMORY}`;
  }

  // Dynamic conversation history
  content += `\n\n${PLACEHOLDER_HISTORY}`;

  return {
    fullPrompt: content,
    estimatedTokens: countTokens(content),
  };
}

/* ------------------------------------------------------------------ */
/*  Continue-chat context (event-driven)                              */
/* ------------------------------------------------------------------ */

/**
 * Simplified context assembly for continueChat (event-driven continuation).
 * Uses "prompt" historyFormat only and a reduced set of inputs.
 *
 * Same prefix-caching-friendly layout as assembleContext().
 */
export async function assembleContinueChatContext(input: {
  systemPrompt: string;
  behavioralPrompt?: string;
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  chatId: number;
  messageConfig?: MessageConfig;
  moodState: Map<number, MoodInfo>;
  webToolsConfig?: WebToolsConfig;
  webTools?: Record<string, Tool>;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  dataFiles?: DataFilesConfig;
  stickerPacks?: string[];
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
}): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const convCfg = input.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  const botMemCfg = input.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  const isPrivate = input.chatId > 0;

  // ── messages[0]: STATIC cacheable prefix ──────────────────────────
  const staticParts: string[] = [input.systemPrompt];
  if (input.behavioralPrompt) staticParts.push(input.behavioralPrompt);

  const msg = { content: staticParts.join("\n\n") };

  // Data files
  if (input.dataFiles) {
    await injectDataFiles(msg, input.dataFiles);
  }

  // Extended tools prompt
  const availableAgents = input.agentToolsConfig?.enabled
    ? getAvailableAgentNames(input.agentToolsConfig, input.webToolsConfig)
    : [];
  const toolsPromptOpts: ExtendedToolsPromptOptions = {
    hasStickerPacks: !!input.stickerPacks?.length,
    hasTTS: false,
    hasWebTools: !!input.webToolsConfig?.enabled,
    hasSearchTool: !!input.webTools?.web_search,
    hasImageGeneration: !!input.webToolsConfig?.imageGeneration,
    hasAgentTools: !!input.agentToolsConfig?.enabled,
    availableAgents,
    hasBotMemory: !!(botMemCfg.enabled && input.botMemory),
    hasArtworkTools: !!input.artworkToolsEnabled,
    hasFileTools: !!input.hasFileTools,
    isPrivate,
  };
  msg.content += `\n\n${buildExtendedToolsPrompt(toolsPromptOpts)}`;

  // Message splitting hint
  if ((input.messageConfig?.autoSplitThreshold ?? 0) > 0) {
    msg.content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
  }

  messages.push({ role: "system", content: msg.content });

  // ── messages[1]: DYNAMIC runtime context (mood) ───────────────────
  const currentMood = input.moodState.get(input.chatId);
  if (currentMood) {
    const moodStr = currentMood.reason
      ? `[当前情绪: ${currentMood.mood}，原因: ${currentMood.reason}]`
      : `[当前情绪: ${currentMood.mood}]`;
    messages.push({ role: "system", content: moodStr });
  }

  // ── Conversation history ──────────────────────────────────────────
  if (input.conversation && convCfg.enabled) {
    const history = await input.conversation.getHistory(input.chatId, convCfg.maxContextMessages);

    const historyParts: string[] = [];
    if (history.summary) historyParts.push(`[对话摘要]\n${history.summary}`);
    if (history.messages.length > 0) {
      const historyLines = history.messages.map((msg) => {
        if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
        const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
        return `${prefix}: ${msg.content}`;
      });
      historyParts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
    }

    if (historyParts.length > 0) {
      messages.push({ role: "system", content: historyParts.join("\n\n") });
    }
  }

  return messages;
}
