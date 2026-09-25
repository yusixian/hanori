import { MemoryWorkStore } from "./memory-work-store.js";
import type {
  HarnessTopicMessageInsert,
  HarnessTopicMessageRecord,
  HarnessTopicStore,
  TopicPruneInput,
} from "./topic-store.js";

/** In-process counterpart of DrizzleTopicStore; used by tests. */
export class MemoryTopicStore extends MemoryWorkStore implements HarnessTopicStore {
  topicMessages: HarnessTopicMessageRecord[] = [];
  private topicSequence = 0;

  async appendTopicMessage(message: HarnessTopicMessageInsert) {
    this.topicMessages.push({
      messageId: null,
      suggestions: null,
      suggestionsUsed: 0,
      ...message,
      id: ++this.topicSequence,
      createdAt: this.nextCreatedAt(),
    });
  }

  private inTopic(chatId: number, threadId: number) {
    return this.topicMessages.filter((m) => m.chatId === chatId && m.threadId === threadId);
  }

  async listTopicMessages(chatId: number, threadId: number, limit: number) {
    return this.inTopic(chatId, threadId).slice(-limit);
  }

  async findTopicMessage(chatId: number, messageId: number) {
    return this.topicMessages.find((m) => m.chatId === chatId && m.messageId === messageId) ?? null;
  }

  async useTopicSuggestion(id: number, index: number) {
    const row = this.topicMessages.find((m) => m.id === id);
    const bit = 1 << index;
    if (!row || (row.suggestionsUsed & bit) !== 0) return false;
    row.suggestionsUsed |= bit;
    return true;
  }

  async clearTopic(chatId: number, threadId: number) {
    const before = this.topicMessages.length;
    this.topicMessages = this.topicMessages.filter(
      (m) => !(m.chatId === chatId && m.threadId === threadId),
    );
    return before - this.topicMessages.length;
  }

  async pruneTopicMessages({ chatId, threadId, keep, before }: TopicPruneInput) {
    const rows = this.inTopic(chatId, threadId);
    const dropped = new Set(rows.slice(0, Math.max(0, rows.length - keep)));
    this.topicMessages = this.topicMessages.filter((m) => !dropped.has(m) && m.createdAt >= before);
  }
}
