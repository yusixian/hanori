import {
  findRelaxedUsageLimits,
  getDefaultUsageLimits,
  isUsageLimitsTightening,
  resolveUsageLimits,
  type UsageBucketCharge,
  type UsagePolicy,
  type UsageResource,
  type UsageScopeSubject,
} from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  UsageGovernanceError,
  UsageGovernor,
  type RecentUsageEntry,
  type UsageGovernanceRepository,
  type UsageGovernanceTransaction,
  type UsageReservationRecord,
} from "./usage-governor.js";

const BOT_ID = "00000000-0000-4000-8000-000000000017";
const NOW = new Date("2026-08-31T12:00:00.000Z");

function subjectMatches(row: UsageReservationRecord, subject: UsageScopeSubject): boolean {
  if (subject.scope === "bot") return true;
  if (subject.scope === "chat") return row.chatId === Number(subject.subjectKey);
  if (subject.scope === "user_global") return row.userId === Number(subject.subjectKey);
  return `${row.chatId}:${row.userId}` === subject.subjectKey;
}

function createRepository(initial?: {
  policies?: UsagePolicy[];
  reservations?: UsageReservationRecord[];
}) {
  const policies = [...(initial?.policies ?? [])];
  const reservations = [...(initial?.reservations ?? [])];
  const buckets = new Map<string, number>();
  const events: Array<{ eventType: string; units: number }> = [];
  const bucketKey = (resource: UsageResource, charge: Omit<UsageBucketCharge, "units">) =>
    [
      resource,
      charge.scope,
      charge.subjectKey,
      charge.window,
      charge.windowKey,
      charge.timezone,
    ].join("|");
  const tx: UsageGovernanceTransaction = {
    lock: vi.fn(async () => undefined),
    listPolicies: vi.fn(async (_botId, resource) =>
      policies.filter((policy) => policy.resource === resource),
    ),
    listRecentUsage: vi.fn(
      async (input): Promise<RecentUsageEntry[]> =>
        reservations
          .filter(
            (row) =>
              row.botId === input.botId &&
              row.resource === input.resource &&
              row.status !== "refunded" &&
              row.reservedAt >= input.since &&
              subjectMatches(row, input.subject),
          )
          .map((row) => ({
            units:
              row.status === "settled"
                ? (row.settledUnits ?? row.reservedUnits)
                : row.reservedUnits,
            reservedAt: row.reservedAt,
          }))
          .sort((a, b) => a.reservedAt.getTime() - b.reservedAt.getTime()),
    ),
    countActive: vi.fn(
      async (input) =>
        reservations.filter(
          (row) =>
            row.botId === input.botId &&
            row.resource === input.resource &&
            row.status === "reserved" &&
            row.expiresAt > input.now &&
            subjectMatches(row, input.subject),
        ).length,
    ),
    getBucket: vi.fn(async (input) => buckets.get(bucketKey(input.resource, input.charge)) ?? 0),
    insertReservation: vi.fn(async (record) => {
      reservations.push(record);
    }),
    adjustBuckets: vi.fn(async (input) => {
      for (const charge of input.charges) {
        const key = bucketKey(input.resource, charge);
        const next = (buckets.get(key) ?? 0) + charge.units * input.deltaSign;
        buckets.set(key, Math.max(0, next));
      }
    }),
    appendEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    getReservationForUpdate: vi.fn(async (id) => reservations.find((row) => row.id === id) ?? null),
    updateReservation: vi.fn(async (input) => {
      const row = reservations.find((candidate) => candidate.id === input.id)!;
      row.status = input.status;
      row.settledUnits = input.settledUnits;
    }),
    upsertPolicy: vi.fn(async (input) => {
      const index = policies.findIndex(
        (policy) =>
          policy.resource === input.resource &&
          policy.scope === input.scope &&
          policy.subjectKey === input.subjectKey,
      );
      const policy = {
        resource: input.resource,
        scope: input.scope,
        subjectKey: input.subjectKey,
        limits: input.limits,
      };
      if (index === -1) policies.push(policy);
      else policies[index] = policy;
    }),
    listExpiredReservations: vi.fn(async (now) =>
      reservations
        .filter((row) => row.status === "reserved" && row.expiresAt <= now)
        .map(({ id, botId, resource }) => ({ id, botId, resource })),
    ),
    prune: vi.fn(async () => undefined),
  };
  const repository: UsageGovernanceRepository = {
    transaction: async <T>(operation: (transaction: UsageGovernanceTransaction) => Promise<T>) =>
      operation(tx),
  };
  const transaction = vi.spyOn(repository, "transaction");
  return { repository, tx, transaction, policies, reservations, buckets, events };
}

