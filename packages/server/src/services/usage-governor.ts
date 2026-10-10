import { randomUUID } from "node:crypto";
import {
  DEFAULT_USAGE_RESERVATION_TTL_MS,
  DEFAULT_USAGE_TIMEZONE,
  findRelaxedUsageLimits,
  getUsageScopeSubjects,
  resolveUsageLimits,
  USAGE_DETAIL_RETENTION_DAYS,
  validateUsageLimits,
  type UsageAdmissionRequest,
  type UsageBucketCharge,
  type UsageDenied,
  type UsageLimits,
  type UsagePolicy,
  type UsageReserveResult,
  type UsageResource,
  type UsageSnapshot,
  type UsageSnapshotRequest,
  type UsageScopeSubject,
} from "@cos-tool-bot/shared";
import {
  usageGovernanceBuckets,
  usageGovernanceEvents,
  usageGovernancePolicies,
  usageGovernanceReservations,
  imageGenerationConfigs,
  type Database,
} from "@cos-tool-bot/database";
import { and, eq, gt, gte, lt, lte, ne, sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export type UsageReservationStatus = "reserved" | "settled" | "refunded";

export interface UsageReservationRecord {
  id: string;
  botId: string;
  resource: UsageResource;
  chatKind: "private" | "group";
  chatId: number | null;
  userId: number | null;
  reservedUnits: number;
  settledUnits: number | null;
  status: UsageReservationStatus;
  bucketCharges: UsageBucketCharge[];
  reservedAt: Date;
  expiresAt: Date;
}

export interface RecentUsageEntry {
  units: number;
  reservedAt: Date;
}

interface DurablePeriod {
  window: "day" | "month";
  windowKey: string;
  closesAt: Date;
  retentionUntil: Date;
}

export interface UsageGovernanceTransaction {
  lock(botId: string, resource: UsageResource): Promise<void>;
  listPolicies(botId: string, resource: UsageResource): Promise<UsagePolicy[]>;
  listRecentUsage(input: {
    botId: string;
    resource: UsageResource;
    subject: UsageScopeSubject;
    since: Date;
  }): Promise<RecentUsageEntry[]>;
  countActive(input: {
    botId: string;
    resource: UsageResource;
    subject: UsageScopeSubject;
    now: Date;
  }): Promise<number>;
  getBucket(input: {
    botId: string;
    resource: UsageResource;
    charge: Omit<UsageBucketCharge, "units">;
  }): Promise<number>;
  insertReservation(record: UsageReservationRecord): Promise<void>;
  adjustBuckets(input: {
    botId: string;
    resource: UsageResource;
    charges: readonly UsageBucketCharge[];
    deltaSign: 1 | -1;
    periods?: readonly DurablePeriod[];
    now: Date;
  }): Promise<void>;
  appendEvent(input: {
    reservationId: string;
    botId: string;
    resource: UsageResource;
    eventType: "reserved" | "settled" | "refunded";
    units: number;
    createdAt: Date;
  }): Promise<void>;
  getReservationForUpdate(id: string): Promise<UsageReservationRecord | null>;
  updateReservation(input: {
    id: string;
    status: Exclude<UsageReservationStatus, "reserved">;
    settledUnits: number | null;
    now: Date;
  }): Promise<void>;
  upsertPolicy(
    input: UsagePolicy & {
      botId: string;
      updatedByKind: "owner" | "group_admin" | "system";
      updatedById?: string;
      now: Date;
    },
  ): Promise<void>;
  listExpiredReservations(
    now: Date,
  ): Promise<Array<{ id: string; botId: string; resource: UsageResource }>>;
  prune(input: { detailCutoff: Date; bucketCutoff: Date }): Promise<void>;
}

export interface UsageGovernanceRepository {
  transaction<T>(operation: (tx: UsageGovernanceTransaction) => Promise<T>): Promise<T>;
}

export class UsageGovernanceError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "INVALID_LIMITS"
      | "POLICY_RELAXES_CEILING"
      | "POLICY_SCOPE_FORBIDDEN"
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_OWNERSHIP_MISMATCH"
      | "SETTLEMENT_EXCEEDS_RESERVATION",
  ) {
    super(code);
    this.name = "UsageGovernanceError";
  }
}

