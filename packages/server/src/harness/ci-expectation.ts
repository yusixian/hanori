import type { CheckSummary } from "./contract.js";
import type { HarnessGitHub } from "./github.js";

const WORKFLOW_DIR = ".github/workflows";
const MAX_WORKFLOW_FILES = 20;
const PR_TRIGGER = /\bpull_request(?:_target)?\b/;

/**
 * Whether PRs in a repo should get checks: some GitHub Actions workflow on the base branch
 * reacts to pull requests. Check suites are ignored on purpose; the App's check_suite
 * subscription can leave a queued suite with no runs behind on every commit.
 */
export class CiDetector {
  private readonly cache = new Map<string, { at: number; expected: boolean }>();

  async expected(github: HarnessGitHub, repo: string, ref: string, ttlMs: number, now: Date) {
    const key = `${repo.toLowerCase()}@${ref}`;
    const cached = this.cache.get(key);
    if (cached && now.getTime() - cached.at < ttlMs) return cached.expected;
    const entries = (await github.listDirectory(repo, WORKFLOW_DIR, ref)) ?? [];
    const files = entries
      .filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name))
      .slice(0, MAX_WORKFLOW_FILES);
    let expected = false;
    for (const file of files) {
      const text = await github.getFile(repo, `${WORKFLOW_DIR}/${file.name}`, ref);
      if (text && PR_TRIGGER.test(text)) {
        expected = true;
        break;
      }
    }
    this.cache.set(key, { at: now.getTime(), expected });
    return expected;
  }
}

export interface RegistrationWindow {
  expected: boolean;
  lastPushAt: Date | null;
  now: Date;
  graceMs: number;
  timeoutMs: number;
}

/**
 * GitHub registers checks a few seconds after a push, so "no checks" right after one is not a
 * green light. Returns the summary to use and, while waiting, when to look again.
 */
export function awaitRegistration(
  checks: CheckSummary,
  window: RegistrationWindow,
): { checks: CheckSummary; recheckAt: Date | null } {
  if (checks.state !== "none" || !window.lastPushAt) return { checks, recheckAt: null };
  const waitMs = window.expected ? Math.max(window.graceMs, window.timeoutMs) : window.graceMs;
  const deadline = window.lastPushAt.getTime() + waitMs;
  if (window.now.getTime() >= deadline) return { checks, recheckAt: null };
  return {
    checks: { ...checks, state: "pending", awaitingRegistration: true },
    recheckAt: new Date(deadline),
  };
}
