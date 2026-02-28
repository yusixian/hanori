/**
 * ContextAssembler — extracts the prompt assembly logic from ai-reply.ts and continue-chat.ts.
 *
 * Step 1 (current): faithful extraction — same output, structured input.
 * Step 2 (future TODO): structured section tags, context-aware injection, priority trimming.
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
import type { CoreTool } from "ai";
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
  memoryTools?: Record<string, CoreTool>;

  /** Bot memory */
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  botMemoryTools?: Record<string, CoreTool>;

  /** Mood state */
  currentMood?: MoodInfo;

  /** Tools prompt config */
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  webTools?: Record<string, CoreTool>;
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

/**
 * Assemble context messages for AI generation.
 * Faithfully reproduces the logic previously inline in ai-reply.ts.
 */
export async function assembleContext(input: ContextAssemblyInput): Promise<AssembledContext> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const conversationCfg = input.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const historyFormat = input.historyFormat ?? conversationCfg.historyFormat ?? "prompt";
  const memoryCfg = input.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemoryCfg = input.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;

  const useConversation = input.conversation && (input.isPrivate ? conversationCfg.enabled : true);

  if (useConversation) {
    const history = await input.conversation!.getHistory(input.chatId, input.maxContextMessages);

    if (historyFormat === "prompt") {
      // Pack everything into system prompt for maximum compatibility
      const parts: string[] = [input.systemPrompt];

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

      if (input.ringBufferContext) {
        parts.push(`[近期群聊消息]\n${input.ringBufferContext}`);
      }

      messages.push({ role: "system", content: parts.join("\n\n") });
    } else {
      // Standard multi-turn messages format
      messages.push({ role: "system", content: input.systemPrompt });

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
  } else {
    messages.push({ role: "system", content: input.systemPrompt });
  }

  // Inject chat environment context + behavioral prompts into first system message
  if (messages.length > 0 && messages[0]!.role === "system") {
    let envInfo: string;

    if (input.isPrivate) {
      envInfo = `[System: The user "${input.userName}"${input.userUsername ? ` (@${input.userUsername})` : ""} is chatting with you in a PRIVATE chat.]`;
    } else {
      const chatTitle = input.chatTitle ?? "Unknown";
      envInfo = `[System: The user "${input.userName}"${input.userUsername ? ` (@${input.userUsername})` : ""} is chatting with you in a GROUP CHAT named "${chatTitle}" (chatId: ${input.chatId}).]`;
    }

    const suffix = [
      input.behavioralPrompt,
      !input.isPrivate ? input.groupBehavioralPrompt : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

    messages[0]!.content =
      envInfo + "\n\n" + messages[0]!.content + (suffix ? `\n\n${suffix}` : "");
  }

  // Inject /data directory identity files
  if (input.dataFiles && messages.length > 0 && messages[0]!.role === "system") {
    await injectDataFiles(messages[0]!, input.dataFiles);
  }

  // Memory system: inject system prompt and auto-read profile
  if (input.memoryTools && input.memory) {
    if (messages.length > 0 && messages[0]!.role === "system") {
      messages[0]!.content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
    }

    // Auto-read profile
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

  // Inject mood state
  if (input.currentMood && messages.length > 0 && messages[0]!.role === "system") {
    const moodStr = input.currentMood.reason
      ? `[当前情绪: ${input.currentMood.mood}，原因: ${input.currentMood.reason}]`
      : `[当前情绪: ${input.currentMood.mood}]`;
    messages[0]!.content += `\n\n${moodStr}`;
  }

  // Bot memory: inject system prompt and memories
  if (input.botMemoryTools && input.botMemory && botMemoryCfg.autoInjectMemories) {
    if (messages.length > 0 && messages[0]!.role === "system") {
      messages[0]!.content += `\n\n${BOT_MEMORY_SYSTEM_PROMPT}`;
    }
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

  // Inject extended tools prompt
  if (messages.length > 0 && messages[0]!.role === "system") {
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
    messages[0]!.content += `\n\n${extendedPrompt}`;
  }

  // Inject split-friendly writing hint when auto-split is enabled
  if (
    (input.messageConfig?.autoSplitThreshold ?? 0) > 0 &&
    messages.length > 0 &&
    messages[0]!.role === "system"
  ) {
    messages[0]!.content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
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

const PLACEHOLDER_PROFILE = "[当前对话用户档案: 运行时动态注入]";
const PLACEHOLDER_MOOD = "[当前情绪: 运行时动态注入]";
const PLACEHOLDER_BOT_MEMORY = "[长期记忆: 运行时动态注入]";

/**
 * Assemble a **preview** of the system prompt for the management panel.
 *
 * Dynamic-only parts (user profile, mood, bot memories, conversation history)
 * are replaced with placeholder markers. Static parts (data files, tools
 * prompt, behavioural prompts) are computed accurately.
 */
export async function assemblePromptPreview(
  input: PromptPreviewInput,
): Promise<PromptPreviewResult> {
  const parts: string[] = [];

  // 1. Environment info placeholder
  if (input.isPrivate) {
    parts.push('[System: The user "User" is chatting with you in a PRIVATE chat.]');
  } else {
    parts.push(
      '[System: The user "User" is chatting with you in a GROUP CHAT named "Group" (chatId: 0).]',
    );
  }

  // 2. Base system prompt
  parts.push(input.systemPrompt);

  // 3. Behavioral prompts
  if (input.behavioralPrompt) {
    parts.push(input.behavioralPrompt);
  }
  if (!input.isPrivate && input.groupBehavioralPrompt) {
    parts.push(input.groupBehavioralPrompt);
  }

  // Join into one block so data-files inject into it
  let content = parts.join("\n\n");

  // 4. Data files (real content from disk)
  if (input.dataFiles) {
    const msg = { content };
    await injectDataFiles(msg, input.dataFiles);
    content = msg.content;
  }

  // 5. Memory system prompt
  if (input.memoryEnabled) {
    content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
    content += `\n\n${PLACEHOLDER_PROFILE}`;
  }

  // 6. Mood placeholder
  content += `\n\n${PLACEHOLDER_MOOD}`;

  // 7. Bot memory system prompt
  if (input.botMemoryEnabled) {
    content += `\n\n${BOT_MEMORY_SYSTEM_PROMPT}`;
    content += `\n\n${PLACEHOLDER_BOT_MEMORY}`;
  }

  // 8. Extended tools prompt (computed accurately)
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

  // 9. Message splitting hint
  if ((input.messageConfig?.autoSplitThreshold ?? 0) > 0) {
    content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
  }

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
  webTools?: Record<string, CoreTool>;
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

  // Load conversation history if available
  if (input.conversation && convCfg.enabled) {
    const history = await input.conversation.getHistory(input.chatId, convCfg.maxContextMessages);

    const parts: string[] = [input.systemPrompt];
    if (history.summary) parts.push(`[对话摘要]\n${history.summary}`);
    if (history.messages.length > 0) {
      const historyLines = history.messages.map((msg) => {
        if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
        const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
        return `${prefix}: ${msg.content}`;
      });
      parts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
    }

    messages.push({ role: "system", content: parts.join("\n\n") });
  } else {
    messages.push({ role: "system", content: input.systemPrompt });
  }

  // Inject behavioral prompt
  if (input.behavioralPrompt && messages[0]) {
    messages[0].content += `\n\n${input.behavioralPrompt}`;
  }

  // Inject /data directory identity files
  if (input.dataFiles && messages[0]) {
    await injectDataFiles(messages[0], input.dataFiles);
  }

  // Inject split-friendly writing hint
  if ((input.messageConfig?.autoSplitThreshold ?? 0) > 0 && messages[0]) {
    messages[0].content +=
      "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
  }

  // Inject mood
  const currentMood = input.moodState.get(input.chatId);
  if (currentMood && messages[0]) {
    const moodStr = currentMood.reason
      ? `[当前情绪: ${currentMood.mood}，原因: ${currentMood.reason}]`
      : `[当前情绪: ${currentMood.mood}]`;
    messages[0].content += `\n\n${moodStr}`;
  }

  // Inject extended tools prompt
  if (messages[0]) {
    const botMemCfg = input.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
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
      isPrivate: input.chatId > 0,
    };
    messages[0].content += `\n\n${buildExtendedToolsPrompt(toolsPromptOpts)}`;
  }

  return messages;
}
