import { AI_SETTING_BOUNDS, isWithinBounds } from "@cos-tool-bot/shared";

export interface MiniAppGroupTriggerConfig {
  replyToBot: boolean;
  mentionBot: boolean;
  triggerWords: string[];
  randomReplyPercent: number;
  randomReplyCooldown: number;
}

export interface MiniAppGroupConversationConfig {
  enabled: boolean;
  maxContextMessages: number;
  groupHistoryMaxTokens: number;
}

export interface MiniAppGroupSummaryConfig {
  enabled: boolean;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  timezone: string | null;
  windowHours: number;
  maxMessages: number | null;
  cooldownSeconds: number | null;
}

export interface MiniAppGroupConfig {
  revision: string;
  aiConfigured: boolean;
  group: {
    enabled: boolean;
    whitelisted: boolean;
    trigger: MiniAppGroupTriggerConfig;
    conversation: MiniAppGroupConversationConfig;
  };
  summary: MiniAppGroupSummaryConfig;
}

export interface MiniAppGroup {
  chatId: number;
  type: "group" | "supergroup";
  title: string | null;
  username: string | null;
  botMembershipStatus: string | null;
  membershipObservedAt: string | null;
  lastObservedAt: string;
  archived: boolean;
  config: MiniAppGroupConfig;
  applyState: "applied" | "pending";
}

export interface MiniAppGroupList {
  editable: boolean;
  groups: MiniAppGroup[];
}

export interface MiniAppGroupDetail {
  editable: boolean;
  group: MiniAppGroup;
}

export interface MiniAppGroupPatch {
  group?: {
    enabled?: boolean;
    whitelisted?: boolean;
    trigger?: Partial<MiniAppGroupTriggerConfig>;
    conversation?: Partial<MiniAppGroupConversationConfig>;
  };
  summary?: Partial<MiniAppGroupSummaryConfig>;
}

export type MiniAppGroupErrorCode = "stale_revision" | "archived" | "ai_not_configured";

export class MiniAppGroupApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: MiniAppGroupErrorCode,
    readonly latest?: MiniAppGroup,
  ) {
    super(message);
    this.name = "MiniAppGroupApiError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FORBIDDEN_RESPONSE_KEYS = new Set([
  "apiKey",
  "credentials",
  "history",
  "interests",
  "model",
  "models",
  "profile",
  "profiles",
  "provider",
  "providers",
  "prompt",
  "systemPrompt",
  "tool",
  "tools",
  "traits",
  "usage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsForbiddenProjection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenProjection);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => FORBIDDEN_RESPONSE_KEYS.has(key) || containsForbiddenProjection(child),
  );
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function nullableIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  return value === null ? null : integerInRange(value, min, max);
}

function parseTrigger(value: unknown): MiniAppGroupTriggerConfig | null {
  if (!isRecord(value) || !Array.isArray(value["triggerWords"])) return null;
  const triggerWords = value["triggerWords"];
  const randomReplyPercent = value["randomReplyPercent"];
  const randomReplyCooldown = value["randomReplyCooldown"];
  if (
    typeof value["replyToBot"] !== "boolean" ||
    typeof value["mentionBot"] !== "boolean" ||
    triggerWords.length > 32 ||
    !triggerWords.every(
      (word) => typeof word === "string" && word.trim().length > 0 && word.trim().length <= 64,
    ) ||
    !isWithinBounds(randomReplyPercent, AI_SETTING_BOUNDS.randomReplyPercent) ||
    !isWithinBounds(randomReplyCooldown, AI_SETTING_BOUNDS.randomReplyCooldown)
  ) {
    return null;
  }
  return {
    replyToBot: value["replyToBot"],
    mentionBot: value["mentionBot"],
    triggerWords: [...triggerWords],
    randomReplyPercent,
    randomReplyCooldown,
  };
}