function isSafeTelegramId(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value !== 0);
}

function validateAdmission(input: UsageAdmissionRequest): {
  units: number;
  now: Date;
  reservationTtlMs: number;
} {
  const units = input.units ?? 1;
  const reservationTtlMs = input.reservationTtlMs ?? DEFAULT_USAGE_RESERVATION_TTL_MS;
  const now = input.now ?? new Date();
  if (
    !input.botId ||
    !Number.isSafeInteger(units) ||
    units <= 0 ||
    !Number.isSafeInteger(reservationTtlMs) ||
    reservationTtlMs <= 0 ||
    reservationTtlMs > MAX_RESERVATION_TTL_MS ||
    !isSafeTelegramId(input.chatId) ||
    !isSafeTelegramId(input.userId) ||
    (input.userId !== undefined && input.userId < 0) ||
    (input.chatKind === "group" && input.chatId === undefined)
  ) {
    throw new UsageGovernanceError("INVALID_REQUEST");
  }
  if (Number.isNaN(now.getTime())) throw new UsageGovernanceError("INVALID_REQUEST");
  return { units, now, reservationTtlMs };
}

function scopeCondition(subject: UsageScopeSubject, table: typeof usageGovernanceReservations) {
  if (subject.scope === "bot") return sql`true`;
  if (subject.scope === "chat") return eq(table.chatId, Number(subject.subjectKey));
  if (subject.scope === "user_global") return eq(table.userId, Number(subject.subjectKey));
  const [chatId, userId] = subject.subjectKey.split(":").map(Number);
  return and(eq(table.chatId, chatId!), eq(table.userId, userId!))!;
}

