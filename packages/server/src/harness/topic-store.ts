import type { Database } from "@cos-tool-bot/database";
import { harnessTopicMessages } from "@cos-tool-bot/database";
import { and, desc, eq, lt, lte, sql } from "drizzle-orm";
import { DrizzleWorkStore } from "./work-store.js";

export type HarnessTopicMessageRecord = typeof harnessTopicMessages.$inferSelect;
export type HarnessTopicMessageInsert = Pick<
  HarnessTopicMessageRecord,
  "chatId" | "threadId" | "role" | "text"
> &
  Partial<Pick<HarnessTopicMessageRecord, "messageId" | "suggestions">>;

export interface TopicPruneInput {
  chatId: number;
  threadId: number;
  /** Rows of this topic beyond the newest `keep` are dropped. */
  keep: number;
  /** Rows of every topic created before this are dropped. */
  before: Date;
}

/** The topic assistant's conversation, keyed by chat and thread (0 for General). */
export interface HarnessTopicStore {
  appendTopicMessage(message: HarnessTopicMessageInsert): Promise<void>;
  /** The newest `limit` messages of a topic, oldest first. */
  listTopicMessages(
    chatId: number,
    threadId: number,
    limit: number,
  ): Promise<HarnessTopicMessageRecord[]>;
  findTopicMessage(chatId: number, messageId: number): Promise<HarnessTopicMessageRecord | null>;
  /** Atomic single use of suggestion `index`; false when it was already used. */
  useTopicSuggestion(id: number, index: number): Promise<boolean>;
  clearTopic(chatId: number, threadId: number): Promise<number>;
  pruneTopicMessages(input: TopicPruneInput): Promise<void>;
}

const t = harnessTopicMessages;
const topic = (chatId: number, threadId: number) =>
  and(eq(t.chatId, chatId), eq(t.threadId, threadId));

export class DrizzleTopicStore extends DrizzleWorkStore implements HarnessTopicStore {
  constructor(db: Database) {
    super(db);
  }

  async appendTopicMessage(message: HarnessTopicMessageInsert) {
    await this.db.insert(t).values({ ...message, createdAt: this.stamp() });
  }

  async listTopicMessages(chatId: number, threadId: number, limit: number) {
    const rows = await this.db
      .select()
      .from(t)
      .where(topic(chatId, threadId))
      .orderBy(desc(t.id))
      .limit(limit);
    return rows.reverse();
  }

  async findTopicMessage(chatId: number, messageId: number) {
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.chatId, chatId), eq(t.messageId, messageId)))
      .limit(1);
    return row ?? null;
  }

  async useTopicSuggestion(id: number, index: number) {
    const bit = 1 << index;
    const rows = await this.db
      .update(t)
      .set({ suggestionsUsed: sql`${t.suggestionsUsed} | ${bit}` })
      .where(and(eq(t.id, id), sql`(${t.suggestionsUsed} & ${bit}) = 0`))
      .returning({ id: t.id });
    return rows.length > 0;
  }

  async clearTopic(chatId: number, threadId: number) {
    const rows = await this.db.delete(t).where(topic(chatId, threadId)).returning({ id: t.id });
    return rows.length;
  }

  async pruneTopicMessages({ chatId, threadId, keep, before }: TopicPruneInput) {
    await this.db.delete(t).where(lt(t.createdAt, before));
    const [cutoff] = await this.db
      .select({ id: t.id })
      .from(t)
      .where(topic(chatId, threadId))
      .orderBy(desc(t.id))
      .offset(keep)
      .limit(1);
    if (cutoff) await this.db.delete(t).where(and(topic(chatId, threadId), lte(t.id, cutoff.id)));
  }
}
