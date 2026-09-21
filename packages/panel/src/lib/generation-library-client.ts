import { authFetch } from "@/lib/client";
import type {
  CharacterBinding,
  CharacterInput,
  GenerationLibrarySettings,
  LibraryCharacter,
  LibraryListQuery,
  PromptAsset,
  PromptAssetInput,
} from "@cos-tool-bot/shared";

type SuccessEnvelope<T> = { ok: true; data: T };
type FailureEnvelope = { ok: false; error?: string };
type ApiEnvelope<T> = SuccessEnvelope<T> | FailureEnvelope;

function pathFor(botId: string, suffix: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/generation-library/${suffix}`;
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Generation library request failed (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Generation library request failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  if (!body || typeof body !== "object" || !("ok" in body)) {
    throw new Error("Generation library returned an invalid response");
  }
  return body as ApiEnvelope<T>;
}

function dataOrThrow<T>(envelope: ApiEnvelope<T>): T {
  if (envelope.ok !== true) {
    throw new Error("Generation library request was rejected");
  }
  return envelope.data;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return dataOrThrow(await parseEnvelope<T>(response));
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const response = await authFetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const envelope = await parseEnvelope<null>(response);
  if (envelope.ok !== true) throw new Error("Generation library request was rejected");
}

async function requestList<T>(url: string): Promise<{ data: T[]; total: number }> {
  const response = await authFetch(url);
  const envelope = await parseEnvelope<T[]>(response);
  if (envelope.ok !== true || !("total" in envelope) || typeof envelope.total !== "number") {
    throw new Error("Generation library returned an invalid list response");
  }
  return { data: envelope.data, total: envelope.total };
}

function jsonBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

function putBody(body: unknown): RequestInit {
  return { method: "PUT", body: JSON.stringify(body) };
}

export async function getLibrarySettings(botId: string): Promise<GenerationLibrarySettings> {
  return request<GenerationLibrarySettings>(pathFor(botId, "settings"));
}

export async function updateLibrarySettings(
  botId: string,
  settings: GenerationLibrarySettings,
): Promise<GenerationLibrarySettings> {
  return request<GenerationLibrarySettings>(pathFor(botId, "settings"), putBody(settings));
}

export async function listLibraryCharacters(
  botId: string,
  query: LibraryListQuery,
): Promise<{ data: LibraryCharacter[]; total: number }> {
  return requestList<LibraryCharacter>(
    `${pathFor(botId, "characters")}${queryString({
      search: query.search,
      page: query.page,
      limit: query.limit,
      source: query.source,
      sort: query.sort,
    })}`,
  );
}

export async function saveLibraryCharacter(
  botId: string,
  input: CharacterInput,
  id?: number,
): Promise<LibraryCharacter> {
  const suffix = id === undefined ? "characters" : `characters/${encodeURIComponent(String(id))}`;
  return request<LibraryCharacter>(
    pathFor(botId, suffix),
    id === undefined ? jsonBody(input) : putBody(input),
  );
}

export async function deleteLibraryCharacter(botId: string, id: number): Promise<void> {
  await requestVoid(pathFor(botId, `characters/${encodeURIComponent(String(id))}`), {
    method: "DELETE",
  });
}

export async function listLibraryAssets(
  botId: string,
  query: LibraryListQuery,
): Promise<{ data: PromptAsset[]; total: number }> {
  return requestList<PromptAsset>(
    `${pathFor(botId, "assets")}${queryString({
      search: query.search,
      page: query.page,
      limit: query.limit,
      type: query.type,
      safety: query.safety,
      sort: query.sort,
    })}`,
  );
}

export async function saveLibraryAsset(
  botId: string,
  input: PromptAssetInput,
  id?: number,
): Promise<PromptAsset> {
  const suffix = id === undefined ? "assets" : `assets/${encodeURIComponent(String(id))}`;
  return request<PromptAsset>(
    pathFor(botId, suffix),
    id === undefined ? jsonBody(input) : putBody(input),
  );
}

export async function deleteLibraryAsset(botId: string, id: number): Promise<void> {
  await requestVoid(pathFor(botId, `assets/${encodeURIComponent(String(id))}`), {
    method: "DELETE",
  });
}

export async function getCharacterBindings(
  botId: string,
  telegramId: number,
): Promise<CharacterBinding[]> {
  return request<CharacterBinding[]>(
    pathFor(botId, `bindings/${encodeURIComponent(String(telegramId))}`),
  );
}

export async function setCharacterBinding(
  botId: string,
  telegramId: number,
  input: { characterId: number; relation: "representation" | "favorite"; isDefault: boolean },
): Promise<void> {
  await requestVoid(
    pathFor(botId, `bindings/${encodeURIComponent(String(telegramId))}`),
    putBody(input),
  );
}

export async function removeCharacterBinding(
  botId: string,
  telegramId: number,
  characterId: number,
  relation: "representation" | "favorite",
): Promise<void> {
  await requestVoid(
    pathFor(
      botId,
      `bindings/${encodeURIComponent(String(telegramId))}/${encodeURIComponent(String(characterId))}/${encodeURIComponent(relation)}`,
    ),
    { method: "DELETE" },
  );
}
