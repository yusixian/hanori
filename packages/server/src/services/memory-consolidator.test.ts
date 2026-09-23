import { describe, expect, it } from "vitest";
import type { AiConfigStored } from "@cos-tool-bot/shared";
import { countTokens } from "gpt-tokenizer";
import {
  assertShownMemoryTarget,
  consolidationEnabled,
  consolidationSourceScope,
  eligible,
  fitConsolidationBatch,
  parseMemoryProposals,
  selectStableConsolidationBatch,
} from "./memory-consolidator.js";

const base = {
  botId: "bot",
  role: "user",
  meta: { turnState: "complete" },
  createdAt: new Date("2026-01-01"),
};
const groupSources = [
  {
    ...base,
    id: 11,
    chatId: -100,
    userId: 41,
    userAuthoredContent: "We plan to meet Friday",
    sourceKey: "telegram:101:user",
  },
  {
    ...base,
    id: 12,
    chatId: -100,
    userId: 42,
    userAuthoredContent: "Friday works for me",
    sourceKey: "telegram:102:user",
  },
];

function proposal(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      action: "add",
      kind: "event",
      content: "The group plans to meet Friday",
      sourceMessageIds: [11, 12],
      participantIds: [41, 42],
      ...overrides,
    },
  ]);
}

describe("consolidation proposal validation", () => {
  it("accepts a shared event only with the exact source authors", () => {
    expect(parseMemoryProposals(proposal(), groupSources)).toEqual([
      expect.objectContaining({
        kind: "event",
        sourceMessageIds: [11, 12],
        participantIds: [41, 42],
      }),
    ]);
  });

  it("rejects individual facts inferred from a group conversation", () => {
    expect(() => parseMemoryProposals(proposal({ kind: "fact" }), groupSources)).toThrow(
      "Group profile inference denied",
    );
  });

  it("rejects invented participants and source messages", () => {
    expect(() => parseMemoryProposals(proposal({ participantIds: [41] }), groupSources)).toThrow(
      "participant mismatch",
    );
    expect(() =>
      parseMemoryProposals(proposal({ sourceMessageIds: [11, 99] }), groupSources),
    ).toThrow("Unknown consolidation source");
  });

  it("requires a target for update and retire", () => {
    expect(() => parseMemoryProposals(proposal({ action: "update" }), groupSources)).toThrow(
      "Missing consolidation target",
    );
    expect(() =>
      parseMemoryProposals(proposal({ action: "retire", targetId: 0 }), groupSources),
    ).toThrow("Missing consolidation target");
  });

  it("rejects unbounded model output and expiry", () => {
    expect(() => parseMemoryProposals("not json", groupSources)).toThrow(
      "Invalid consolidation JSON",
    );
    expect(() =>
      parseMemoryProposals(JSON.stringify(Array(4).fill(JSON.parse(proposal())[0])), groupSources),
    ).toThrow("proposal count");
    expect(() =>
      parseMemoryProposals(proposal({ expiresAt: "2099-01-01T00:00:00Z" }), groupSources),
    ).toThrow("expiry");
  });

  it("allows a private owner's explicit preference", () => {
    const privateSource = [{ ...groupSources[0]!, chatId: 41 }];
    expect(
      parseMemoryProposals(
        proposal({ kind: "preference", sourceMessageIds: [11], participantIds: [41] }),
        privateSource,
      )[0]?.kind,
    ).toBe("preference");
  });
});

describe("stable source window", () => {
  it("stops before a pending turn, a young message, or another chat", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const pending = {
      ...groupSources[1]!,
      createdAt: new Date("2026-01-01T23:00:00Z"),
      meta: { turnState: "pending" },
    };
    expect(
      selectStableConsolidationBatch([groupSources[0]!, pending], now).map((row) => row.id),
    ).toEqual([11]);
    const young = { ...groupSources[1]!, createdAt: new Date("2026-01-01T23:59:00Z") };
    expect(
      selectStableConsolidationBatch([groupSources[0]!, young], now).map((row) => row.id),
    ).toEqual([11]);
    const otherChat = { ...groupSources[1]!, chatId: -200 };
    expect(
      selectStableConsolidationBatch([groupSources[0]!, otherChat], now).map((row) => row.id),
    ).toEqual([11]);
  });

  it("advances past a 24-hour pending turn without making it model evidence", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const stale = { ...groupSources[1]!, meta: { turnState: "pending" } };
    const later = {
      ...groupSources[1]!,
      id: 13,
      sourceKey: "telegram:103:user",
      createdAt: new Date("2026-01-01T12:00:00Z"),
    };
    const batch = selectStableConsolidationBatch([stale, later], now);
    expect(batch.map((row) => row.id)).toEqual([12, 13]);
    expect(batch.filter((row) => eligible(row, now)).map((row) => row.id)).toEqual([13]);
    expect(selectStableConsolidationBatch([stale], now).at(-1)?.id).toBe(12);

    // Once the cursor advances, a late completion of row 12 is not revisited.
    const cursor = batch.at(-1)!.id;
    const completedLate = { ...stale, meta: { turnState: "complete" } };
    expect(eligible(completedLate, now)).toBe(true);
    expect([completedLate, later].filter((row) => row.id > cursor)).toEqual([]);
  });
});

