export type BotRuntimeStatus = "running" | "stopped" | "restarting";
export type LifecycleAction = "enable" | "disable" | "restart";

export interface BotLifecycleView {
  desiredActive: boolean;
  runtimeStatus: BotRuntimeStatus;
  reconciled: boolean;
  persisted?: true;
  applied?: boolean;
  errorCode?: "start_failed" | "stop_failed" | "restart_failed";
}

export interface BotSettingsView {
  revision: string;
  ai: { enabled: boolean; systemPrompt: string };
}

export interface BotSettingsMutation {
  persisted: true;
  applied: boolean;
  applyState: "applied" | "pending";
  errorCode?: "restart_failed";
  settings: BotSettingsView;
}

export class MiniAppBotSettingsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly latest?: BotSettingsView,
  ) {
    super(message);
    this.name = "MiniAppBotSettingsApiError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBotLifecycle(value: unknown): BotLifecycleView | null {
  if (!isRecord(value)) return null;
  const status = value["runtimeStatus"];
  if (
    typeof value["desiredActive"] !== "boolean" ||
    (status !== "running" && status !== "stopped" && status !== "restarting") ||
    typeof value["reconciled"] !== "boolean"
  ) {
    return null;
  }
  if (value["persisted"] !== undefined && value["persisted"] !== true) return null;
  if (value["applied"] !== undefined && typeof value["applied"] !== "boolean") return null;
  const errorCode = value["errorCode"];
  if (
    errorCode !== undefined &&
    errorCode !== "start_failed" &&
    errorCode !== "stop_failed" &&
    errorCode !== "restart_failed"
  ) {
    return null;
  }
  return {
    desiredActive: value["desiredActive"],
    runtimeStatus: status,
    reconciled: value["reconciled"],
    ...(value["persisted"] === true ? { persisted: true as const } : {}),
    ...(typeof value["applied"] === "boolean" ? { applied: value["applied"] } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function parseBotSettings(value: unknown): BotSettingsView | null {
  if (!isRecord(value) || !isRecord(value["ai"])) return null;
  const ai = value["ai"];
  if (
    typeof value["revision"] !== "string" ||
    value["revision"].length < 1 ||
    value["revision"].length > 512 ||
    typeof ai["enabled"] !== "boolean" ||
    typeof ai["systemPrompt"] !== "string" ||
    ai["systemPrompt"].length > 50_000
  ) {
    return null;
  }
  return {
    revision: value["revision"],
    ai: { enabled: ai["enabled"], systemPrompt: ai["systemPrompt"] },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function endpoint(botId: string, suffix: string): string {
  return `/api/mini-app/${encodeURIComponent(botId)}/${suffix}`;
}

export async function fetchBotLifecycle(
  botId: string,
  fetcher: Fetcher = fetch,
): Promise<BotLifecycleView> {
  const response = await fetcher(endpoint(botId, "lifecycle"), { credentials: "same-origin" });
  const body = await readJson(response);
  const lifecycle = parseBotLifecycle(body["lifecycle"]);
  if (!response.ok || body["ok"] !== true || !lifecycle) {
    throw new MiniAppBotSettingsApiError("Bot lifecycle is unavailable", response.status);
  }
  return lifecycle;
}

export async function mutateBotLifecycle(input: {
  botId: string;
  action: LifecycleAction;
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<BotLifecycleView> {
  const response = await (input.fetcher ?? fetch)(
    endpoint(input.botId, `lifecycle/${input.action}`),
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-mini-app-csrf": input.csrfToken },
    },
  );
  const body = await readJson(response);
  const lifecycle = parseBotLifecycle(body["lifecycle"]);
  if (!response.ok || body["ok"] !== true || !lifecycle) {
    throw new MiniAppBotSettingsApiError(
      typeof body["error"] === "string" ? body["error"] : "Lifecycle operation failed",
      response.status,
      typeof body["code"] === "string" ? body["code"] : undefined,
    );
  }
  return lifecycle;
}

export async function fetchBotSettings(
  botId: string,
  fetcher: Fetcher = fetch,
): Promise<BotSettingsView> {
  const response = await fetcher(endpoint(botId, "settings"), { credentials: "same-origin" });
  const body = await readJson(response);
  const settings = parseBotSettings(body["settings"]);
  if (!response.ok || body["ok"] !== true || !settings) {
    throw new MiniAppBotSettingsApiError("Bot settings are unavailable", response.status);
  }
  return settings;
}

export async function patchBotSettings(input: {
  botId: string;
  expectedRevision: string;
  patch: { enabled: boolean; systemPrompt: string };
  csrfToken: string;
  fetcher?: Fetcher;
}): Promise<BotSettingsMutation> {
  const response = await (input.fetcher ?? fetch)(endpoint(input.botId, "settings"), {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-mini-app-csrf": input.csrfToken,
    },
    body: JSON.stringify({ expectedRevision: input.expectedRevision, patch: input.patch }),
  });
  const body = await readJson(response);
  if (!response.ok || body["ok"] !== true) {
    throw new MiniAppBotSettingsApiError(
      typeof body["error"] === "string" ? body["error"] : "Bot settings update failed",
      response.status,
      typeof body["code"] === "string" ? body["code"] : undefined,
      parseBotSettings(body["latest"]) ?? undefined,
    );
  }
  const settings = parseBotSettings(body["settings"]);
  if (
    !settings ||
    body["persisted"] !== true ||
    typeof body["applied"] !== "boolean" ||
    (body["applyState"] !== "applied" && body["applyState"] !== "pending")
  ) {
    throw new MiniAppBotSettingsApiError("Bot settings response is invalid", response.status);
  }
  return {
    persisted: true,
    applied: body["applied"],
    applyState: body["applyState"],
    ...(body["errorCode"] === "restart_failed" ? { errorCode: "restart_failed" as const } : {}),
    settings,
  };
}