function usageUnitsSql() {
  return sql<number>`case when ${usageGovernanceReservations.status} = 'settled' then coalesce(${usageGovernanceReservations.settledUnits}, ${usageGovernanceReservations.reservedUnits}) else ${usageGovernanceReservations.reservedUnits} end`;
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

class DrizzleUsageGovernanceTransaction implements UsageGovernanceTransaction {
  constructor(private readonly tx: DatabaseTransaction) {}

  async lock(botId: string, resource: UsageResource): Promise<void> {
    await this.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${botId}:${resource}`}, 0))`,
    );
  }

  async listPolicies(botId: string, resource: UsageResource): Promise<UsagePolicy[]> {
    const rows = await this.tx
      .select({
        resource: usageGovernancePolicies.resource,
        scope: usageGovernancePolicies.scope,
        subjectKey: usageGovernancePolicies.subjectKey,
        limits: usageGovernancePolicies.limits,
      })
      .from(usageGovernancePolicies)
      .where(
        and(
          eq(usageGovernancePolicies.botId, botId),
          eq(usageGovernancePolicies.resource, resource),
        ),
      );
    return rows as UsagePolicy[];
  }

  async listRecentUsage(input: {
    botId: string;
    resource: UsageResource;
    subject: UsageScopeSubject;
    since: Date;
  }): Promise<RecentUsageEntry[]> {
    return this.tx
      .select({ units: usageUnitsSql(), reservedAt: usageGovernanceReservations.reservedAt })
      .from(usageGovernanceReservations)
      .where(
        and(
          eq(usageGovernanceReservations.botId, input.botId),
          eq(usageGovernanceReservations.resource, input.resource),
          ne(usageGovernanceReservations.status, "refunded"),
          gte(usageGovernanceReservations.reservedAt, input.since),
          scopeCondition(input.subject, usageGovernanceReservations),
        ),
      )
      .orderBy(usageGovernanceReservations.reservedAt);
  }

  async countActive(input: {
    botId: string;
    resource: UsageResource;
    subject: UsageScopeSubject;
    now: Date;
  }): Promise<number> {
    const [row] = await this.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(usageGovernanceReservations)
      .where(
        and(
          eq(usageGovernanceReservations.botId, input.botId),
          eq(usageGovernanceReservations.resource, input.resource),
          eq(usageGovernanceReservations.status, "reserved"),
          gt(usageGovernanceReservations.expiresAt, input.now),
          scopeCondition(input.subject, usageGovernanceReservations),
        ),
      );
    return row?.count ?? 0;
  }

  async getBucket(input: {
    botId: string;
    resource: UsageResource;
    charge: Omit<UsageBucketCharge, "units">;
  }): Promise<number> {
    const [row] = await this.tx
      .select({ usedUnits: usageGovernanceBuckets.usedUnits })
      .from(usageGovernanceBuckets)
      .where(
        and(
          eq(usageGovernanceBuckets.botId, input.botId),
          eq(usageGovernanceBuckets.resource, input.resource),
          eq(usageGovernanceBuckets.scope, input.charge.scope),
          eq(usageGovernanceBuckets.subjectKey, input.charge.subjectKey),
          eq(usageGovernanceBuckets.window, input.charge.window),
          eq(usageGovernanceBuckets.windowKey, input.charge.windowKey),
          eq(usageGovernanceBuckets.timezone, input.charge.timezone),
        ),
      )
      .limit(1);
    return row?.usedUnits ?? 0;
  }

  async insertReservation(record: UsageReservationRecord): Promise<void> {
    await this.tx.insert(usageGovernanceReservations).values(record);
  }

  async adjustBuckets(input: {
    botId: string;
    resource: UsageResource;
    charges: readonly UsageBucketCharge[];
    deltaSign: 1 | -1;
    periods?: readonly DurablePeriod[];
    now: Date;
  }): Promise<void> {
    for (const charge of input.charges) {
      const period = input.periods?.find(
        (candidate) =>
          candidate.window === charge.window && candidate.windowKey === charge.windowKey,
      );
      if (input.deltaSign === 1) {
        if (!period) throw new Error(`Missing period metadata for ${charge.window}`);
        await this.tx
          .insert(usageGovernanceBuckets)
          .values({
            botId: input.botId,
            resource: input.resource,
            ...charge,
            usedUnits: charge.units,
            closesAt: period.closesAt,
            retentionUntil: period.retentionUntil,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [
              usageGovernanceBuckets.botId,
              usageGovernanceBuckets.resource,
              usageGovernanceBuckets.scope,
              usageGovernanceBuckets.subjectKey,
              usageGovernanceBuckets.window,
              usageGovernanceBuckets.windowKey,
              usageGovernanceBuckets.timezone,
            ],
            set: {
              usedUnits: sql`${usageGovernanceBuckets.usedUnits} + ${charge.units}`,
              updatedAt: input.now,
            },
          });
      } else {
        await this.tx
          .update(usageGovernanceBuckets)
          .set({
            usedUnits: sql`greatest(0, ${usageGovernanceBuckets.usedUnits} - ${charge.units})`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(usageGovernanceBuckets.botId, input.botId),
              eq(usageGovernanceBuckets.resource, input.resource),
              eq(usageGovernanceBuckets.scope, charge.scope),
              eq(usageGovernanceBuckets.subjectKey, charge.subjectKey),
              eq(usageGovernanceBuckets.window, charge.window),
              eq(usageGovernanceBuckets.windowKey, charge.windowKey),
              eq(usageGovernanceBuckets.timezone, charge.timezone),
            ),
          );
      }
    }
  }

  async appendEvent(input: {
    reservationId: string;
    botId: string;
    resource: UsageResource;
    eventType: "reserved" | "settled" | "refunded";
    units: number;
    createdAt: Date;
  }): Promise<void> {
    await this.tx.insert(usageGovernanceEvents).values(input);
  }

  async getReservationForUpdate(id: string): Promise<UsageReservationRecord | null> {
    const [row] = await this.tx
      .select()
      .from(usageGovernanceReservations)
      .where(eq(usageGovernanceReservations.id, id))
      .limit(1)
      .for("update");
    return (row as UsageReservationRecord | undefined) ?? null;
  }

  async updateReservation(input: {
    id: string;
    status: "settled" | "refunded";
    settledUnits: number | null;
    now: Date;
  }): Promise<void> {
    await this.tx
      .update(usageGovernanceReservations)
      .set({
        status: input.status,
        settledUnits: input.settledUnits,
        settledAt: input.status === "settled" ? input.now : null,
        refundedAt: input.status === "refunded" ? input.now : null,
      })
      .where(eq(usageGovernanceReservations.id, input.id));
  }

  async upsertPolicy(
    input: UsagePolicy & {
      botId: string;
      updatedByKind: "owner" | "group_admin" | "system";
      updatedById?: string;
      now: Date;
    },
  ): Promise<void> {
    await this.tx
      .insert(usageGovernancePolicies)
      .values(input)
      .onConflictDoUpdate({
        target: [
          usageGovernancePolicies.botId,
          usageGovernancePolicies.resource,
          usageGovernancePolicies.scope,
          usageGovernancePolicies.subjectKey,
        ],
        set: {
          limits: input.limits,
          updatedByKind: input.updatedByKind,
          updatedById: input.updatedById,
          updatedAt: input.now,
        },
      });
  }

  async listExpiredReservations(
    now: Date,
  ): Promise<Array<{ id: string; botId: string; resource: UsageResource }>> {
    return this.tx
      .select({
        id: usageGovernanceReservations.id,
        botId: usageGovernanceReservations.botId,
        resource: usageGovernanceReservations.resource,
      })
      .from(usageGovernanceReservations)
      .where(
        and(
          eq(usageGovernanceReservations.status, "reserved"),
          lte(usageGovernanceReservations.expiresAt, now),
        ),
      ) as Promise<Array<{ id: string; botId: string; resource: UsageResource }>>;
  }

  async prune(input: { detailCutoff: Date; bucketCutoff: Date }): Promise<void> {
    await this.tx
      .delete(usageGovernanceEvents)
      .where(lt(usageGovernanceEvents.createdAt, input.detailCutoff));
    await this.tx
      .delete(usageGovernanceReservations)
      .where(
        and(
          ne(usageGovernanceReservations.status, "reserved"),
          lt(usageGovernanceReservations.reservedAt, input.detailCutoff),
        ),
      );
    await this.tx
      .delete(usageGovernanceBuckets)
      .where(lt(usageGovernanceBuckets.retentionUntil, input.bucketCutoff));
  }
}

