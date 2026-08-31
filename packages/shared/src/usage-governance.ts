export const USAGE_RESOURCES = ["ai_reply", "image", "proactive_reply"] as const;

export type UsageResource = (typeof USAGE_RESOURCES)[number];

export const USAGE_SCOPES = ["bot", "chat", "user_global", "chat_user"] as const;

export type UsageScope = (typeof USAGE_SCOPES)[number];

export const USAGE_WINDOWS = ["minute", "hour", "day", "month"] as const;

export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export interface UsageLimits {
  cooldownMs?: number;
  minute?: number;
  hour?: number;
  day?: number;
  month?: number;
  maxConcurrent?: number;
}

export interface UsagePolicy {
  resource: UsageResource;
  scope: UsageScope;
  /** `*` is the Bot-wide default for this scope; exact subjects take precedence. */
  subjectKey: string;
  limits: UsageLimits;
}

export interface UsageScopeSubject {
  scope: UsageScope;
  subjectKey: string;
}

export interface UsageBucketCharge extends UsageScopeSubject {
  window: "day" | "month";
  windowKey: string;
  timezone: string;
  units: number;
}

export type UsageChatKind = "private" | "group";

export interface UsageAdmissionRequest {
  botId: string;
  resource: UsageResource;
  chatKind: UsageChatKind;
  chatId?: number;
  userId?: number;
  units?: number;
  reservationTtlMs?: number;
  now?: Date;
}

export type UsageDenialReason = "cooldown" | "minute" | "hour" | "day" | "month" | "concurrency";

export interface UsageDenied {
  allowed: false;
  reason: UsageDenialReason;
  scope: UsageScope;
  subjectKey: string;
  limit: number;
  used: number;
  retryAt?: Date;
}

export interface UsageReserved {
  allowed: true;
  reservationId: string;
  reservedUnits: number;
  expiresAt: Date;
}

export type UsageReserveResult = UsageDenied | UsageReserved;

export interface UsageSettlementRequest {
  reservationId: string;
  botId: string;
  resource: UsageResource;
  actualUnits?: number;
  now?: Date;
}

export interface UsageRefundRequest {
  reservationId: string;
  botId: string;
  resource: UsageResource;
  now?: Date;
}

export interface UsageWindowSnapshot {
  window: UsageWindow;
  used: number;
  limit: number;
  resetsAt?: Date;
}

export interface UsageResourceSnapshot {
  resource: UsageResource;
  scope: UsageScope;
  subjectKey: string;
  windows: UsageWindowSnapshot[];
  active: number;
  concurrencyLimit?: number;
}

export interface UsageSnapshotRequest {
  botId: string;
  chatKind: UsageChatKind;
  chatId?: number;
  userId?: number;
  resources?: UsageResource[];
  now?: Date;
}

export interface UsageSnapshot {
  timezone: string;
  resources: UsageResourceSnapshot[];
}

/** Runtime boundary used by Bot without depending on the server/database implementation. */
export interface UsageGovernancePort {
  reserve(input: UsageAdmissionRequest): Promise<UsageReserveResult>;
  settle(input: UsageSettlementRequest): Promise<unknown>;
  refund(input: UsageRefundRequest): Promise<unknown>;
  getSnapshot(input: UsageSnapshotRequest): Promise<UsageSnapshot>;
  tightenGroupPolicy?(input: {
    botId: string;
    chatId: number;
    actorUserId: number;
    resource: "ai_reply" | "image";
    targetUserId?: number;
    limits: UsageLimits;
  }): Promise<void>;
}

export const DEFAULT_USAGE_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_USAGE_RESERVATION_TTL_MS = 15 * 60 * 1000;
export const USAGE_DETAIL_RETENTION_DAYS = 30;

const DEFAULT_LIMITS: Readonly<
  Record<UsageResource, Partial<Record<UsageScope, Readonly<UsageLimits>>>>
