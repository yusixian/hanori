export type AiSelectionApplyState = "applied" | "pending";
export type AiSelectionDisplayPolicy = "inherit" | "show" | "hide";

export interface AiSelectionOptionModel {
  id: string;
  label: string;
}

export interface AiSelectionOptionProvider {
  id: string;
  label: string;
  defaultModelId: string;
  models: AiSelectionOptionModel[];
}

export interface SafeAiSelection {
  providerLabel: string;
  modelLabel: string;
}

export interface AdminAiSelection extends SafeAiSelection {
  providerId: string;
  modelId: string | null;
}

export interface GlobalAiSelectionView {
  revision: string;
  applyState: AiSelectionApplyState;
  displayDefault: "show" | "hide";
  selection: AdminAiSelection;
  options: AiSelectionOptionProvider[];
}

interface ChatAiSelectionBase {
  revision: string;
  source: "global" | "chat";
  archived: boolean;
  applyState: AiSelectionApplyState;
}

export interface AdminChatAiSelectionView extends ChatAiSelectionBase {
  selection: AdminAiSelection;
  options: AiSelectionOptionProvider[];
  display: {
    defaultPolicy: "show" | "hide";
    overridePolicy: AiSelectionDisplayPolicy;
    visible: boolean;
  };
}

export interface PublicChatAiSelectionView extends ChatAiSelectionBase {
  selection?: SafeAiSelection;
}

export type ChatAiSelectionView = AdminChatAiSelectionView | PublicChatAiSelectionView;
export type AiSelectionErrorCode =
  | "stale_revision"
  | "archived"
  | "ai_not_configured"
  | "provider_unavailable"
  | "model_unavailable"
  | "unavailable";

export class MiniAppAiSelectionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: AiSelectionErrorCode,
    readonly latest?: GlobalAiSelectionView | AdminChatAiSelectionView,
  ) {
    super(message);
    this.name = "MiniAppAiSelectionApiError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const SENSITIVE_KEYS = new Set([
  "apiKey",
  "baseURL",
  "credentials",
  "encryptedApiKey",
  "history",
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

function containsSensitiveProjection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveProjection);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => SENSITIVE_KEYS.has(key) || containsSensitiveProjection(child),
  );
}

function containsInternalSelectionIds(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInternalSelectionIds);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "providerId" || key === "modelId" || containsInternalSelectionIds(child),
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function parseApplyState(value: unknown): AiSelectionApplyState | null {
  return value === "applied" || value === "pending" ? value : null;
}

function parseSafeSelection(value: unknown): SafeAiSelection | null {
  if (
    !isRecord(value) ||
    containsSensitiveProjection(value) ||
    !validLabel(value["providerLabel"]) ||
    !validLabel(value["modelLabel"])
  ) {
    return null;
  }
  return { providerLabel: value["providerLabel"], modelLabel: value["modelLabel"] };
}

function parseAdminSelection(value: unknown): AdminAiSelection | null {
  const safe = parseSafeSelection(value);
  if (
    !safe ||
    !isRecord(value) ||
    !validId(value["providerId"]) ||
    !(value["modelId"] === null || validId(value["modelId"]))
  ) {
    return null;
  }
  return { ...safe, providerId: value["providerId"], modelId: value["modelId"] };
}

function parseOptions(value: unknown): AiSelectionOptionProvider[] | null {
  if (!Array.isArray(value) || containsSensitiveProjection(value)) return null;
  const options: AiSelectionOptionProvider[] = [];
  for (const provider of value) {
    if (
      !isRecord(provider) ||
      !validId(provider["id"]) ||
      !validLabel(provider["label"]) ||
      !validId(provider["defaultModelId"]) ||
      !Array.isArray(provider["models"])
    ) {
      return null;
    }
    const models: AiSelectionOptionModel[] = [];
    for (const model of provider["models"]) {
      if (!isRecord(model) || !validId(model["id"]) || !validLabel(model["label"])) return null;
      models.push({ id: model["id"], label: model["label"] });
    }
    if (models.length === 0 || !models.some((model) => model.id === provider["defaultModelId"])) {
      return null;
    }
    options.push({
      id: provider["id"],
      label: provider["label"],
      defaultModelId: provider["defaultModelId"],
      models,
    });
  }
  return options.length > 0 ? options : null;
}

function selectionMatchesOptions(
  selection: AdminAiSelection,
  options: readonly AiSelectionOptionProvider[],
): boolean {
  const provider = options.find((candidate) => candidate.id === selection.providerId);
  if (!provider || provider.label !== selection.providerLabel) return false;
  const modelId = selection.modelId ?? provider.defaultModelId;
  return provider.models.some(
    (model) => model.id === modelId && model.label === selection.modelLabel,
  );
}

