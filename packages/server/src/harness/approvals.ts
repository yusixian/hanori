import { randomBytes } from "node:crypto";
import { HARNESS_CALLBACK_PREFIX } from "@cos-tool-bot/bot";
import { durationMs } from "./config/units.js";
import type { HarnessApprovalRecord, HarnessRequestRecord, HarnessStore } from "./store.js";

export const CARD_VERBS = {
  merge: "m",
  confirm: "c",
  cancel: "x",
  details: "d",
  collapse: "u",
  refresh: "r",
  start: "s",
  wait: "w",
  abort: "k",
  open: "o",
  reject: "j",
  abortAsk: "q",
  back: "b",
} as const;
export type CardVerb = keyof typeof CARD_VERBS;

const VERB_BY_CODE = new Map<string, CardVerb>(
  Object.entries(CARD_VERBS).map(([verb, code]) => [code, verb as CardVerb]),
);

export function encodeCallback(approvalId: string, verb: CardVerb): string {
  return `${HARNESS_CALLBACK_PREFIX}${approvalId}:${CARD_VERBS[verb]}`;
}

export function decodeCallback(data: string): { approvalId: string; verb: CardVerb } | null {
  if (!data.startsWith(HARNESS_CALLBACK_PREFIX)) return null;
  const [approvalId, code, extra] = data.slice(HARNESS_CALLBACK_PREFIX.length).split(":");
  const verb = code ? VERB_BY_CODE.get(code) : undefined;
  if (!approvalId || !verb || extra !== undefined || !/^[\w-]{16,32}$/.test(approvalId))
    return null;
  return { approvalId, verb };
}

export type ApprovalProblem = "missing" | "expired" | "consumed" | "invalidated";

export const APPROVAL_PROBLEM_TEXT: Record<ApprovalProblem, string> = {
  missing: "按钮已失效",
  expired: "按钮已过期，卡片已刷新",
  consumed: "该操作已处理",
  invalidated: "PR 已更新，旧按钮已失效",
};

export function checkApproval(
  approval: HarnessApprovalRecord | null,
  now: Date,
): { ok: true; approval: HarnessApprovalRecord } | { ok: false; problem: ApprovalProblem } {
  if (!approval) return { ok: false, problem: "missing" };
  if (approval.consumedAt) return { ok: false, problem: "consumed" };
  if (approval.invalidatedAt) return { ok: false, problem: "invalidated" };
  if (approval.expiresAt <= now) return { ok: false, problem: "expired" };
  return { ok: true, approval };
}

/** `picker` backs the choice buttons of `/cancel` and `/retry`: one message, several requests. */
export const APPROVAL_ACTIONS = {
  merge: "merge",
  job: "job",
  reminder: "reminder",
  picker: "picker",
} as const;

/** One record per card version: bound to the PR's head SHA, reused until consumed or replaced. */
export function ensureCardApproval(
  store: HarnessStore,
  request: HarnessRequestRecord,
  headSha: string,
  ttl: string,
  now: Date,
): Promise<HarnessApprovalRecord> {
  return ensureApproval(store, request, {
    action: APPROVAL_ACTIONS.merge,
    binding: headSha,
    ttl,
    now,
  });
}

/**
 * Job card buttons bind to `queue:<request>` before a session exists and `session:<id>` after,
 * so a button from an earlier attempt cannot act on a newer session.
 */
export function jobBinding(request: { id: string }, sessionId: string | null | undefined): string {
  return sessionId ? `session:${sessionId}` : `queue:${request.id}`;
}

export async function ensureApproval(
  store: HarnessStore,
  request: HarnessRequestRecord,
  input: { action: string; binding: string; ttl: string; now: Date; reuse?: boolean },
): Promise<HarnessApprovalRecord> {
  const { action, binding, ttl, now } = input;
  if (input.reuse !== false) {
    const existing = await store.findUsableApproval(request.id, binding, now, action);
    if (existing) return existing;
  }
  const approval = {
    id: randomBytes(16).toString("base64url"),
    requestId: request.id,
    action,
    repo: request.repo,
    prNumber: request.prNumber,
    headSha: binding,
    expiresAt: new Date(now.getTime() + durationMs(ttl)),
    consumedAt: null,
    consumedBy: null,
    invalidatedAt: null,
    invalidReason: null,
  };
  await store.createApproval(approval);
  return { ...approval, createdAt: now };
}