function parseConversation(value: unknown): MiniAppGroupConversationConfig | null {
  if (!isRecord(value)) return null;
  const maxContextMessages = value["maxContextMessages"];
  const groupHistoryMaxTokens = value["groupHistoryMaxTokens"];
  if (
    typeof value["enabled"] !== "boolean" ||
    !isWithinBounds(maxContextMessages, AI_SETTING_BOUNDS.maxContextMessages) ||
    !isWithinBounds(groupHistoryMaxTokens, AI_SETTING_BOUNDS.groupHistoryMaxTokens)
  ) {
    return null;
  }
  return { enabled: value["enabled"], maxContextMessages, groupHistoryMaxTokens };
}

function parseSummary(value: unknown): MiniAppGroupSummaryConfig | null {
  if (!isRecord(value)) return null;
  const scheduleHour = nullableIntegerInRange(value["scheduleHour"], 0, 23);
  const scheduleMinute = nullableIntegerInRange(value["scheduleMinute"], 0, 59);
  const timezone = nullableString(value["timezone"]);
  const windowHours = integerInRange(value["windowHours"], 1, 72);
  const maxMessages = nullableIntegerInRange(value["maxMessages"], 10, 2_000);
  const cooldownSeconds = nullableIntegerInRange(value["cooldownSeconds"], 0, 86_400);
  if (
    typeof value["enabled"] !== "boolean" ||
    scheduleHour === undefined ||
    scheduleMinute === undefined ||
    timezone === undefined ||
    (typeof timezone === "string" && (timezone.length < 1 || timezone.length > 64)) ||
    windowHours === undefined ||
    maxMessages === undefined ||
    cooldownSeconds === undefined
  ) {
    return null;
  }
  return {
    enabled: value["enabled"],
    scheduleHour,
    scheduleMinute,
    timezone,
    windowHours,
    maxMessages,
    cooldownSeconds,
  };
}

function parseConfig(value: unknown): MiniAppGroupConfig | null {
  if (!isRecord(value) || !isRecord(value["group"])) return null;
  const group = value["group"];
  const trigger = parseTrigger(group["trigger"]);
  const conversation = parseConversation(group["conversation"]);
  const summary = parseSummary(value["summary"]);
  if (
    typeof value["revision"] !== "string" ||
    value["revision"].length < 1 ||
    value["revision"].length > 100 ||
    typeof value["aiConfigured"] !== "boolean" ||
    typeof group["enabled"] !== "boolean" ||
    typeof group["whitelisted"] !== "boolean" ||
    !trigger ||
    !conversation ||
    !summary
  ) {
    return null;
  }
  return {
    revision: value["revision"],
    aiConfigured: value["aiConfigured"],
    group: {
      enabled: group["enabled"],
      whitelisted: group["whitelisted"],
      trigger,
      conversation,
    },
    summary,
  };
}

export function parseMiniAppGroup(value: unknown): MiniAppGroup | null {
  if (!isRecord(value) || containsForbiddenProjection(value)) return null;
  const title = nullableString(value["title"]);
  const username = nullableString(value["username"]);
  const botMembershipStatus = nullableString(value["botMembershipStatus"]);
  const membershipObservedAt = nullableString(value["membershipObservedAt"]);
  const config = parseConfig(value["config"]);
  if (
    typeof value["chatId"] !== "number" ||
    !Number.isSafeInteger(value["chatId"]) ||
    value["chatId"] >= 0 ||
    (value["type"] !== "group" && value["type"] !== "supergroup") ||
    title === undefined ||
    username === undefined ||
    botMembershipStatus === undefined ||
    membershipObservedAt === undefined ||
    typeof value["lastObservedAt"] !== "string" ||
    typeof value["archived"] !== "boolean" ||
    !config ||
    (value["applyState"] !== "applied" && value["applyState"] !== "pending")
  ) {
    return null;
  }
  return {
    chatId: value["chatId"],
    type: value["type"],
    title,
    username,
    botMembershipStatus,
    membershipObservedAt,
    lastObservedAt: value["lastObservedAt"],
    archived: value["archived"],
    config,
    applyState: value["applyState"],
  };
}