> = Object.freeze({
  ai_reply: Object.freeze({
    bot: Object.freeze({ hour: 500, day: 5_000 }),
    chat: Object.freeze({ hour: 120, day: 1_000 }),
    user_global: Object.freeze({ hour: 50, day: 200 }),
    chat_user: Object.freeze({ cooldownMs: 10_000, hour: 20, day: 100 }),
  }),
  image: Object.freeze({
    bot: Object.freeze({ hour: 100, day: 500 }),
    chat: Object.freeze({ hour: 20, day: 100 }),
    user_global: Object.freeze({ hour: 10, day: 30 }),
    chat_user: Object.freeze({ cooldownMs: 60_000, hour: 5, day: 20 }),
  }),
  proactive_reply: Object.freeze({
    bot: Object.freeze({ hour: 30 }),
  }),
});

const LIMIT_KEYS = [
  "cooldownMs",
  "minute",
  "hour",
  "day",
  "month",
  "maxConcurrent",
] as const satisfies readonly (keyof UsageLimits)[];

export function getDefaultUsageLimits(
  resource: UsageResource,
  scope: UsageScope,
  chatKind: UsageChatKind,
): UsageLimits | undefined {
  if (chatKind === "private" && (scope === "chat" || scope === "chat_user")) return undefined;
  const limits = DEFAULT_LIMITS[resource][scope];
  return limits ? { ...limits } : undefined;
}

export function getUsageScopeSubjects(
  input: Pick<UsageAdmissionRequest, "chatKind" | "chatId" | "userId">,
): UsageScopeSubject[] {
  const subjects: UsageScopeSubject[] = [{ scope: "bot", subjectKey: "*" }];
  if (input.chatKind === "group" && input.chatId !== undefined) {
    subjects.push({ scope: "chat", subjectKey: String(input.chatId) });
  }
  if (input.userId !== undefined) {
    subjects.push({ scope: "user_global", subjectKey: String(input.userId) });
  }
  if (input.chatKind === "group" && input.chatId !== undefined && input.userId !== undefined) {
    subjects.push({ scope: "chat_user", subjectKey: `${input.chatId}:${input.userId}` });
  }
  return subjects;
}

/** Exact policy values layer under the corresponding default; neither ceiling can be bypassed. */
export function resolveUsageLimits(
  resource: UsageResource,
  subject: UsageScopeSubject,
  chatKind: UsageChatKind,
  policies: readonly UsagePolicy[],
): UsageLimits | undefined {
  const candidates = policies.filter(
    (policy) => policy.resource === resource && policy.scope === subject.scope,
  );
  const exact = candidates.find((policy) => policy.subjectKey === subject.subjectKey);
  const configuredDefault = candidates.find((policy) => policy.subjectKey === "*");
  const parent =
    configuredDefault?.limits ?? getDefaultUsageLimits(resource, subject.scope, chatKind);
  if (!exact) return parent ? { ...parent } : undefined;
  if (!parent) return { ...exact.limits };
  return tightestUsageLimits(parent, exact.limits);
}

export function tightestUsageLimits(parent: UsageLimits, exact: UsageLimits): UsageLimits {
  const result: UsageLimits = {};
  for (const key of LIMIT_KEYS) {
    const parentValue = parent[key];
    const exactValue = exact[key];
    if (parentValue === undefined && exactValue === undefined) continue;
    if (parentValue === undefined) result[key] = exactValue;
    else if (exactValue === undefined) result[key] = parentValue;
    else
      result[key] =
        key === "cooldownMs"
          ? Math.max(parentValue, exactValue)
          : Math.min(parentValue, exactValue);
  }
  return result;
}

export function validateUsageLimits(limits: UsageLimits): readonly (keyof UsageLimits)[] {
  return LIMIT_KEYS.filter((key) => {
    const value = limits[key];
    return value !== undefined && (!Number.isSafeInteger(value) || value < 0);
  });
}

/**
 * Returns every dimension a delegated group administrator attempted to relax.
 * Missing means unlimited, so removing an existing limit is always a relaxation.
 */
export function findRelaxedUsageLimits(
  ceiling: UsageLimits,
  proposed: UsageLimits,
): readonly (keyof UsageLimits)[] {
  return LIMIT_KEYS.filter((key) => {
    const current = ceiling[key];
    const next = proposed[key];
    if (current === undefined) return false;
    return next === undefined || next > current;
  });
}

export function isUsageLimitsTightening(ceiling: UsageLimits, proposed: UsageLimits): boolean {
  return (
    validateUsageLimits(proposed).length === 0 &&
    findRelaxedUsageLimits(ceiling, proposed).length === 0
  );
}