class DrizzleUsageGovernanceRepository implements UsageGovernanceRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(operation: (tx: UsageGovernanceTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => operation(new DrizzleUsageGovernanceTransaction(tx)));
  }
}

function isRepository(
  source: Database | UsageGovernanceRepository,
): source is UsageGovernanceRepository {
  return !("select" in source);
}

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedParts(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts["year"]!,
    month: parts["month"]!,
    day: parts["day"]!,
    hour: parts["hour"]!,
    minute: parts["minute"]!,
    second: parts["second"]!,
  };
}

function localTimeToUtc(
  target: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timezone: string,
): Date {
  const targetEpoch = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let guess = targetEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualEpoch = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = targetEpoch - actualEpoch;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function durablePeriod(at: Date, timezone: string, window: "day" | "month"): DurablePeriod {
  const local = zonedParts(at, timezone);
  const key =
    window === "day"
      ? `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`
      : `${local.year}-${String(local.month).padStart(2, "0")}`;
  const normalizedNext = new Date(
    Date.UTC(
      local.year,
      local.month - 1 + (window === "month" ? 1 : 0),
      local.day + (window === "day" ? 1 : 0),
    ),
  );
  const closesAt = localTimeToUtc(
    {
      year: normalizedNext.getUTCFullYear(),
      month: normalizedNext.getUTCMonth() + 1,
      day: window === "month" ? 1 : normalizedNext.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timezone,
  );
  return {
    window,
    windowKey: key,
    closesAt,
    retentionUntil: new Date(closesAt.getTime() + USAGE_DETAIL_RETENTION_DAYS * DAY_MS),
  };
}

function sumUsage(entries: readonly RecentUsageEntry[]): number {
  return entries.reduce((total, entry) => total + entry.units, 0);
}

function slidingRetryAt(
  entries: readonly RecentUsageEntry[],
  limit: number,
  units: number,
  windowMs: number,
): Date | undefined {
  let used = sumUsage(entries);
  for (const entry of entries) {
    used -= entry.units;
    if (used + units <= limit) return new Date(entry.reservedAt.getTime() + windowMs);
  }
  return undefined;
}

export class UsageGovernor {
  private readonly repository: UsageGovernanceRepository;
  private readonly resolveTimezone: (botId: string) => Promise<string>;

  constructor(source: Database | UsageGovernanceRepository, timezone = DEFAULT_USAGE_TIMEZONE) {
    // Throws early for invalid configured IANA zones instead of silently using server local time.
    formatter(timezone).format(new Date(0));
    if (isRepository(source)) {
      this.repository = source;
      this.resolveTimezone = async () => timezone;
    } else {
      this.repository = new DrizzleUsageGovernanceRepository(source);
      this.resolveTimezone = async (botId) => {
        const [row] = await source
          .select({ config: imageGenerationConfigs.config })
          .from(imageGenerationConfigs)
          .where(eq(imageGenerationConfigs.botId, botId))
          .limit(1);
        const configured = row?.config.timezone ?? timezone;
        formatter(configured).format(new Date(0));
        return configured;
      };
    }
  }

  async reserve(input: UsageAdmissionRequest): Promise<UsageReserveResult> {
    const { units, now, reservationTtlMs } = validateAdmission(input);
    const subjects = getUsageScopeSubjects(input);
    const timezone = await this.resolveTimezone(input.botId);
    const periods = [durablePeriod(now, timezone, "day"), durablePeriod(now, timezone, "month")];

    return this.repository.transaction(async (tx) => {
      await tx.lock(input.botId, input.resource);
      const policies = await tx.listPolicies(input.botId, input.resource);
      const charges: UsageBucketCharge[] = [];

      for (const subject of subjects) {
        const limits = resolveUsageLimits(input.resource, subject, input.chatKind, policies);
        if (!limits) continue;
        if (validateUsageLimits(limits).length > 0)
          throw new UsageGovernanceError("INVALID_LIMITS");

        if (limits.maxConcurrent !== undefined) {
          const used = await tx.countActive({
            botId: input.botId,
            resource: input.resource,
            subject,
            now,
          });
          if (used + 1 > limits.maxConcurrent) {
            return {
              allowed: false,
              reason: "concurrency",
              ...subject,
              limit: limits.maxConcurrent,
              used,
            } satisfies UsageDenied;
          }
        }

        if (limits.cooldownMs !== undefined && limits.cooldownMs > 0) {
          const entries = await tx.listRecentUsage({
            botId: input.botId,
            resource: input.resource,
            subject,
            since: new Date(now.getTime() - limits.cooldownMs),
          });
          const latest = entries.at(-1);
          if (latest) {
            return {
              allowed: false,
              reason: "cooldown",
              ...subject,
              limit: limits.cooldownMs,
              used: 1,
              retryAt: new Date(latest.reservedAt.getTime() + limits.cooldownMs),
            } satisfies UsageDenied;
          }
        }

        for (const [window, windowMs] of [
          ["minute", 60_000],
          ["hour", 60 * 60_000],
        ] as const) {
          const limit = limits[window];
          if (limit === undefined) continue;
          const entries = await tx.listRecentUsage({
            botId: input.botId,
            resource: input.resource,
            subject,
            since: new Date(now.getTime() - windowMs),
          });
          const used = sumUsage(entries);
          if (used + units > limit) {
            return {
              allowed: false,
              reason: window,
              ...subject,
              limit,
              used,
              retryAt: slidingRetryAt(entries, limit, units, windowMs),
            } satisfies UsageDenied;
          }
        }

        for (const window of ["day", "month"] as const) {
          const limit = limits[window];
          if (limit === undefined) continue;
          const period = periods.find((candidate) => candidate.window === window)!;
          const charge = {
            ...subject,
            window,
            windowKey: period.windowKey,
            timezone,
            units,
          } satisfies UsageBucketCharge;
          const used = await tx.getBucket({
            botId: input.botId,
            resource: input.resource,
            charge,
          });
          if (used + units > limit) {
            return {
              allowed: false,
              reason: window,
              ...subject,
              limit,
              used,
              retryAt: period.closesAt,
            } satisfies UsageDenied;
          }
          charges.push(charge);
        }
      }

      const reservation: UsageReservationRecord = {
        id: randomUUID(),
        botId: input.botId,
        resource: input.resource,
        chatKind: input.chatKind,
        chatId: input.chatId ?? null,
        userId: input.userId ?? null,
        reservedUnits: units,
        settledUnits: null,
        status: "reserved",
        bucketCharges: charges,
        reservedAt: now,
        expiresAt: new Date(now.getTime() + reservationTtlMs),
      };
      await tx.insertReservation(reservation);
      await tx.adjustBuckets({
        botId: input.botId,
        resource: input.resource,
        charges,
        deltaSign: 1,
        periods,
        now,
      });
      await tx.appendEvent({
        reservationId: reservation.id,
        botId: input.botId,
        resource: input.resource,
        eventType: "reserved",
        units,
        createdAt: now,
      });
      return {
        allowed: true,
        reservationId: reservation.id,
        reservedUnits: units,
        expiresAt: reservation.expiresAt,
      };
    });
  }

  async getSnapshot(input: UsageSnapshotRequest): Promise<UsageSnapshot> {
    const now = input.now ?? new Date();
    if (
      !input.botId ||
      Number.isNaN(now.getTime()) ||
      !isSafeTelegramId(input.chatId) ||
      !isSafeTelegramId(input.userId) ||
      (input.userId !== undefined && input.userId < 0) ||
      (input.chatKind === "group" && input.chatId === undefined)
    ) {
      throw new UsageGovernanceError("INVALID_REQUEST");
    }
    const resources = input.resources ?? (["ai_reply", "image", "proactive_reply"] as const);
    const subjects = getUsageScopeSubjects(input);
    const timezone = await this.resolveTimezone(input.botId);
    const periods = {
      day: durablePeriod(now, timezone, "day"),
      month: durablePeriod(now, timezone, "month"),
    };

    const snapshots = await this.repository.transaction(async (tx) => {
      const result: UsageSnapshot["resources"] = [];
      for (const resource of resources) {
        await tx.lock(input.botId, resource);
        const policies = await tx.listPolicies(input.botId, resource);
        for (const subject of subjects) {
          const limits = resolveUsageLimits(resource, subject, input.chatKind, policies);
          if (!limits) continue;
          const windows: UsageSnapshot["resources"][number]["windows"] = [];
          for (const [window, windowMs] of [
            ["minute", 60_000],
            ["hour", 60 * 60_000],
          ] as const) {
            const limit = limits[window];
            if (limit === undefined) continue;
            const entries = await tx.listRecentUsage({
              botId: input.botId,
              resource,
              subject,
              since: new Date(now.getTime() - windowMs),
            });
            windows.push({
              window,
              used: sumUsage(entries),
              limit,
              resetsAt: entries[0]
                ? new Date(entries[0].reservedAt.getTime() + windowMs)
                : undefined,
            });
          }
          for (const window of ["day", "month"] as const) {
            const limit = limits[window];
            if (limit === undefined) continue;
            const period = periods[window];
            const used = await tx.getBucket({
              botId: input.botId,
              resource,
              charge: {
                ...subject,
                window,
                windowKey: period.windowKey,
                timezone,
              },
            });
            windows.push({ window, used, limit, resetsAt: period.closesAt });
          }
          const active =
            limits.maxConcurrent === undefined
              ? 0
              : await tx.countActive({
                  botId: input.botId,
                  resource,
                  subject,
                  now,
                });
          if (windows.length > 0 || limits.maxConcurrent !== undefined) {
            result.push({
              resource,
              ...subject,
              windows,
              active,
              concurrencyLimit: limits.maxConcurrent,
            });
          }
        }
      }
      return result;
    });
    return { timezone, resources: snapshots };
  }

  async settle(input: {
    reservationId: string;
    botId: string;
    resource: UsageResource;
    actualUnits?: number;
    now?: Date;
  }): Promise<UsageReservationStatus> {
    const now = input.now ?? new Date();
    return this.repository.transaction(async (tx) => {
      await tx.lock(input.botId, input.resource);
      const reservation = await tx.getReservationForUpdate(input.reservationId);
      this.assertOwnership(reservation, input.botId, input.resource);
      if (reservation.status !== "reserved") return reservation.status;
      const actualUnits = input.actualUnits ?? reservation.reservedUnits;
      if (!Number.isSafeInteger(actualUnits) || actualUnits < 0) {
        throw new UsageGovernanceError("INVALID_REQUEST");
      }
      if (actualUnits > reservation.reservedUnits) {
        throw new UsageGovernanceError("SETTLEMENT_EXCEEDS_RESERVATION");
      }
      const releasedUnits = reservation.reservedUnits - actualUnits;
      if (releasedUnits > 0) {
        await tx.adjustBuckets({
          botId: input.botId,
          resource: input.resource,
          charges: reservation.bucketCharges.map((charge) => ({ ...charge, units: releasedUnits })),
          deltaSign: -1,
          now,
        });
      }
      await tx.updateReservation({
        id: reservation.id,
        status: "settled",
        settledUnits: actualUnits,
        now,
      });
      await tx.appendEvent({
        reservationId: reservation.id,
        botId: input.botId,
        resource: input.resource,
        eventType: "settled",
        units: actualUnits,
        createdAt: now,
      });
      return "settled";
    });
  }

  async refund(input: {
    reservationId: string;
    botId: string;
    resource: UsageResource;
    now?: Date;
  }): Promise<UsageReservationStatus> {
    const now = input.now ?? new Date();
    return this.repository.transaction(async (tx) => {
      await tx.lock(input.botId, input.resource);
      const reservation = await tx.getReservationForUpdate(input.reservationId);
      this.assertOwnership(reservation, input.botId, input.resource);
      if (reservation.status !== "reserved") return reservation.status;
      await tx.adjustBuckets({
        botId: input.botId,
        resource: input.resource,
        charges: reservation.bucketCharges,
        deltaSign: -1,
        now,
      });
      await tx.updateReservation({
        id: reservation.id,
        status: "refunded",
        settledUnits: 0,
        now,
      });
      await tx.appendEvent({
        reservationId: reservation.id,
        botId: input.botId,
        resource: input.resource,
        eventType: "refunded",
        units: reservation.reservedUnits,
        createdAt: now,
      });
      return "refunded";
    });
  }

  async setPolicy(input: {
    botId: string;
    policy: UsagePolicy;
    actor: { kind: "owner" | "group_admin" | "system"; id?: string };
    delegatedCeiling?: UsageLimits;
    now?: Date;
  }): Promise<void> {
    if (validateUsageLimits(input.policy.limits).length > 0) {
      throw new UsageGovernanceError("INVALID_LIMITS");
    }
    if (input.actor.kind === "group_admin") {
      if (
        (input.policy.scope !== "chat" && input.policy.scope !== "chat_user") ||
        input.policy.subjectKey === "*"
      ) {
        throw new UsageGovernanceError("POLICY_SCOPE_FORBIDDEN");
      }
      if (!input.delegatedCeiling) throw new UsageGovernanceError("POLICY_SCOPE_FORBIDDEN");
      if (findRelaxedUsageLimits(input.delegatedCeiling, input.policy.limits).length > 0) {
        throw new UsageGovernanceError("POLICY_RELAXES_CEILING");
      }
    }
    await this.repository.transaction(async (tx) => {
      await tx.lock(input.botId, input.policy.resource);
      await tx.upsertPolicy({
        botId: input.botId,
        ...input.policy,
        updatedByKind: input.actor.kind,
        updatedById: input.actor.id,
        now: input.now ?? new Date(),
      });
    });
  }

  async tightenGroupPolicy(input: {
    botId: string;
    chatId: number;
    actorUserId: number;
    resource: "ai_reply" | "image";
    targetUserId?: number;
    limits: UsageLimits;
  }): Promise<void> {
    if (
      !input.botId ||
      !Number.isSafeInteger(input.chatId) ||
      input.chatId >= 0 ||
      !Number.isSafeInteger(input.actorUserId) ||
      input.actorUserId <= 0 ||
      (input.targetUserId !== undefined &&
        (!Number.isSafeInteger(input.targetUserId) || input.targetUserId <= 0)) ||
      validateUsageLimits(input.limits).length > 0
    ) {
      throw new UsageGovernanceError("INVALID_REQUEST");
    }
    const subject: UsageScopeSubject = input.targetUserId
      ? { scope: "chat_user", subjectKey: `${input.chatId}:${input.targetUserId}` }
      : { scope: "chat", subjectKey: String(input.chatId) };
    await this.repository.transaction(async (tx) => {
      await tx.lock(input.botId, input.resource);
      const policies = await tx.listPolicies(input.botId, input.resource);
      const ceiling = resolveUsageLimits(input.resource, subject, "group", policies);
      if (!ceiling) throw new UsageGovernanceError("POLICY_SCOPE_FORBIDDEN");
      if (findRelaxedUsageLimits(ceiling, input.limits).length > 0) {
        throw new UsageGovernanceError("POLICY_RELAXES_CEILING");
      }
      await tx.upsertPolicy({
        botId: input.botId,
        resource: input.resource,
        ...subject,
        limits: input.limits,
        updatedByKind: "group_admin",
        updatedById: String(input.actorUserId),
        now: new Date(),
      });
    });
  }

  async pruneExpiredDetails(now = new Date()): Promise<void> {
    const detailCutoff = new Date(now.getTime() - USAGE_DETAIL_RETENTION_DAYS * DAY_MS);
    await this.repository.transaction((tx) => tx.prune({ detailCutoff, bucketCutoff: now }));
  }

  async reclaimExpiredReservations(now = new Date()): Promise<number> {
    const expired = await this.repository.transaction((tx) => tx.listExpiredReservations(now));
    let reclaimed = 0;
    const failures: Error[] = [];
    for (const reservation of expired) {
      try {
        const status = await this.refund({
          reservationId: reservation.id,
          botId: reservation.botId,
          resource: reservation.resource,
          now,
        });
        if (status === "refunded") reclaimed += 1;
      } catch (cause) {
        failures.push(new Error(`Failed to reclaim reservation ${reservation.id}`, { cause }));
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `Failed to reclaim ${failures.length} expired reservations`,
      );
    }
    return reclaimed;
  }

  private assertOwnership(
    reservation: UsageReservationRecord | null,
    botId: string,
    resource: UsageResource,
  ): asserts reservation is UsageReservationRecord {
    if (!reservation) throw new UsageGovernanceError("RESERVATION_NOT_FOUND");
    if (reservation.botId !== botId || reservation.resource !== resource) {
      throw new UsageGovernanceError("RESERVATION_OWNERSHIP_MISMATCH");
    }
  }
}