function settledReservation(input: {
  id: string;
  resource?: UsageResource;
  chatId: number;
  userId: number;
  units: number;
  reservedAt: Date;
}): UsageReservationRecord {
  return {
    id: input.id,
    botId: BOT_ID,
    resource: input.resource ?? "ai_reply",
    chatKind: "group",
    chatId: input.chatId,
    userId: input.userId,
    reservedUnits: input.units,
    settledUnits: input.units,
    status: "settled",
    bucketCharges: [],
    reservedAt: input.reservedAt,
    expiresAt: new Date(input.reservedAt.getTime() + 60_000),
  };
}

describe("usage governance defaults", () => {
  it("keeps AI, image, and proactive traffic on separate default ceilings", () => {
    expect(getDefaultUsageLimits("ai_reply", "chat_user", "group")).toEqual({
      cooldownMs: 10_000,
      hour: 20,
      day: 100,
    });
    expect(getDefaultUsageLimits("image", "chat", "group")).toEqual({ hour: 120, day: 1_000 });
    expect(getDefaultUsageLimits("image", "chat_user", "group")).toEqual({
      cooldownMs: 5_000,
      hour: 30,
      day: 120,
    });
    expect(getDefaultUsageLimits("proactive_reply", "bot", "group")).toEqual({ hour: 30 });
    expect(getDefaultUsageLimits("ai_reply", "chat_user", "private")).toBeUndefined();
  });

  it("detects every delegated relaxation while allowing stricter finite limits", () => {
    expect(isUsageLimitsTightening({ hour: 20, day: 100 }, { hour: 10, day: 100 })).toBe(true);
    expect(findRelaxedUsageLimits({ hour: 20, day: 100 }, { hour: 21 })).toEqual(["hour", "day"]);
    expect(isUsageLimitsTightening({}, { hour: 10 })).toBe(true);
  });

  it("keeps a later owner default ceiling above an existing exact policy", () => {
    expect(
      resolveUsageLimits("ai_reply", { scope: "chat_user", subjectKey: "-100:42" }, "group", [
        { resource: "ai_reply", scope: "chat_user", subjectKey: "*", limits: { hour: 10 } },
        {
          resource: "ai_reply",
          scope: "chat_user",
          subjectKey: "-100:42",
          limits: { cooldownMs: 20_000, hour: 15 },
        },
      ]),
    ).toEqual({ cooldownMs: 20_000, hour: 10 });
  });
});

