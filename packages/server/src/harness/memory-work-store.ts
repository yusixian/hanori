import { randomUUID } from "node:crypto";
import type { HarnessRequestPatch, HarnessRequestRecord } from "./store.js";
import type {
  HarnessJobInsert,
  HarnessJobPatch,
  HarnessJobRecord,
  HarnessMessageInsert,
  HarnessMessageRecord,
  HarnessWorkStore,
} from "./work-store.js";

const JOB_DEFAULTS = {
  model: null,
  sessionId: null,
  leaseUntil: null,
  sessionStatus: null,
  modelName: null,
  contextUsed: null,
  contextSize: null,
  quota: null,
  startedAt: null,
  lastActivityAt: null,
  nextPollAt: null,
  idleRemindedAt: null,
  runRemindedAt: null,
  endedAt: null,
  error: null,
};

/** In-process counterpart of DrizzleWorkStore; used by tests. */
export class MemoryWorkStore implements HarnessWorkStore {
  readonly requests = new Map<string, HarnessRequestRecord>();
  readonly jobs = new Map<string, HarnessJobRecord>();
  readonly messages: HarnessMessageRecord[] = [];
  private sequence = 0;

  /** Monotonic creation order even when tests freeze the clock. */
  protected nextCreatedAt(): Date {
    return new Date(Date.now() + this.sequence++);
  }

  async findRequestByIssue(repo: string, issueNumber: number) {
    const matches = [...this.requests.values()].filter(
      (r) => r.repo === repo && r.issueNumber === issueNumber,
    );
    return matches.at(-1) ?? null;
  }

  async findRequestByCard(chatId: number, messageId: number) {
    return (
      [...this.requests.values()].find(
        (r) => r.chatId === chatId && r.cardMessageId === messageId,
      ) ?? null
    );
  }

  async listRequestsByState(states: readonly string[]) {
    return [...this.requests.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async transitionRequest(
    id: string,
    from: readonly string[],
    to: string,
    patch: HarnessRequestPatch = {},
  ) {
    const current = this.requests.get(id);
    if (!current || !from.includes(current.state)) return false;
    this.requests.set(id, { ...current, ...patch, state: to, updatedAt: new Date() });
    return true;
  }

  async insertJob(job: HarnessJobInsert) {
    const duplicate = [...this.jobs.values()].some(
      (j) => j.requestId === job.requestId && j.attempt === job.attempt,
    );
    if (duplicate) throw new Error("duplicate job attempt");
    const now = this.nextCreatedAt();
    const record = {
      ...JOB_DEFAULTS,
      ...job,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    } as HarnessJobRecord;
    this.jobs.set(record.id, record);
    return record;
  }

  async updateJob(id: string, patch: HarnessJobPatch) {
    const current = this.jobs.get(id);
    if (current) this.jobs.set(id, { ...current, ...patch, updatedAt: new Date() });
  }

  async latestJob(requestId: string) {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.requestId === requestId)
      .sort((a, b) => a.attempt - b.attempt);
    return jobs.at(-1) ?? null;
  }

  async listJobs(states: readonly string[]) {
    return [...this.jobs.values()].filter((j) => states.includes(j.state));
  }

  async countJobsSince(since: Date) {
    return [...this.jobs.values()].filter((j) => j.createdAt >= since).length;
  }

  async recordMessage(message: HarnessMessageInsert) {
    if (this.messages.some((m) => m.chatId === message.chatId && m.messageId === message.messageId))
      return;
    this.messages.push({
      ref: null,
      ...message,
      id: this.messages.length + 1,
      createdAt: new Date(),
    } as HarnessMessageRecord);
  }

  async findMessage(chatId: number, messageId: number) {
    return this.messages.find((m) => m.chatId === chatId && m.messageId === messageId) ?? null;
  }
}