export function parseGlobalAiSelection(value: unknown): GlobalAiSelectionView | null {
  if (!isRecord(value) || containsSensitiveProjection(value)) return null;
  const applyState = parseApplyState(value["applyState"]);
  const selection = parseAdminSelection(value["selection"]);
  const options = parseOptions(value["options"]);
  if (
    typeof value["revision"] !== "string" ||
    value["revision"].length < 1 ||
    value["revision"].length > 512 ||
    !applyState ||
    (value["displayDefault"] !== "show" && value["displayDefault"] !== "hide") ||
    !selection ||
    !options ||
    !selectionMatchesOptions(selection, options)
  ) {
    return null;
  }
  return {
    revision: value["revision"],
    applyState,
    displayDefault: value["displayDefault"],
    selection,
    options,
  };
}

function parseChatBase(value: Record<string, unknown>): ChatAiSelectionBase | null {
  const applyState = parseApplyState(value["applyState"]);
  if (
    typeof value["revision"] !== "string" ||
    value["revision"].length < 1 ||
    value["revision"].length > 512 ||
    (value["source"] !== "global" && value["source"] !== "chat") ||
    typeof value["archived"] !== "boolean" ||
    !applyState
  ) {
    return null;
  }
  return {
    revision: value["revision"],
    source: value["source"],
    archived: value["archived"],
    applyState,
  };
}

export function parseAdminChatAiSelection(value: unknown): AdminChatAiSelectionView | null {
  if (!isRecord(value) || containsSensitiveProjection(value)) return null;
  const base = parseChatBase(value);
  const selection = parseAdminSelection(value["selection"]);
  const options = parseOptions(value["options"]);
  const display = value["display"];
  if (
    !base ||
    !selection ||
    !options ||
    !selectionMatchesOptions(selection, options) ||
    !isRecord(display) ||
    (display["defaultPolicy"] !== "show" && display["defaultPolicy"] !== "hide") ||
    !["inherit", "show", "hide"].includes(String(display["overridePolicy"])) ||
    typeof display["visible"] !== "boolean"
  ) {
    return null;
  }
  return {
    ...base,
    selection,
    options,
    display: {
      defaultPolicy: display["defaultPolicy"],
      overridePolicy: display["overridePolicy"] as AiSelectionDisplayPolicy,
      visible: display["visible"],
    },
  };
}