describe("source and visibility scope", () => {
  it("keeps shared chat visibility separate from the first author's provenance", () => {
    expect(consolidationSourceScope(groupSources, [41, 42])).toEqual({
      isPrivate: false,
      telegramId: null,
      scopeChatId: -100,
      sourceChatId: -100,
      sourceMessageId: 101,
      sourceUserId: 41,
    });
  });

  it("makes a private source visible only to its explicit owner", () => {
    expect(consolidationSourceScope([{ ...groupSources[0]!, chatId: 41 }], [41])).toEqual({
      isPrivate: true,
      telegramId: 41,
      scopeChatId: null,
      sourceChatId: 41,
      sourceMessageId: 101,
      sourceUserId: 41,
    });
  });

  it("scopes an isolated private memory to its chat while retaining source provenance", () => {
    expect(
      consolidationSourceScope([{ ...groupSources[0]!, chatId: 41 }], [41], "isolated"),
    ).toEqual({
      isPrivate: true,
      telegramId: 41,
      scopeChatId: 41,
      sourceChatId: 41,
      sourceMessageId: 101,
      sourceUserId: 41,
    });
  });
});

describe("consolidation admission and batching", () => {
  it("does not admit an AI-disabled or memory-disabled bot", () => {
    const enabled = { enabled: true, botMemoryConfig: { enabled: true } } as AiConfigStored;
    expect(consolidationEnabled(enabled)).toBe(true);
    expect(consolidationEnabled({ ...enabled, enabled: false })).toBe(false);
    expect(consolidationEnabled({ ...enabled, botMemoryConfig: undefined })).toBe(false);
    expect(
      consolidationEnabled({
        ...enabled,
        botMemoryConfig: { ...enabled.botMemoryConfig!, enabled: false },
      }),
    ).toBe(false);
  });

  it("splits before the first overflowing source and identifies an oversized single source", () => {
    const render = (sources: readonly string[]) => sources.join(" ");
    const oversized = "oversized ".repeat(100);
    const budget = countTokens("alpha");
    expect(fitConsolidationBatch(["alpha", oversized], render, budget)).toEqual({
      accepted: ["alpha"],
      firstOverflow: oversized,
      prompt: "alpha",
    });
    expect(fitConsolidationBatch([oversized], render, budget)).toEqual({
      accepted: [],
      firstOverflow: oversized,
      prompt: null,
    });
  });
});

describe("shown target snapshot", () => {
  const snapshot = {
    id: 7,
    botId: "bot",
    telegramId: 41,
    scopeChatId: 41,
    content: "Open thread",
    category: "open_thread",
    kind: "commitment" as const,
    origin: "consolidation",
    sourceChatId: 41,
    sourceMessageId: 101,
    sourceUserId: 41,
    expiresAt: null,
    factValidAt: null,
    supersededById: null,
    isActive: true,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("accepts only the exact memory shown to the model", () => {
    expect(assertShownMemoryTarget(7, [snapshot], { ...snapshot })).toEqual(snapshot);
    expect(() => assertShownMemoryTarget(8, [snapshot], { ...snapshot, id: 8 })).toThrow(
      "not shown",
    );
    expect(() =>
      assertShownMemoryTarget(7, [snapshot], { ...snapshot, content: "Admin edit" }),
    ).toThrow("target changed");
    expect(() =>
      assertShownMemoryTarget(7, [snapshot], { ...snapshot, scopeChatId: null }),
    ).toThrow("target changed");
    expect(() =>
      assertShownMemoryTarget(7, [snapshot], {
        ...snapshot,
        updatedAt: new Date("2026-01-01T00:01:00Z"),
      }),
    ).toThrow("target changed");
  });
});
