import type { Database } from "@cos-tool-bot/database";
import {
  harnessApprovals,
  harnessConfigOverrides,
  harnessEvents,
  harnessProjects,
  harnessRequests,
  harnessSettings,
} from "@cos-tool-bot/database";
import { and, desc, eq, gt, inArray, isNull, lte, ne } from "drizzle-orm";
import type { HarnessOverride } from "./config/resolve.js";
import { DrizzleTopicStore, type HarnessTopicStore } from "./topic-store.js";
import type { HarnessWorkStore } from "./work-store.js";

export type HarnessProjectRecord = typeof harnessProjects.$inferSelect;
export type HarnessRequestRecord = typeof harnessRequests.$inferSelect;
export type HarnessApprovalRecord = typeof harnessApprovals.$inferSelect;
export type HarnessEventRecord = typeof harnessEvents.$inferSelect;
export type HarnessProjectPatch = Partial<Omit<HarnessProjectRecord, "key" | "createdAt">>;
export type HarnessRequestInsert = Omit<
  typeof harnessRequests.$inferInsert,
  "createdAt" | "updatedAt"
>;
export type HarnessRequestPatch = Partial<
  Omit<HarnessRequestRecord, "id" | "createdAt" | "projectKey" | "repo">
>;

export function emptyProjectRecord(key: string, repo: string, now: Date): HarnessProjectRecord {
  return {
    key,
    repo,
    chatId: null,
    threadId: null,
    topicError: null,
    installationId: null,
    defaultBranch: null,
    kind: null,
    policy: null,
    policySha: null,
    policyError: null,
    policyFetchedAt: null,
    binding: null,
    policyPatch: null,
    inferredPolicy: null,
    execution: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface HarnessEventInput {
  type: string;
  projectKey?: string | null;
  requestId?: string | null;
  approvalId?: string | null;
  actorId?: number | null;
  payload?: Record<string, unknown>;
}

export interface HarnessStore extends HarnessWorkStore, HarnessTopicStore {
  listProjects(): Promise<HarnessProjectRecord[]>;
  upsertProject(key: string, repo: string, patch: HarnessProjectPatch): Promise<void>;
  getSetting(key: string): Promise<Record<string, unknown> | null>;
  /** `null` removes the setting. */
  putSetting(
    key: string,
    value: Record<string, unknown> | null,
    actorId: number | null,
  ): Promise<void>;
  listOverrides(): Promise<HarnessOverride[]>;
  putOverride(override: HarnessOverride): Promise<void>;
  deleteOverride(scope: string, path: string): Promise<boolean>;
  deleteExpiredOverrides(now: Date): Promise<number>;
  recordEvent(event: HarnessEventInput): Promise<void>;
  /** Returns false when the delivery id was already recorded. */
  recordDelivery(deliveryId: string, event: HarnessEventInput): Promise<boolean>;
  /** Keeps the audit row but frees the delivery id so GitHub's redelivery is processed. */
  releaseDelivery(deliveryId: string, error: string): Promise<void>;
  findRequestByPr(repo: string, prNumber: number): Promise<HarnessRequestRecord | null>;
  findRequestsByHead(repo: string, headSha: string): Promise<HarnessRequestRecord[]>;
  getRequest(id: string): Promise<HarnessRequestRecord | null>;
  insertRequest(input: HarnessRequestInsert): Promise<HarnessRequestRecord>;
  updateRequest(id: string, patch: HarnessRequestPatch): Promise<void>;
  countRequests(projectKey: string, states: readonly string[]): Promise<number>;
  /** Most recently updated first. */
  listProjectRequests(projectKey: string, limit: number): Promise<HarnessRequestRecord[]>;
  /** Newest first. */
  listRequestEvents(requestId: string, limit: number): Promise<HarnessEventRecord[]>;
  createApproval(approval: Omit<HarnessApprovalRecord, "createdAt">): Promise<void>;
  getApproval(id: string): Promise<HarnessApprovalRecord | null>;
  /** `headSha` is the bound revision: a PR head SHA, or `session:<id>` / `queue:<id>` for jobs. */
  findUsableApproval(
    requestId: string,
    headSha: string,
    now: Date,
    action?: string,
  ): Promise<HarnessApprovalRecord | null>;
  /** Atomic single consumption: only one caller can win. */
  consumeApproval(id: string, actorId: number, now: Date): Promise<boolean>;
  invalidateApprovals(
    requestId: string,
    reason: string,
    now: Date,
    exceptHeadSha?: string,
    action?: string,
  ): Promise<number>;
}

export class DrizzleHarnessStore extends DrizzleTopicStore implements HarnessStore {
  constructor(db: Database) {
    super(db);
  }

  listProjects() {
    return this.db.select().from(harnessProjects);
  }

  async upsertProject(key: string, repo: string, patch: HarnessProjectPatch) {
    const now = new Date();
    await this.db
      .insert(harnessProjects)
      .values({ key, ...patch, repo, updatedAt: now })
      .onConflictDoUpdate({ target: harnessProjects.key, set: { ...patch, repo, updatedAt: now } });
  }

  async getSetting(key: string) {
    const [row] = await this.db
      .select({ value: harnessSettings.value })
      .from(harnessSettings)
      .where(eq(harnessSettings.key, key));
    return row?.value ?? null;
  }

  async putSetting(key: string, value: Record<string, unknown> | null, actorId: number | null) {
    if (value === null) {
      await this.db.delete(harnessSettings).where(eq(harnessSettings.key, key));
      return;
    }
    const set = { value, actorId, updatedAt: new Date() };
    await this.db
      .insert(harnessSettings)
      .values({ key, ...set })
      .onConflictDoUpdate({ target: harnessSettings.key, set });
  }

  async listOverrides(): Promise<HarnessOverride[]> {
    const rows = await this.db.select().from(harnessConfigOverrides);
    return rows.map((row) => ({
      scope: row.scope,
      path: row.path,
      value: row.value,
      expiresAt: row.expiresAt,
      actorId: row.actorId,
      updatedAt: row.updatedAt,
    }));
  }

  async putOverride(override: HarnessOverride) {
    const values = {
      value: override.value,
      actorId: override.actorId,
      expiresAt: override.expiresAt,
      updatedAt: override.updatedAt,
    };
    await this.db
      .insert(harnessConfigOverrides)
      .values({ scope: override.scope, path: override.path, ...values })
      .onConflictDoUpdate({
        target: [harnessConfigOverrides.scope, harnessConfigOverrides.path],
        set: values,
      });
  }

  async deleteOverride(scope: string, path: string) {
    const rows = await this.db
      .delete(harnessConfigOverrides)
      .where(and(eq(harnessConfigOverrides.scope, scope), eq(harnessConfigOverrides.path, path)))
      .returning({ id: harnessConfigOverrides.id });
    return rows.length > 0;
  }

  async deleteExpiredOverrides(now: Date) {
    const rows = await this.db
      .delete(harnessConfigOverrides)
      .where(lte(harnessConfigOverrides.expiresAt, now))
      .returning({ id: harnessConfigOverrides.id });
    return rows.length;
  }

  async recordEvent(event: HarnessEventInput) {
    await this.db.insert(harnessEvents).values(event);
  }

  async recordDelivery(deliveryId: string, event: HarnessEventInput) {
    const rows = await this.db
      .insert(harnessEvents)
      .values({ ...event, deliveryId })
      .onConflictDoNothing({ target: harnessEvents.deliveryId })
      .returning({ id: harnessEvents.id });
    return rows.length > 0;
  }

  async releaseDelivery(deliveryId: string, error: string) {
    const [row] = await this.db
      .select({ type: harnessEvents.type, payload: harnessEvents.payload })
      .from(harnessEvents)
      .where(eq(harnessEvents.deliveryId, deliveryId));
    if (!row) return;
    await this.db
      .update(harnessEvents)
      .set({
        deliveryId: null,
        type: `${row.type}.failed`,
        payload: { ...row.payload, deliveryId, error },
      })
      .where(eq(harnessEvents.deliveryId, deliveryId));
  }

  async findRequestByPr(repo: string, prNumber: number) {
    const [row] = await this.db
      .select()
      .from(harnessRequests)
      .where(and(eq(harnessRequests.repo, repo), eq(harnessRequests.prNumber, prNumber)));
    return row ?? null;
  }

  findRequestsByHead(repo: string, headSha: string) {
    return this.db
      .select()
      .from(harnessRequests)
      .where(and(eq(harnessRequests.repo, repo), eq(harnessRequests.headSha, headSha)));
  }

  async getRequest(id: string) {
    const [row] = await this.db.select().from(harnessRequests).where(eq(harnessRequests.id, id));
    return row ?? null;
  }

  async insertRequest(input: HarnessRequestInsert) {
    const [row] = await this.db.insert(harnessRequests).values(input).returning();
    return row!;
  }

  async updateRequest(id: string, patch: HarnessRequestPatch) {
    await this.db
      .update(harnessRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(harnessRequests.id, id));
  }

  async countRequests(projectKey: string, states: readonly string[]) {
    if (states.length === 0) return 0;
    const rows = await this.db
      .select({ id: harnessRequests.id })
      .from(harnessRequests)
      .where(
        and(
          eq(harnessRequests.projectKey, projectKey),
          inArray(harnessRequests.state, [...states]),
        ),
      );
    return rows.length;
  }

  listProjectRequests(projectKey: string, limit: number) {
    return this.db
      .select()
      .from(harnessRequests)
      .where(eq(harnessRequests.projectKey, projectKey))
      .orderBy(desc(harnessRequests.updatedAt))
      .limit(limit);
  }

  listRequestEvents(requestId: string, limit: number) {
    return this.db
      .select()
      .from(harnessEvents)
      .where(eq(harnessEvents.requestId, requestId))
      .orderBy(desc(harnessEvents.id))
      .limit(limit);
  }

  async createApproval(approval: Omit<HarnessApprovalRecord, "createdAt">) {
    await this.db.insert(harnessApprovals).values(approval);
  }

  async getApproval(id: string) {
    const [row] = await this.db.select().from(harnessApprovals).where(eq(harnessApprovals.id, id));
    return row ?? null;
  }

  async findUsableApproval(requestId: string, headSha: string, now: Date, action?: string) {
    const [row] = await this.db
      .select()
      .from(harnessApprovals)
      .where(
        and(
          eq(harnessApprovals.requestId, requestId),
          eq(harnessApprovals.headSha, headSha),
          action ? eq(harnessApprovals.action, action) : undefined,
          isNull(harnessApprovals.consumedAt),
          isNull(harnessApprovals.invalidatedAt),
          gt(harnessApprovals.expiresAt, now),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async consumeApproval(id: string, actorId: number, now: Date) {
    const rows = await this.db
      .update(harnessApprovals)
      .set({ consumedAt: now, consumedBy: actorId })
      .where(
        and(
          eq(harnessApprovals.id, id),
          isNull(harnessApprovals.consumedAt),
          isNull(harnessApprovals.invalidatedAt),
          gt(harnessApprovals.expiresAt, now),
        ),
      )
      .returning({ id: harnessApprovals.id });
    return rows.length > 0;
  }

  async invalidateApprovals(
    requestId: string,
    reason: string,
    now: Date,
    exceptHeadSha?: string,
    action?: string,
  ) {
    const rows = await this.db
      .update(harnessApprovals)
      .set({ invalidatedAt: now, invalidReason: reason })
      .where(
        and(
          eq(harnessApprovals.requestId, requestId),
          isNull(harnessApprovals.consumedAt),
          isNull(harnessApprovals.invalidatedAt),
          exceptHeadSha ? ne(harnessApprovals.headSha, exceptHeadSha) : undefined,
          action ? eq(harnessApprovals.action, action) : undefined,
        ),
      )
      .returning({ id: harnessApprovals.id });
    return rows.length;
  }
}