export function parsePublicChatAiSelection(value: unknown): PublicChatAiSelectionView | null {
  if (!isRecord(value) || containsSensitiveProjection(value)) return null;
  if ("options" in value || "display" in value || containsInternalSelectionIds(value)) {
    return null;
  }
  const base = parseChatBase(value);
  if (!base) return null;
  if (!("selection" in value)) return base;
  const selection = parseSafeSelection(value["selection"]);
  return selection ? { ...base, selection } : null;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function endpoint(botId: string, suffix: string): string {
  return `/api/mini-app/${encodeURIComponent(botId)}${suffix}`;
}

function parseErrorCode(value: unknown): AiSelectionErrorCode | undefined {
  return [
    "stale_revision",
    "archived",
    "ai_not_configured",
    "provider_unavailable",
    "model_unavailable",
    "unavailable",
  ].includes(String(value))
    ? (value as AiSelectionErrorCode)
    : undefined;
}

function throwApiError(
  response: Response,
  body: unknown,
  parseLatest?: (value: unknown) => GlobalAiSelectionView | AdminChatAiSelectionView | null,
): never {
  const record = isRecord(body) && !containsSensitiveProjection(body) ? body : {};
  const latest = parseLatest ? parseLatest(record["latest"]) : null;
  throw new MiniAppAiSelectionApiError(
    typeof record["error"] === "string" ? record["error"] : "AI selection request failed",
    response.status,
    parseErrorCode(record["code"]),
    latest ?? undefined,
  );
}

function mutationInit(csrfToken: string, body?: unknown): RequestInit {
  return {
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-mini-app-csrf": csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function fetchGlobalAiSelection(
  botId: string,
  fetcher: Fetcher = fetch,
): Promise<GlobalAiSelectionView> {
  const response = await fetcher(endpoint(botId, "/ai-selection/global"), {
    credentials: "same-origin",
  });
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  const global =
    isRecord(body) && body["ok"] === true ? parseGlobalAiSelection(body["global"]) : null;
  if (!global)
    throw new MiniAppAiSelectionApiError(
      "Global AI selection response was invalid",
      response.status,
    );
  return global;
}

export async function patchGlobalAiSelection(input: {
  botId: string;
  expectedRevision: string;
  providerId: string;
  modelId: string | null;
  displayDefault: "show" | "hide";
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<{ persisted: boolean; applied: boolean; global: GlobalAiSelectionView }> {
  const response = await (input.fetcher ?? fetch)(endpoint(input.botId, "/ai-selection/global"), {
    method: "PATCH",
    ...mutationInit(input.csrfToken, {
      expectedRevision: input.expectedRevision,
      providerId: input.providerId,
      modelId: input.modelId,
      displayDefault: input.displayDefault,
    }),
  });
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body, parseGlobalAiSelection);
  const global =
    isRecord(body) && body["ok"] === true ? parseGlobalAiSelection(body["global"]) : null;
  if (
    !global ||
    !isRecord(body) ||
    typeof body["persisted"] !== "boolean" ||
    typeof body["applied"] !== "boolean"
  ) {
    throw new MiniAppAiSelectionApiError(
      "Global AI selection mutation response was invalid",
      response.status,
    );
  }
  return { persisted: body["persisted"], applied: body["applied"], global };
}

export async function fetchChatAiSelection(input: {
  botId: string;
  chatId: number;
  admin: boolean;
  fetcher?: Fetcher;
}): Promise<ChatAiSelectionView> {
  const response = await (input.fetcher ?? fetch)(
    endpoint(input.botId, `/groups/${input.chatId}/ai-selection`),
    { credentials: "same-origin" },
  );
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body);
  const chat =
    isRecord(body) && body["ok"] === true
      ? input.admin
        ? parseAdminChatAiSelection(body["chat"])
        : parsePublicChatAiSelection(body["chat"])
      : null;
  if (!chat)
    throw new MiniAppAiSelectionApiError("Chat AI selection response was invalid", response.status);
  return chat;
}

async function chatMutation(input: {
  botId: string;
  chatId: number;
  csrfToken: string;
  method: "PATCH" | "DELETE";
  suffix?: string;
  body: unknown;
  fetcher?: Fetcher;
}): Promise<{ persisted: boolean; applied: boolean; chat: AdminChatAiSelectionView }> {
  const response = await (input.fetcher ?? fetch)(
    endpoint(input.botId, `/groups/${input.chatId}/ai-selection${input.suffix ?? ""}`),
    { method: input.method, ...mutationInit(input.csrfToken, input.body) },
  );
  const body = await responseBody(response);
  if (!response.ok) return throwApiError(response, body, parseAdminChatAiSelection);
  const chat =
    isRecord(body) && body["ok"] === true ? parseAdminChatAiSelection(body["chat"]) : null;
  if (
    !chat ||
    !isRecord(body) ||
    typeof body["persisted"] !== "boolean" ||
    typeof body["applied"] !== "boolean"
  ) {
    throw new MiniAppAiSelectionApiError(
      "Chat AI selection mutation response was invalid",
      response.status,
    );
  }
  return { persisted: body["persisted"], applied: body["applied"], chat };
}

export function patchChatAiSelection(input: {
  botId: string;
  chatId: number;
  expectedRevision: string;
  providerId: string;
  modelId: string | null;
  csrfToken: string;
  fetcher?: Fetcher;
}) {
  return chatMutation({
    ...input,
    method: "PATCH",
    body: {
      expectedRevision: input.expectedRevision,
      providerId: input.providerId,
      modelId: input.modelId,
    },
  });
}

export function resetChatAiSelection(input: {
  botId: string;
  chatId: number;
  expectedRevision: string;
  csrfToken: string;
  fetcher?: Fetcher;
}) {
  return chatMutation({
    ...input,
    method: "DELETE",
    body: { expectedRevision: input.expectedRevision },
  });
}

export function patchChatAiSelectionDisplay(input: {
  botId: string;
  chatId: number;
  expectedRevision: string;
  policy: AiSelectionDisplayPolicy;
  csrfToken: string;
  fetcher?: Fetcher;
}) {
  return chatMutation({
    ...input,
    method: "PATCH",
    suffix: "/display",
    body: { expectedRevision: input.expectedRevision, policy: input.policy },
  });
}

export async function retryAiSelection(input: {
  botId: string;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<{ persisted: boolean; applied: boolean; applyState: AiSelectionApplyState }> {
  const response = await (input.fetcher ?? fetch)(endpoint(input.botId, "/ai-selection/retry"), {
    method: "POST",
    ...mutationInit(input.csrfToken),
  });
  const body = await responseBody(response);
  const applyState = isRecord(body) ? parseApplyState(body["applyState"]) : null;
  if (!response.ok) return throwApiError(response, body);
  if (
    !isRecord(body) ||
    body["ok"] !== true ||
    typeof body["persisted"] !== "boolean" ||
    typeof body["applied"] !== "boolean" ||
    !applyState
  ) {
    throw new MiniAppAiSelectionApiError(
      "AI selection retry response was invalid",
      response.status,
    );
  }
  return { persisted: body["persisted"], applied: body["applied"], applyState };
}
