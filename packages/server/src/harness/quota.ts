import type { HarnessQuotaSnapshot } from "@cos-tool-bot/database";
import type { LodyLimit, LodyMachine, LodyWindow } from "./lody.js";
import { vendorOf } from "./config/execution.js";
import { percentValue } from "./config/units.js";

/** Name-only fallback; prefer `vendorOf` with the agent-config list when it is available. */
export function providerForAgent(agent: string): string {
  return vendorOf(agent, null);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Provider-wide windows always apply; labeled or named windows only to the matching model. */
function applies(limit: LodyLimit, window: LodyWindow, model: string | null): boolean {
  const scope = window.label ?? limit.limitName;
  if (!scope) return true;
  if (!model) return false;
  const a = normalize(scope);
  const b = normalize(model);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

function applicable(machine: LodyMachine, provider: string, model: string | null) {
  return machine.limits
    .filter((limit) => limit.providerId === provider)
    .flatMap((limit) =>
      limit.windows
        .filter((window) => applies(limit, window, model))
        .map((window) => ({ limit, window })),
    );
}

export function quotaSnapshot(
  machine: LodyMachine,
  provider: string,
  model: string | null,
): HarnessQuotaSnapshot {
  return {
    provider,
    windows: applicable(machine, provider, model).map(({ window }) => ({
      span: window.span,
      label: window.label,
      usedPercent: window.usedPercent,
      expired: window.expired,
    })),
  };
}

export interface QuotaBlock {
  span: "fiveHour" | "week";
  usedPercent: number;
  threshold: number;
  label: string | null;
}

/** Expired windows carry stale numbers and never block. */
export function quotaBlocks(
  machine: LodyMachine,
  provider: string,
  model: string | null,
  pauseAt: { fiveHour: string; week: string },
): QuotaBlock[] {
  const blocks: QuotaBlock[] = [];
  for (const { limit, window } of applicable(machine, provider, model)) {
    if (window.expired || window.span === "other") continue;
    const threshold = percentValue(pauseAt[window.span]);
    if (window.usedPercent >= threshold) {
      blocks.push({
        span: window.span,
        usedPercent: window.usedPercent,
        threshold,
        label: window.label ?? limit.limitName,
      });
    }
  }
  return blocks;
}

export function weeklyWarnings(machine: LodyMachine, warnAt: string) {
  const threshold = percentValue(warnAt);
  return machine.limits.flatMap((limit) =>
    limit.windows
      .filter((w) => w.span === "week" && !w.expired && w.usedPercent >= threshold)
      .map((window) => ({ limit, window, threshold })),
  );
}

export function renderFooter(
  job: {
    contextUsed: number | null;
    contextSize: number | null;
    quota: HarnessQuotaSnapshot | null;
  } | null,
  cards: { showQuota: boolean; showContext: boolean },
): string | null {
  if (!job) return null;
  const parts: string[] = [];
  if (cards.showContext && job.contextUsed !== null && job.contextSize) {
    parts.push(`上下文 ${Math.round((job.contextUsed / job.contextSize) * 100)}%`);
  }
  if (cards.showQuota && job.quota) {
    const live = job.quota.windows.filter((w) => !w.expired);
    const week =
      live.find((w) => w.span === "week" && !w.label) ?? live.find((w) => w.span === "week");
    const fiveHour = live.find((w) => w.span === "fiveHour");
    const quota = [
      week ? `${week.label ?? job.quota.provider} 本周 ${week.usedPercent}%` : null,
      fiveHour ? `5 小时 ${fiveHour.usedPercent}%` : null,
    ].filter((part): part is string => part !== null);
    parts.push(...quota);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Midnight in the configured time zone, for the daily session cap. */
export function startOfDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsed = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
  return new Date(now.getTime() - elapsed - now.getMilliseconds());
}
