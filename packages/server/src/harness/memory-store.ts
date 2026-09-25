import { randomUUID } from "node:crypto";
import type { HarnessOverride } from "./config/resolve.js";
import {
  emptyProjectRecord,
  type HarnessApprovalRecord,
  type HarnessEventInput,
  type HarnessEventRecord,
  type HarnessProjectPatch,
  type HarnessProjectRecord,
  type HarnessRequestInsert,
  type HarnessRequestPatch,
  type HarnessRequestRecord,
  type HarnessStore,
} from "./store.js";
import { MemoryTopicStore } from "./memory-topic-store.js";

/** In-process store with the same single-consumption semantics; used by tests. */
export class MemoryHarnessStore extends MemoryTopicStore implements HarnessStore {
  readonly projects = new Map<string, HarnessProjectRecord>();
  readonly overrides: HarnessOverride[] = [];
  readonly settings = new Map<string, Record<string, unknown>>();
  readonly events: Array<HarnessEventInput & { deliveryId?: string; createdAt?: Date }> = [];
  readonly approvals = new Map<string, HarnessApprovalRecord>();

  async listProjects() {
    return [...this.projects.values()];
  }

  async upsertProject(key: string, repo: string, patch: HarnessProjectPatch) {
    const now = new Date();
    const current = this.projects.get(key);
    this.projects.set(key, {
      ...emptyProjectRecord(key, repo, now),
      ...current,
      ...patch,
      repo,
      updatedAt: now,
    });
  }

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }

  async putSetting(key: string, value: Record<string, unknown> | null) {
    if (value === null) this.settings.delete(key);
    else this.settings.set(key, value);
  }

  async listOverrides() {
    return [...this.overrides];
  }

  async putOverride(override: HarnessOverride) {
    await this.deleteOverride(override.scope, override.path);
    this.overrides.push(override);
  }

  async deleteOverride(scope: string, path: string) {
    const index = this.overrides.findIndex((o) => o.scope === scope && o.path === path);
    if (index === -1) return false;
    this.overrides.splice(index, 1);
    return true;
  }

  async deleteExpiredOverrides(now: Date) {
    const before = this.overrides.length;
    const kept = this.overrides.filter((o) => o.expiresAt === null || o.expiresAt > now);
    this.overrides.splice(0, this.overrides.length, ...kept);
    return before - kept.length;
  }

  async recordEvent(event: HarnessEventInput) {
    this.events.push({ ...event, createdAt: new Date() });
  }

  async recordDelivery(deliveryId: string, event: HarnessEventInput) {
    if (this.events.some((e) => e.deliveryId === deliveryId)) return false;
    this.events.push({ ...event, deliveryId });
    return true;
  }

  async releaseDelivery(deliveryId: string, error: string) {
    const index = this.events.findIndex((e) => e.deliveryId === deliveryId);
    const event = this.events[index];
    if (!event) return;
    this.events[index] = {
      ...event,
      deliveryId: undefined,
      type: `${event.type}.failed`,
      payload: { ...event.payload, deliveryId, error },
    };
  }

  async findRequestByPr(repo: string, prNumber: number) {
    return (
      [...this.requests.values()].find((r) => r.repo === repo && r.prNumber === prNumber) ?? null
    );
  }

  async findRequestsByHead(repo: string, headSha: string) {
    return [...this.requests.values()].filter((r) => r.repo === repo && r.headSha === headSha);
  }

  async getRequest(id: string) {
    return this.requests.get(id) ?? null;
  }

  async insertRequest(input: HarnessRequestInsert) {
    const now = this.nextCreatedAt();
    const record = {
      issueNumber: null,
      prNumber: null,
      headSha: null,
      title: null,
      riskTier: null,
      summary: null,
      summaryKey: null,
      chatId: null,
      threadId: null,
      cardMessageId: null,
      cardKind: null,
      cardImageUrl: null,
      cardHash: null,
      detailsViewedSha: null,
      bodyEditedAt: null,
      lastPushAt: null,
      createdBy: null,
      ownerText: null,
      areas: null,
      fixRounds: 0,
      lastFixSha: null,
      stateReason: null,
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    } as HarnessRequestRecord;
    this.requests.set(record.id, record);
    return record;
  }

  async updateRequest(id: string, patch: HarnessRequestPatch) {
    const current = this.requests.get(id);
    if (current) this.requests.set(id, { ...current, ...patch, updatedAt: new Date() });
  }

  async countRequests(projectKey: string, states: readonly string[]) {
    return [...this.requests.values()].filter(
      (r) => r.projectKey === projectKey && states.includes(r.state),
    ).length;
  }

  async listProjectRequests(projectKey: string, limit: number) {
    return [...this.requests.values()]
      .filter((r) => r.projectKey === projectKey)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async listRequestEvents(requestId: string, limit: number): Promise<HarnessEventRecord[]> {
    return this.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.requestId === requestId)
      .reverse()
      .slice(0, limit)
      .map(({ event, index }) => ({
        id: index + 1,
        type: event.type,
        projectKey: event.projectKey ?? null,
        requestId: event.requestId ?? null,
        approvalId: event.approvalId ?? null,
        actorId: event.actorId ?? null,
        deliveryId: event.deliveryId ?? null,
        payload: event.payload ?? null,
        createdAt: event.createdAt ?? new Date(0),
      }));
  }

  async createApproval(approval: Omit<HarnessApprovalRecord, "createdAt">) {
    this.approvals.set(approval.id, { ...approval, createdAt: new Date() });
  }

  async getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }

  async findUsableApproval(requestId: string, headSha: string, now: Date, action?: string) {
    return (
      [...this.approvals.values()].find(
        (a) =>
          a.requestId === requestId &&
          a.headSha === headSha &&
          (!action || a.action === action) &&
          !a.consumedAt &&
          !a.invalidatedAt &&
          a.expiresAt > now,
      ) ?? null
    );
  }

  async consumeApproval(id: string, actorId: number, now: Date) {
    const approval = this.approvals.get(id);
    if (!approval || approval.consumedAt || approval.invalidatedAt || approval.expiresAt <= now) {
      return false;
    }
    this.approvals.set(id, { ...approval, consumedAt: now, consumedBy: actorId });
    return true;
  }

  async invalidateApprovals(
    requestId: string,
    reason: string,
    now: Date,
    exceptHeadSha?: string,
    action?: string,
  ) {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.requestId !== requestId || approval.consumedAt || approval.invalidatedAt)
        continue;
      if (exceptHeadSha && approval.headSha === exceptHeadSha) continue;
      if (action && approval.action !== action) continue;
      this.approvals.set(approval.id, { ...approval, invalidatedAt: now, invalidReason: reason });
      count++;
    }
    return count;
  }
}
