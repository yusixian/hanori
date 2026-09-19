import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import type { WrapperContext } from "../context.js";
import { getToolStatusLabel } from "../tools/descriptors.js";
import { type RequestCache, wrapToolsWithCache } from "../tools/utils.js";
import { trackSuccessfulToolEffects } from "../tools/visible-effects.js";
import { wrapToolsWithLogging } from "./tool-log.js";

export function wrapToolsWithStatus(
  tools: Record<string, Tool>,
  ctx: WrapperContext,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!("execute" in t) || typeof t.execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const status = getToolStatusLabel(name) ?? "🛠️ 使用工具中...";
    const originalExecute = t.execute;
    wrapped[name] = {
      ...t,
      execute: async (...args: Parameters<typeof originalExecute>) => {
        if (ctx.waiting_message) {
          await ctx.resolveWait(status).catch(() => {});
        } else {
          await ctx.wait(status).catch(() => {});
        }
        return originalExecute(...args);
      },
    };
  }
  return wrapped;
}

export interface TurnToolPipelineOptions {
  requestCache: RequestCache;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  getStep: () => number;
  onEffect: (toolName: string) => void;
  /** Present only on the message path; enables the Telegram status decorator. */
  statusContext?: WrapperContext;
}

/**
 * Applies the decorators that every AI turn needs, in the order the streamed run depends on:
 * effect tracking closest to the tool, then per-request caching, then logging, then the
 * Telegram status message that only the message path can render.
 */
export function composeTurnTools(
  tools: Record<string, Tool>,
  options: TurnToolPipelineOptions,
): Record<string, Tool> {
  const composed = wrapToolsWithLogging(
    wrapToolsWithCache(trackSuccessfulToolEffects(tools, options.onEffect), options.requestCache),
    { onLog: options.onLog, getStep: options.getStep },
  );
  return options.statusContext ? wrapToolsWithStatus(composed, options.statusContext) : composed;
}
