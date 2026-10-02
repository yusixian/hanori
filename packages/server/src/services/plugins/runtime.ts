import { createHash } from "node:crypto";
import type {
  PluginActor,
  PluginDefinition,
  PluginSession,
  PluginTool,
  SearchProvider,
} from "@cos-tool-bot/shared";

export class PluginRuntimeError extends Error {
  constructor(
    readonly code:
      | "plugin_failed"
      | "plugin_stopped"
      | "invalid_plugin"
      | "plugin_timeout"
      | "invalid_arguments"
      | "result_too_large",
  ) {
    super(code);
    this.name = "PluginRuntimeError";
  }
}

/** Deadline rejects late cooperative work without exposing plugin exception contents. */
export async function runPluginCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  combined.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new PluginRuntimeError(signal.aborted ? "plugin_stopped" : "plugin_timeout"));
    combined.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        combined.throwIfAborted();
        return operation(combined);
      })
      .then(
        (value) => {
          if (combined.aborted) abort();
          else resolve(value);
        },
        () => reject(new PluginRuntimeError("plugin_failed")),
      )
      .finally(() => combined.removeEventListener("abort", abort));
  });
}

export function validatePluginDefinition(value: unknown): PluginDefinition {
  if (
    !value ||
    typeof value !== "object" ||
    !("apiVersion" in value) ||
    value.apiVersion !== 1 ||
    !("createSession" in value) ||
    typeof value.createSession !== "function" ||
    ("check" in value && value.check !== undefined && typeof value.check !== "function")
  ) {
    throw new PluginRuntimeError("invalid_plugin");
  }
  return value as PluginDefinition;
}

const LOCAL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function validatePluginSession(session: PluginSession): void {
  if (
    !session ||
    typeof session !== "object" ||
    (session.dispose !== undefined && typeof session.dispose !== "function") ||
    (session.tools !== undefined && (!Array.isArray(session.tools) || session.tools.length > 32)) ||
    (session.searchProviders !== undefined &&
      (!Array.isArray(session.searchProviders) || session.searchProviders.length > 16))
  )
    throw new PluginRuntimeError("invalid_plugin");
  const names = new Set<string>();
  for (const tool of session.tools ?? []) {
    if (
      !tool ||
      !LOCAL_NAME.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 2_000 ||
      !tool.description.trim() ||
      !["read_only", "mutating"].includes(tool.effect) ||
      !["admin", "all"].includes(tool.access) ||
      typeof tool.execute !== "function" ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema) ||
      tool.inputSchema.type !== "object" ||
      JSON.stringify(tool.inputSchema).length > 16_384
    )
      throw new PluginRuntimeError("invalid_plugin");
    names.add(tool.name);
  }
  names.clear();
  for (const provider of session.searchProviders ?? []) {
    if (
      !provider ||
      !LOCAL_NAME.test(provider.id) ||
      names.has(provider.id) ||
      !LOCAL_NAME.test(provider.scope) ||
      typeof provider.description !== "string" ||
      provider.description.length > 2_000 ||
      typeof provider.search !== "function" ||
      !["native", "single_page"].includes(provider.pagination)
    )
      throw new PluginRuntimeError("invalid_plugin");
    names.add(provider.id);
  }
}

export function pluginPrefix(id: string) {
  return `plg_${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

export function bindPluginSession(options: {
  pluginId: string;
  session: PluginSession;
  actor: PluginActor;
  signal: AbortSignal;
  authorize: () => Promise<void>;
}): { tools: PluginTool[]; searchProviders: SearchProvider[] } {
  const { session, actor, signal, authorize } = options;
  validatePluginSession(session);
  const prefix = pluginPrefix(options.pluginId);
  const invoke = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callSignal: AbortSignal,
  ): Promise<T> => {
    const combined = AbortSignal.any([signal, callSignal]);
    return runPluginCall(async (boundedSignal) => {
      await authorize();
      boundedSignal.throwIfAborted();
      const result = await operation(boundedSignal);
      boundedSignal.throwIfAborted();
      await authorize();
      return result;
    }, combined);
  };
  return {
    tools: (session.tools ?? [])
      .filter(
        (tool) =>
          (tool.access !== "admin" || actor.isAdmin) &&
          (!actor.readOnly || tool.effect === "read_only"),
      )
      .map((tool) => ({
        ...tool,
        name: `${prefix}_${tool.name}`,
        description: `[${options.pluginId}] ${tool.description}`,
        execute: async (input, callSignal) =>
          invoke(async (boundedSignal) => {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              JSON.stringify(input).length > 32_000
            )
              throw new PluginRuntimeError("invalid_arguments");
            const result = await tool.execute(input, boundedSignal);
            const serialized = JSON.stringify(result);
            if (serialized === undefined || serialized.length > 64_000)
              throw new PluginRuntimeError("result_too_large");
            return JSON.parse(serialized) as unknown;
          }, callSignal),
      })),
    searchProviders: (session.searchProviders ?? []).map((provider) => ({
      ...provider,
      id: `${prefix}_${provider.id}`,
      description: `[${options.pluginId}] ${provider.description}`,
      search: (request, callSignal) =>
        invoke((boundedSignal) => provider.search(request, boundedSignal), callSignal),
    })),
  };
}
