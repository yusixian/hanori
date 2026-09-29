import type {
  AiReplyBotConfig,
  CosInsideAuditEntry,
  CosInsideCommandConfig,
  CosInsideHistoryEntry,
  CosInsideHistoryFailure,
} from "@cos-tool-bot/bot";
import { type Database, miniAppAuditEvents } from "@cos-tool-bot/database";
import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
import type { DbLogger } from "../db-logger.js";

export interface CosInsideInput {
  botId: string;
  targets: CosInsideCommandConfig["targets"];
  /** The same objects BotManager receives, so hot-applied group overrides stay visible. */
  aiReply: AiReplyBotConfig | undefined;
  conversation: ConversationCallbacks | undefined;
  dbLogger: DbLogger;
  db: Database;
}

export function createCosInsideConfig({
  botId,
  targets,
  aiReply,
  conversation,
  dbLogger,
  db,
}: CosInsideInput): CosInsideCommandConfig | undefined {
  const cosInsideHistory =
    conversation && aiReply
      ? {
          isEnabled: (targetChatId: number) => {
            const targetOverride = aiReply.groupOverrides[String(targetChatId)];
            const conversationConfig = {
              ...DEFAULT_CONVERSATION_CONFIG,
              ...aiReply.conversationConfig,
            };
            return (
              (targetOverride?.enabled ?? true) &&
              (targetOverride?.conversationEnabled ?? conversationConfig.enabled)
            );
          },
          save: async (entry: CosInsideHistoryEntry) => {
            await conversation.addMessage({
              chatId: entry.targetChatId,
              role: "context",
              content: entry.body,
              userId: entry.actorUserId,
              userName: entry.actorName,
              sourceKey: `telegram:${entry.tgMessageId}:cosinside`,
              meta: {
                source: "cosinside",
                initiatorTelegramId: entry.actorUserId,
                initiatorName: entry.actorName,
                tgMessageId: entry.tgMessageId,
                publicGroupHistory: true,
                ...(entry.replyToMessageId === undefined
                  ? {}
                  : { replyToMessageId: entry.replyToMessageId }),
              },
            });
            void Promise.resolve()
              .then(() => conversation.triggerCompression(entry.targetChatId))
              .catch(() =>
                dbLogger.error("cos inside history governance could not be scheduled", {
                  actorUserId: entry.actorUserId,
                  targetChatId: entry.targetChatId,
                  tgMessageId: entry.tgMessageId,
                }),
              );
          },
          onFailure: async (entry: CosInsideHistoryFailure) => {
            await dbLogger.error("cos inside relay history could not be persisted", entry);
          },
        }
      : undefined;
  return targets.length > 0
    ? {
        targets,
        ...(cosInsideHistory ? { history: cosInsideHistory } : {}),
        onAudit: async (entry: CosInsideAuditEntry) => {
          try {
            await db.insert(miniAppAuditEvents).values({
              botId,
              actorTelegramUserId: entry.actorUserId,
              actorRole: "admin",
              capability: "message.relay",
              action: "cos_inside.relay",
              resourceType: "telegram_chat",
              resourceId: String(entry.targetChatId),
              nextSummary: {
                alias: entry.alias,
                bodyLength: entry.bodyLength,
                hasReplyTarget: entry.hasReplyTarget,
                ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
              },
              outcome: entry.outcome,
            });
          } catch (error) {
            // The relay already happened, so this line is the only remaining trace.
            dbLogger.error("cos inside relay audit could not be persisted", {
              actorUserId: entry.actorUserId,
              targetChatId: entry.targetChatId,
              alias: entry.alias,
              bodyLength: entry.bodyLength,
              outcome: entry.outcome,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }
    : undefined;
}