function parseGroups(value: unknown): MiniAppGroup[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parseMiniAppGroup);
  return parsed.every((group): group is MiniAppGroup => group !== null) ? parsed : null;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function endpoint(botId: string, suffix = ""): string {
  return `/api/mini-app/${encodeURIComponent(botId)}/groups${suffix}`;
}

async function throwApiError(response: Response, body: unknown): Promise<never> {
  const record = isRecord(body) && !containsForbiddenProjection(body) ? body : {};
  const code =
    record["code"] === "stale_revision" ||
    record["code"] === "archived" ||
    record["code"] === "ai_not_configured"
      ? record["code"]
      : undefined;
  const latest = code === "stale_revision" ? parseMiniAppGroup(record["latest"]) : undefined;
  throw new MiniAppGroupApiError(
    typeof record["error"] === "string" ? record["error"] : "Group request failed",
    response.status,
    code,
    latest ?? undefined,
  );
}

export async function fetchMiniAppGroups(
  botId: string,
  fetcher: Fetcher = fetch,
): Promise<MiniAppGroupList> {
  const response = await fetcher(endpoint(botId), { credentials: "same-origin" });
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  if (!isRecord(body) || body["ok"] !== true || typeof body["editable"] !== "boolean") {
    throw new MiniAppGroupApiError("Group list response was invalid", response.status);
  }
  const groups = parseGroups(body["groups"]);
  if (!groups) throw new MiniAppGroupApiError("Group list response was invalid", response.status);
  return { editable: body["editable"], groups };
}

export async function fetchMiniAppGroup(
  botId: string,
  chatId: number,
  fetcher: Fetcher = fetch,
): Promise<MiniAppGroupDetail> {
  const response = await fetcher(endpoint(botId, `/${chatId}`), { credentials: "same-origin" });
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  if (!isRecord(body) || body["ok"] !== true || typeof body["editable"] !== "boolean") {
    throw new MiniAppGroupApiError("Group detail response was invalid", response.status);
  }
  const group = parseMiniAppGroup(body["group"]);
  if (!group) throw new MiniAppGroupApiError("Group detail response was invalid", response.status);
  return { editable: body["editable"], group };
}

export async function patchMiniAppGroup(input: {
  botId: string;
  chatId: number;
  expectedRevision: string;
  patch: MiniAppGroupPatch;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<{ persisted: boolean; applied: boolean; group: MiniAppGroup }> {
  const response = await (input.fetcher ?? fetch)(endpoint(input.botId, `/${input.chatId}`), {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-mini-app-csrf": input.csrfToken,
    },
    body: JSON.stringify({ expectedRevision: input.expectedRevision, patch: input.patch }),
  });
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  if (
    !isRecord(body) ||
    body["ok"] !== true ||
    typeof body["persisted"] !== "boolean" ||
    typeof body["applied"] !== "boolean"
  ) {
    throw new MiniAppGroupApiError("Group mutation response was invalid", response.status);
  }
  const group = parseMiniAppGroup(body["group"]);
  if (!group)
    throw new MiniAppGroupApiError("Group mutation response was invalid", response.status);
  return { persisted: body["persisted"], applied: body["applied"], group };
}

export async function retryMiniAppGroupApply(input: {
  botId: string;
  chatId: number;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<MiniAppGroup> {
  const response = await (input.fetcher ?? fetch)(
    endpoint(input.botId, `/${input.chatId}/retry-apply`),
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-mini-app-csrf": input.csrfToken },
    },
  );
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  if (!isRecord(body) || body["ok"] !== true) {
    throw new MiniAppGroupApiError("Retry response was invalid", response.status);
  }
  const group = parseMiniAppGroup(body["group"]);
  if (!group) throw new MiniAppGroupApiError("Retry response was invalid", response.status);
  return group;
}
