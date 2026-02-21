import type { ConversationConfig } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
import { generateText } from "@xsai/generate-text";
import type { Logger } from "pino";
import type { ConversationStore } from "./conversation-store.js";

const SUMMARIZE_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要，保留关键信息和上下文。
如果已有之前的摘要，请将其与新消息合并为一个完整的摘要。
摘要应该用第三人称描述，保留重要的事实、偏好和讨论主题。
请直接输出摘要内容，不要添加额外的解释或标记。`;

interface CompressOptions {
  botId: string;
  chatId: number;
  store: ConversationStore;
  conversationConfig?: ConversationConfig;
  apiKey: string;
  baseURL: string;
  model: string;
  logger: Logger;
}

export async function compressConversation(options: CompressOptions) {
  const { botId, chatId, store, apiKey, baseURL, model, logger } = options;
  const cfg = options.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;

  const messageCount = await store.getMessageCount(botId, chatId);
  if (messageCount <= cfg.summarizeThreshold) return;

  if (cfg.autoSummarize) {
    try {
      await compressWithLLM(botId, chatId, store, cfg, apiKey, baseURL, model);
    } catch (err) {
      logger.warn(
        err,
        `LLM summarization failed for bot=${botId} chat=${chatId}, falling back to sliding window`,
      );
      await store.deleteOldestMessages(botId, chatId, cfg.maxContextMessages);
    }
  } else {
    await store.deleteOldestMessages(botId, chatId, cfg.summarizeThreshold);
  }
}

async function compressWithLLM(
  botId: string,
  chatId: number,
  store: ConversationStore,
  cfg: ConversationConfig,
  apiKey: string,
  baseURL: string,
  model: string,
) {
  const oldMessages = await store.getOldestMessages(botId, chatId, cfg.maxContextMessages);
  if (oldMessages.length === 0) return;

  const { summary: existingSummary } = await store.getHistory(botId, chatId, 0);

  let contextText = "";
  if (existingSummary) {
    contextText += `[已有摘要]\n${existingSummary}\n\n`;
  }
  contextText += "[需要压缩的对话]\n";
  for (const msg of oldMessages) {
    const prefix = msg.role === "assistant" ? "AI" : (msg.userName ?? "User");
    contextText += `${prefix}: ${msg.content}\n`;
  }

  const result = await generateText({
    baseURL,
    apiKey,
    model,
    messages: [
      { role: "system", content: SUMMARIZE_PROMPT },
      { role: "user", content: contextText },
    ],
  });

  const summaryText = result.text?.trim();
  if (!summaryText) return;

  const lastOldId = oldMessages[oldMessages.length - 1]!.id;
  await store.compressMessages(botId, chatId, summaryText, lastOldId, oldMessages.length);
}
