export interface MiniAppAccessChatGrant {
  createdBy: number;
  note: string | null;
  createdAt: string;
}

export interface MiniAppAccessChat {
  chatId: number;
  type: "group" | "supergroup";
  title: string | null;
  username: string | null;
  botMembershipStatus: string | null;
  membershipObservedAt: string | null;
  lastObservedAt: string;
  leftAt: string | null;
  granted: boolean;
  grant: MiniAppAccessChatGrant | null;
}

export interface MiniAppAccessOperator {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
  verified: boolean;
  createdBy: number;
  note: string | null;
  createdAt: string;
}

export interface MiniAppAccessActivity {
  id: number;
  actorTelegramUserId: number | null;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  createdAt: string;
}

export interface MiniAppAccessView {
  bot: { username: string; displayName: string };
  chats: MiniAppAccessChat[];
  operators: MiniAppAccessOperator[];
  activity: MiniAppAccessActivity[];
}

export interface MiniAppAccessPerson {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
  lastSeen: string;
}

export type MiniAppAccessErrorCode = "bot_admin_required" | "conflict";

export class MiniAppAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: MiniAppAccessErrorCode,
  ) {
    super(message);
    this.name = "MiniAppAccessError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = safeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseChatGrant(value: unknown): MiniAppAccessChatGrant | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const createdBy = positiveSafeInteger(value["createdBy"]);
  const note = nullableString(value["note"]);
  if (createdBy === undefined || note === undefined || typeof value["createdAt"] !== "string") {
    return undefined;
  }
  return { createdBy, note, createdAt: value["createdAt"] };
}

function parseChat(value: unknown): MiniAppAccessChat | null {
  if (!isRecord(value)) return null;
  const chatId = safeInteger(value["chatId"]);
  const title = nullableString(value["title"]);
  const username = nullableString(value["username"]);
  const botMembershipStatus = nullableString(value["botMembershipStatus"]);
  const membershipObservedAt = nullableString(value["membershipObservedAt"]);
  const leftAt = nullableString(value["leftAt"]);
  const grant = parseChatGrant(value["grant"]);
  if (
    chatId === undefined ||
    (value["type"] !== "group" && value["type"] !== "supergroup") ||
    title === undefined ||
    username === undefined ||
    botMembershipStatus === undefined ||
    membershipObservedAt === undefined ||
    typeof value["lastObservedAt"] !== "string" ||
    leftAt === undefined ||
    typeof value["granted"] !== "boolean" ||
    grant === undefined
  ) {
    return null;
  }
  return {
    chatId,
    type: value["type"],
    title,
    username,
    botMembershipStatus,
    membershipObservedAt,
    lastObservedAt: value["lastObservedAt"],
    leftAt,
    granted: value["granted"],
    grant,
  };
}