describe("UsageGovernor", () => {
  it("rejects when any parent ceiling fails even if the chat-user scope remains available", async () => {
    const prior = Array.from({ length: 5 }, (_, index) =>
      settledReservation({
        id: `prior-${index}`,
        chatId: -100 - index,
        userId: 42,
        units: 10,
        reservedAt: new Date(NOW.getTime() - 30_000 - index),
      }),
    );
    const { repository, tx } = createRepository({ reservations: prior });

    const result = await new UsageGovernor(repository).reserve({
      botId: BOT_ID,
      resource: "ai_reply",
      chatKind: "group",
      chatId: -999,
      userId: 42,
      now: NOW,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "hour",
      scope: "user_global",
      subjectKey: "42",
      limit: 50,
      used: 50,
    });
    expect(tx.insertReservation).not.toHaveBeenCalled();
  });

  it("reserves every applicable durable parent bucket in one transaction", async () => {
    const { repository, reservations, buckets, events, transaction } = createRepository();

    const result = await new UsageGovernor(repository).reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      units: 2,
      now: NOW,
    });

    expect(result).toMatchObject({ allowed: true, reservedUnits: 2 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.bucketCharges).toHaveLength(4);
    expect([...buckets.values()]).toEqual([2, 2, 2, 2]);
    expect(events).toEqual([expect.objectContaining({ eventType: "reserved", units: 2 })]);
  });

  it("enforces cooldown from a reservation and returns its precise retry time", async () => {
    const { repository } = createRepository({
      reservations: [
        settledReservation({
          id: "recent",
          chatId: -100,
          userId: 42,
          units: 1,
          reservedAt: new Date(NOW.getTime() - 5_000),
        }),
      ],
    });

    const result = await new UsageGovernor(repository).reserve({
      botId: BOT_ID,
      resource: "ai_reply",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      now: NOW,
    });

    expect(result).toMatchObject({ allowed: false, reason: "cooldown", scope: "chat_user" });
    if (!result.allowed) expect(result.retryAt).toEqual(new Date(NOW.getTime() + 5_000));
  });

  it("settles partial usage by releasing the unused durable reservation", async () => {
    const state = createRepository();
    const governor = new UsageGovernor(state.repository);
    const reserved = await governor.reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      units: 3,
      now: NOW,
    });
    if (!reserved.allowed) throw new Error("expected reservation");

    await expect(
      governor.settle({
        reservationId: reserved.reservationId,
        botId: BOT_ID,
        resource: "image",
        actualUnits: 1,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toBe("settled");

    expect([...state.buckets.values()]).toEqual([1, 1, 1, 1]);
    expect(state.reservations[0]).toMatchObject({ status: "settled", settledUnits: 1 });
    expect(state.events.map((event) => event.eventType)).toEqual(["reserved", "settled"]);
  });

  it("refunds once and makes repeated lifecycle calls idempotent", async () => {
    const state = createRepository();
    const governor = new UsageGovernor(state.repository);
    const reserved = await governor.reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      now: NOW,
    });
    if (!reserved.allowed) throw new Error("expected reservation");

    await expect(
      governor.refund({
        reservationId: reserved.reservationId,
        botId: BOT_ID,
        resource: "image",
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toBe("refunded");
    await expect(
      governor.refund({
        reservationId: reserved.reservationId,
        botId: BOT_ID,
        resource: "image",
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).resolves.toBe("refunded");

    expect([...state.buckets.values()]).toEqual([0, 0, 0, 0]);
    expect(state.events.map((event) => event.eventType)).toEqual(["reserved", "refunded"]);
  });

  it("reclaims expired reservations and releases their durable buckets", async () => {
    const state = createRepository();
    const governor = new UsageGovernor(state.repository);
    const reserved = await governor.reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      now: NOW,
      reservationTtlMs: 60_000,
    });
    if (!reserved.allowed) throw new Error("expected reservation");

    await expect(
      governor.reclaimExpiredReservations(new Date(NOW.getTime() + 60_000)),
    ).resolves.toBe(1);

    expect(state.reservations[0]).toMatchObject({ status: "refunded", settledUnits: 0 });
    expect([...state.buckets.values()]).toEqual([0, 0, 0, 0]);
  });

  it("keeps random proactive replies outside normal user quotas", async () => {
    const prior = Array.from({ length: 30 }, (_, index) =>
      settledReservation({
        id: `random-${index}`,
        resource: "proactive_reply",
        chatId: -100,
        userId: 42,
        units: 1,
        reservedAt: new Date(NOW.getTime() - 30_000 - index),
      }),
    );
    const { repository, tx } = createRepository({ reservations: prior });

    const result = await new UsageGovernor(repository).reserve({
      botId: BOT_ID,
      resource: "proactive_reply",
      chatKind: "group",
      chatId: -100,
      userId: 42,
      now: NOW,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "hour",
      scope: "bot",
      limit: 30,
    });
    expect(tx.listRecentUsage).toHaveBeenCalledTimes(1);
  });

  it("allows delegated group admins to tighten exact group policy only", async () => {
    const state = createRepository();
    const governor = new UsageGovernor(state.repository);
    await governor.setPolicy({
      botId: BOT_ID,
      policy: {
        resource: "image",
        scope: "chat_user",
        subjectKey: "-100:42",
        limits: { hour: 2, day: 10 },
      },
      actor: { kind: "group_admin", id: "42" },
      delegatedCeiling: { hour: 5, day: 20 },
      now: NOW,
    });
    expect(state.policies).toEqual([
      expect.objectContaining({ subjectKey: "-100:42", limits: { hour: 2, day: 10 } }),
    ]);

    await expect(
      governor.setPolicy({
        botId: BOT_ID,
        policy: {
          resource: "image",
          scope: "chat",
          subjectKey: "-100",
          limits: { hour: 21, day: 100 },
        },
        actor: { kind: "group_admin", id: "42" },
        delegatedCeiling: { hour: 20, day: 100 },
      }),
    ).rejects.toEqual(new UsageGovernanceError("POLICY_RELAXES_CEILING"));
  });

  it("rejects over-settlement and cross-Bot reservation ownership", async () => {
    const state = createRepository();
    const governor = new UsageGovernor(state.repository);
    const reserved = await governor.reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "private",
      chatId: 42,
      userId: 42,
      units: 1,
      now: NOW,
    });
    if (!reserved.allowed) throw new Error("expected reservation");

    await expect(
      governor.settle({
        reservationId: reserved.reservationId,
        botId: BOT_ID,
        resource: "image",
        actualUnits: 2,
      }),
    ).rejects.toEqual(new UsageGovernanceError("SETTLEMENT_EXCEEDS_RESERVATION"));
    await expect(
      governor.refund({
        reservationId: reserved.reservationId,
        botId: "0ad0459e-f851-4e3e-b84d-a43d42edbce8",
        resource: "image",
      }),
    ).rejects.toEqual(new UsageGovernanceError("RESERVATION_OWNERSHIP_MISMATCH"));
  });

  it("uses the configured timezone for durable reset boundaries", async () => {
    const state = createRepository({
      policies: [
        {
          resource: "image",
          scope: "user_global",
          subjectKey: "42",
          limits: { day: 0 },
        },
      ],
    });
    const result = await new UsageGovernor(state.repository, "Asia/Shanghai").reserve({
      botId: BOT_ID,
      resource: "image",
      chatKind: "private",
      chatId: 42,
      userId: 42,
      now: new Date("2026-08-31T15:59:00.000Z"),
    });

    expect(result).toMatchObject({ allowed: false, reason: "day" });
    if (!result.allowed) expect(result.retryAt).toEqual(new Date("2026-08-31T16:00:00.000Z"));
  });
});
