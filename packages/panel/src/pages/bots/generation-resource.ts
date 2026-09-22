import { authFetch } from "@/lib/client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GenerationSource } from "./generation-types";

interface ApiErrorBody {
  ok: false;
  error: string;
}

export interface GenerationTarget {
  botId: string;
  source: GenerationSource;
  id: string;
}

export type GenerationDeleteResult = "deleted" | "missing" | "active" | "unknown";
export type GenerationTargetState = "present" | "missing" | "bot-missing" | "unknown";

const pendingDeletes = new Map<string, Promise<GenerationDeleteResult>>();

class GenerationReadError extends Error {
  constructor(readonly kind: "not-found" | "failed") {
    super(kind);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isErrorBody(value: unknown, error: string): value is ApiErrorBody {
  return isRecord(value) && value["ok"] === false && value["error"] === error;
}

function isSuccessBody(value: unknown): value is Record<string, unknown> & { ok: true } {
  return isRecord(value) && value["ok"] === true;
}

export async function requireGenerationRead<T>(
  response: Response,
  options: { notFound?: boolean; validate: (body: unknown) => body is T },
): Promise<T> {
  const body = await readJson(response);
  if (response.ok && isSuccessBody(body) && options.validate(body)) return body;
  if (options.notFound && response.status === 404 && isErrorBody(body, "Generation not found")) {
    throw new GenerationReadError("not-found");
  }
  throw new GenerationReadError("failed");
}

export function useGenerationResource<T>(
  key: string | null,
  request: (signal: AbortSignal) => Promise<T>,
) {
  const [state, setState] = useState<{
    key: string | null;
    result: T | null;
    pending: boolean;
    failure: "not-found" | "failed" | null;
  }>({ key: null, result: null, pending: false, failure: null });
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (key === null || activeKeyRef.current !== key) return false;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      generation === generationRef.current &&
      activeKeyRef.current === key;
    setState((previous) => ({
      key,
      result: previous.key === key ? previous.result : null,
      pending: true,
      failure: null,
    }));
    try {
      const result = await request(controller.signal);
      if (!isCurrent()) return false;
      setState({ key, result, pending: false, failure: null });
      return true;
    } catch (error) {
      if (isCurrent()) {
        setState((previous) => ({
          ...previous,
          pending: false,
          failure:
            error instanceof GenerationReadError && error.kind === "not-found"
              ? "not-found"
              : "failed",
        }));
      }
      return false;
    }
  }, [key, request]);

  useLayoutEffect(() => {
    activeKeyRef.current = key;
    if (key !== null) void refresh();
    return () => {
      activeKeyRef.current = null;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [key, refresh]);

  const current = key !== null && state.key === key;
  return {
    result: current ? state.result : null,
    loading: key !== null && (!current || state.pending),
    failure: current ? state.failure : null,
    refresh,
  };
}

export function generationTargetUrl(target: GenerationTarget): string {
  return `/api/bots/${encodeURIComponent(target.botId)}/generations/${target.source}/${encodeURIComponent(target.id)}`;
}

export function deleteGeneration(target: GenerationTarget): Promise<GenerationDeleteResult> {
  const key = `${target.botId}:${target.source}:${target.id}`;
  const pending = pendingDeletes.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const response = await authFetch(generationTargetUrl(target), { method: "DELETE" });
      const body = await readJson(response);
      if (response.ok && isSuccessBody(body)) return "deleted";
      if (response.status === 404 && isErrorBody(body, "Generation not found")) return "missing";
      if (
        response.status === 409 &&
        isErrorBody(body, "Cancel an active generation before deleting it")
      ) {
        return "active";
      }
    } catch {
      // The server may have completed the write before the connection failed.
    }
    return "unknown";
  })();
  const tracked = request.finally(() => {
    if (pendingDeletes.get(key) === tracked) pendingDeletes.delete(key);
  });
  pendingDeletes.set(key, tracked);
  return tracked;
}

export async function verifyGenerationTarget(
  target: GenerationTarget,
  signal: AbortSignal,
): Promise<GenerationTargetState> {
  try {
    const botResponse = await authFetch(`/api/bots/${encodeURIComponent(target.botId)}`, {
      signal,
    });
    const botBody = await readJson(botResponse);
    if (botResponse.status === 404 && isErrorBody(botBody, "Bot not found")) {
      return "bot-missing";
    }
    if (
      !botResponse.ok ||
      !isSuccessBody(botBody) ||
      !isRecord(botBody["data"]) ||
      botBody["data"]["id"] !== target.botId
    ) {
      return "unknown";
    }

    const response = await authFetch(generationTargetUrl(target), { signal });
    const body = await readJson(response);
    if (
      response.ok &&
      isSuccessBody(body) &&
      isRecord(body["data"]) &&
      String(body["data"]["id"]) === target.id &&
      body["data"]["source"] === target.source
    ) {
      return "present";
    }
    if (response.status === 404 && isErrorBody(body, "Generation not found")) return "missing";
  } catch {
    // Authentication redirects, aborts, and transport failures cannot confirm target state.
  }
  return "unknown";
}