function parseOperator(value: unknown): MiniAppAccessOperator | null {
  if (!isRecord(value)) return null;
  const telegramUserId = positiveSafeInteger(value["telegramUserId"]);
  const username = nullableString(value["username"]);
  const displayName = nullableString(value["displayName"]);
  const createdBy = positiveSafeInteger(value["createdBy"]);
  const note = nullableString(value["note"]);
  if (
    telegramUserId === undefined ||
    username === undefined ||
    displayName === undefined ||
    typeof value["verified"] !== "boolean" ||
    createdBy === undefined ||
    note === undefined ||
    typeof value["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    telegramUserId,
    username,
    displayName,
    verified: value["verified"],
    createdBy,
    note,
    createdAt: value["createdAt"],
  };
}

function parseActivity(value: unknown): MiniAppAccessActivity | null {
  if (!isRecord(value)) return null;
  const id = safeInteger(value["id"]);
  const actorTelegramUserId =
    value["actorTelegramUserId"] === null
      ? null
      : positiveSafeInteger(value["actorTelegramUserId"]);
  if (
    id === undefined ||
    actorTelegramUserId === undefined ||
    typeof value["actorRole"] !== "string" ||
    typeof value["action"] !== "string" ||
    typeof value["resourceType"] !== "string" ||
    typeof value["resourceId"] !== "string" ||
    typeof value["outcome"] !== "string" ||
    typeof value["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    id,
    actorTelegramUserId,
    actorRole: value["actorRole"],
    action: value["action"],
    resourceType: value["resourceType"],
    resourceId: value["resourceId"],
    outcome: value["outcome"],
    createdAt: value["createdAt"],
  };
}

function parsePerson(value: unknown): MiniAppAccessPerson | null {
  if (!isRecord(value)) return null;
  const telegramUserId = positiveSafeInteger(value["telegramUserId"]);
  const username = nullableString(value["username"]);
  const displayName = nullableString(value["displayName"]);
  if (
    telegramUserId === undefined ||
    username === undefined ||
    displayName === undefined ||
    typeof value["lastSeen"] !== "string"
  ) {
    return null;
  }
  return { telegramUserId, username, displayName, lastSeen: value["lastSeen"] };
}

function parseArray<T>(value: unknown, parser: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parser);
  return parsed.every((entry): entry is T => entry !== null) ? parsed : null;
}

function parseAccessView(value: unknown): MiniAppAccessView | null {
  if (!isRecord(value) || value["ok"] !== true || !isRecord(value["bot"])) return null;
  const chats = parseArray(value["chats"], parseChat);
  const operators = parseArray(value["operators"], parseOperator);
  const activity = parseArray(value["activity"], parseActivity);
  if (
    typeof value["bot"]["username"] !== "string" ||
    typeof value["bot"]["displayName"] !== "string" ||
    !chats ||
    !operators ||
    !activity
  ) {
    return null;
  }
  return {
    bot: { username: value["bot"]["username"], displayName: value["bot"]["displayName"] },
    chats,
    operators,
    activity,
  };
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function accessEndpoint(botId: string, path = ""): string {
  return `/api/mini-app/${encodeURIComponent(botId)}/access${path}`;
}

async function throwResponseError(response: Response, body: unknown): Promise<never> {
  const errorBody = isRecord(body) ? body : {};
  const code =
    errorBody["code"] === "bot_admin_required" || errorBody["code"] === "conflict"
      ? errorBody["code"]
      : undefined;
  throw new MiniAppAccessError(
    typeof errorBody["error"] === "string" ? errorBody["error"] : "Access request failed",
    response.status,
    code,
  );
}

export async function fetchMiniAppAccess(
  botId: string,
  fetcher: Fetcher = fetch,
): Promise<MiniAppAccessView> {
  const response = await fetcher(accessEndpoint(botId), { credentials: "same-origin" });
  const body = await responseBody(response);
  if (!response.ok) return throwResponseError(response, body);
  const view = parseAccessView(body);
  if (!view) throw new MiniAppAccessError("Access response was invalid", response.status);
  return view;
}

export async function searchMiniAppAccessPeople(
  botId: string,
  query: string,
  fetcher: Fetcher = fetch,
): Promise<MiniAppAccessPerson[]> {
  const params = new URLSearchParams({ query });
  const response = await fetcher(accessEndpoint(botId, `/people?${params}`), {
    credentials: "same-origin",
  });
  const body = await responseBody(response);
  if (!response.ok) return throwResponseError(response, body);
  if (!isRecord(body) || body["ok"] !== true) {
    throw new MiniAppAccessError("People response was invalid", response.status);
  }
  const people = parseArray(body["people"], parsePerson);
  if (!people) throw new MiniAppAccessError("People response was invalid", response.status);
  return people;
}

async function mutateAccess(
  botId: string,
  path: string,
  csrfToken: string,
  init: { method: "POST" | "DELETE"; body?: Record<string, unknown> },
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(accessEndpoint(botId, path), {
    method: init.method,
    credentials: "same-origin",
    headers: {
      "x-mini-app-csrf": csrfToken,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await responseBody(response);
  if (!response.ok) return throwResponseError(response, body);
  if (!isRecord(body) || body["ok"] !== true) {
    throw new MiniAppAccessError("Mutation response was invalid", response.status);
  }
}

function withNote(note: string): { note?: string } {
  const trimmed = note.trim();
  return trimmed ? { note: trimmed } : {};
}

export function createMiniAppChatGrant(input: {
  botId: string;
  chatId: number;
  note: string;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<void> {
  return mutateAccess(
    input.botId,
    "/chat-grants",
    input.csrfToken,
    { method: "POST", body: { chatId: input.chatId, ...withNote(input.note) } },
    input.fetcher,
  );
}

export function revokeMiniAppChatGrant(input: {
  botId: string;
  chatId: number;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<void> {
  return mutateAccess(
    input.botId,
    `/chat-grants/${input.chatId}`,
    input.csrfToken,
    { method: "DELETE" },
    input.fetcher,
  );
}

export function createMiniAppOperatorGrant(input: {
  botId: string;
  telegramUserId: number;
  note: string;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<void> {
  return mutateAccess(
    input.botId,
    "/operator-grants",
    input.csrfToken,
    {
      method: "POST",
      body: { telegramUserId: input.telegramUserId, ...withNote(input.note) },
    },
    input.fetcher,
  );
}

export function revokeMiniAppOperatorGrant(input: {
  botId: string;
  telegramUserId: number;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<void> {
  return mutateAccess(
    input.botId,
    `/operator-grants/${input.telegramUserId}`,
    input.csrfToken,
    { method: "DELETE" },
    input.fetcher,
  );
}
