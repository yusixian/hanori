import type { Database } from "@cos-tool-bot/database";
import { harnessJobs, harnessMessages, harnessRequests } from "@cos-tool-bot/database";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";

type RequestRecord = typeof harnessRequests.$inferSelect;
type RequestPatch = Partial<Omit<RequestRecord, "id" | "createdAt" | "projectKey" | "repo">>;
export type HarnessJobRecord = typeof harnessJobs.$inferSelect;
export type HarnessJobInsert = Omit<
  typeof harnessJobs.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;
export type HarnessJobPatch = Partial<Omit<HarnessJobRecord, "id" | "requestId" | "createdAt">>;
export type HarnessMessageRecord = typeof harnessMessages.$inferSelect;
export type HarnessMessageInsert = Omit<typeof harnessMessages.$inferInsert, "id" | "createdAt">;

/** Request queue, execution jobs, and reply targets for the H3 execution loop. */
export interface HarnessWorkStore {
  findRequestByIssue(repo: string, issueNumber: number): Promise<RequestRecord | null>;
  findRequestByCard(chatId: number, messageId: number): Promise<RequestRecord | null>;
  /** Oldest first, so the queue is FIFO. */
  listRequestsByState(states: readonly string[]): Promise<RequestRecord[]>;
  /** Conditional state change; false when another caller moved the request first. */
  transitionRequest(
    id: string,
    from: readonly string[],
    to: string,
    patch?: RequestPatch,
  ): Promise<boolean>;
  insertJob(job: HarnessJobInsert): Promise<HarnessJobRecord>;
  updateJob(id: string, patch: HarnessJobPatch): Promise<void>;
  latestJob(requestId: string): Promise<HarnessJobRecord | null>;
  listJobs(states: readonly string[]): Promise<HarnessJobRecord[]>;
  countJobsSince(since: Date): Promise<number>;
  recordMessage(message: HarnessMessageInsert): Promise<void>;
  findMessage(chatId: number, messageId: number): Promise<HarnessMessageRecord | null>;
  /** False when no such message was recorded. */
  updateMessageRef(
    chatId: number,
    messageId: number,
    ref: Record<string, unknown>,
  ): Promise<boolean>;
}

export class DrizzleWorkStore implements HarnessWorkStore {
  constructor(protected readonly db: Database) {}

  async findRequestByIssue(repo: string, issueNumber: number) {
    const [row] = await this.db
      .select()
      .from(harnessRequests)
      .where(and(eq(harnessRequests.repo, repo), eq(harnessRequests.issueNumber, issueNumber)))
      .orderBy(desc(harnessRequests.createdAt))
      .limit(1);
    return row ?? null;
  }

  async findRequestByCard(chatId: number, messageId: number) {
    const [row] = await this.db
      .select()
      .from(harnessRequests)
      .where(and(eq(harnessRequests.chatId, chatId), eq(harnessRequests.cardMessageId, messageId)))
      .limit(1);
    return row ?? null;
  }

  async listRequestsByState(states: readonly string[]) {
    if (states.length === 0) return [];
    return this.db
      .select()
      .from(harnessRequests)
      .where(inArray(harnessRequests.state, [...states]))
      .orderBy(asc(harnessRequests.createdAt));
  }

  async transitionRequest(
    id: string,
    from: readonly string[],
    to: string,
    patch: RequestPatch = {},
  ) {
    const rows = await this.db
      .update(harnessRequests)
      .set({ ...patch, state: to, updatedAt: new Date() })
      .where(and(eq(harnessRequests.id, id), inArray(harnessRequests.state, [...from])))
      .returning({ id: harnessRequests.id });
    return rows.length > 0;
  }

  async insertJob(job: HarnessJobInsert) {
    const [row] = await this.db.insert(harnessJobs).values(job).returning();
    return row!;
  }

  async updateJob(id: string, patch: HarnessJobPatch) {
    await this.db
      .update(harnessJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(harnessJobs.id, id));
  }

  async latestJob(requestId: string) {
    const [row] = await this.db
      .select()
      .from(harnessJobs)
      .where(eq(harnessJobs.requestId, requestId))
      .orderBy(desc(harnessJobs.attempt))
      .limit(1);
    return row ?? null;
  }

  async listJobs(states: readonly string[]) {
    if (states.length === 0) return [];
    return this.db
      .select()
      .from(harnessJobs)
      .where(inArray(harnessJobs.state, [...states]));
  }

  async countJobsSince(since: Date) {
    const rows = await this.db
      .select({ id: harnessJobs.id })
      .from(harnessJobs)
      .where(gte(harnessJobs.createdAt, since));
    return rows.length;
  }

  async recordMessage(message: HarnessMessageInsert) {
    await this.db.insert(harnessMessages).values(message).onConflictDoNothing();
  }

  async findMessage(chatId: number, messageId: number) {
    const [row] = await this.db
      .select()
      .from(harnessMessages)
      .where(and(eq(harnessMessages.chatId, chatId), eq(harnessMessages.messageId, messageId)))
      .limit(1);
    return row ?? null;
  }

  async updateMessageRef(chatId: number, messageId: number, ref: Record<string, unknown>) {
    const rows = await this.db
      .update(harnessMessages)
      .set({ ref })
      .where(and(eq(harnessMessages.chatId, chatId), eq(harnessMessages.messageId, messageId)))
      .returning({ id: harnessMessages.id });
    return rows.length > 0;
  }
}
