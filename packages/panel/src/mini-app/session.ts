import {
  MINI_APP_CAPABILITIES,
  MINI_APP_ROLES,
  type MiniAppCapability,
  type MiniAppRole,
} from "@cos-tool-bot/shared";

export interface MiniAppSessionUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export interface MiniAppSessionView {
  user: MiniAppSessionUser;
  role: MiniAppRole;
  capabilities: readonly MiniAppCapability[];
  chatScope: { kind: "all" } | { kind: "none" } | { kind: "granted"; chatIds: readonly number[] };
  expiresAt: number;
  csrfToken: string;
}

export type MiniAppSessionState =
  | { status: "ready"; session: MiniAppSessionView }
  | { status: "expired" }
  | { status: "forbidden" }
  | { status: "unavailable" };

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseReadySession(value: unknown): MiniAppSessionView | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const user = value["user"];
  const access = value["access"];
  const session = value["session"];
  if (!isRecord(user) || !isRecord(access) || !isRecord(session)) return null;
  const role = access["role"];
  const capabilities = access["capabilities"];
  const chatScope = access["chatScope"];
  if (
    typeof user["id"] !== "number" ||
    !Number.isSafeInteger(user["id"]) ||
    !MINI_APP_ROLES.includes(role as MiniAppRole) ||
    !Array.isArray(capabilities) ||
    !capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        MINI_APP_CAPABILITIES.includes(capability as MiniAppCapability),
    ) ||
    !isRecord(chatScope) ||
    !["all", "none", "granted"].includes(String(chatScope["kind"])) ||
    typeof session["expiresAt"] !== "number" ||
    typeof session["csrfToken"] !== "string"
  ) {
    return null;
  }
  if (
    chatScope["kind"] === "granted" &&
    (!Array.isArray(chatScope["chatIds"]) ||
      !chatScope["chatIds"].every((chatId) => Number.isSafeInteger(chatId) && chatId < 0))
  ) {
    return null;
  }
  return {
    user: {
      id: user["id"],
      ...(typeof user["firstName"] === "string" ? { firstName: user["firstName"] } : {}),
      ...(typeof user["lastName"] === "string" ? { lastName: user["lastName"] } : {}),
      ...(typeof user["username"] === "string" ? { username: user["username"] } : {}),
    },
    role: role as MiniAppRole,
    capabilities: capabilities as MiniAppCapability[],
    chatScope: chatScope as MiniAppSessionView["chatScope"],
    expiresAt: session["expiresAt"],
    csrfToken: session["csrfToken"],
  };
}

async function readResponse(response: Response): Promise<MiniAppSessionState | null> {
  if (response.status === 401) return { status: "expired" };
  if (response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "unavailable" };
  try {
    const session = parseReadySession(await response.json());
    return session ? { status: "ready", session } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function bootstrapMiniAppSession(input: {
  botId: string;
  initData: string;
  fetcher?: Fetcher;
}): Promise<MiniAppSessionState> {
  const fetcher = input.fetcher ?? fetch;
  const endpoint = `/api/mini-app/${encodeURIComponent(input.botId)}/session`;
  try {
    const existing = await fetcher(endpoint, { credentials: "same-origin" });
    const existingState = await readResponse(existing);
    if (existingState?.status !== "expired" || input.initData.length === 0) {
      return existingState ?? { status: "unavailable" };
    }
    const created = await fetcher(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: input.initData }),
    });
    return (await readResponse(created)) ?? { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
