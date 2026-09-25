import type { RepoPolicy } from "./config/schema.js";
import { type ChangedFile, matchesAny } from "./risk.js";

export interface CheckRunInput {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CommitStatusInput {
  context: string;
  state: string;
}

export interface CheckSummary {
  state: "success" | "pending" | "failure" | "none";
  total: number;
  passed: number;
  pending: number;
  failed: number;
  failedNames: string[];
  missingRequired: string[];
  /** No checks yet, but they are still expected to register (ci-expectation.ts). */
  awaitingRegistration?: boolean;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Re-runs create several check runs with the same name; only the newest decides. `required`
 * limits evaluation to the branch's required checks, and a missing required check stays pending.
 */
export function summarizeChecks(
  runs: readonly CheckRunInput[],
  statuses: readonly CommitStatusInput[],
  required: readonly string[] | null = null,
): CheckSummary {
  const latest = new Map<string, "pass" | "pending" | "fail">();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    latest.set(
      run.name,
      run.status !== "completed"
        ? "pending"
        : PASSING_CONCLUSIONS.has(run.conclusion ?? "")
          ? "pass"
          : "fail",
    );
  }
  for (const status of statuses) {
    if (latest.has(status.context)) continue;
    latest.set(
      status.context,
      status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail",
    );
  }
  const names = required ? [...required] : [...latest.keys()];
  const missingRequired = required ? required.filter((name) => !latest.has(name)) : [];
  let passed = 0;
  let pending = missingRequired.length;
  const failedNames: string[] = [];
  for (const name of names) {
    const state = latest.get(name);
    if (state === "pass") passed++;
    else if (state === "pending") pending++;
    else if (state === "fail") failedNames.push(name);
  }
  const total = names.length;
  const state =
    total === 0 ? "none" : failedNames.length > 0 ? "failure" : pending > 0 ? "pending" : "success";
  return {
    state,
    total,
    passed,
    pending,
    failed: failedNames.length,
    failedNames,
    missingRequired,
  };
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?(https:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/i;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["']/i;

export function extractFirstImage(body: string | null | undefined): string | null {
  if (!body) return null;
  const candidates = [MARKDOWN_IMAGE.exec(body), HTML_IMAGE.exec(body)]
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => a.index - b.index);
  return candidates[0]?.[1] ?? null;
}

export const SECTION_ALIASES: Record<string, readonly string[]> = {
  verify: ["验证", "verify", "verification", "testing", "test plan", "tests"],
  review: ["审查", "review", "code review"],
};

export const SECTION_LABELS: Record<string, string> = { verify: "验证", review: "审查" };

function normalizeHeading(text: string): string {
  return text
    .replace(/[*_`:：]/g, "")
    .trim()
    .toLowerCase();
}

export function hasSection(body: string | null | undefined, section: string): boolean {
  if (!body) return false;
  const aliases = (SECTION_ALIASES[section] ?? [section]).map((alias) => alias.toLowerCase());
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    const bold = /^\s*\*\*(.+?)\*\*\s*[:：]?\s*$/.exec(line)?.[1];
    const title = heading ?? bold;
    if (title && aliases.includes(normalizeHeading(title))) return true;
  }
  return false;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/;
const ADDED_SKIP =
  /^\+(?!\+\+).*(\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe)\(|@pytest\.mark\.skip|\bt\.Skip\()/m;

export function detectTestWeakening(files: readonly ChangedFile[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    if (file.status === "removed" && TEST_FILE.test(file.filename)) {
      findings.push(`删除了测试 ${file.filename}`);
    } else if (file.patch && ADDED_SKIP.test(file.patch)) {
      findings.push(`${file.filename} 新增了 skip`);
    }
  }
  return findings;
}

export type ContractItemKey = "ci" | "sections" | "screenshots" | "releaseFragment";

export interface ContractItem {
  key: ContractItemKey;
  ok: boolean;
  /** Informational gaps are shown but never block. */
  blocking: boolean;
  label: string;
}

export interface ContractResult {
  items: ContractItem[];
  missing: string[];
  flags: string[];
  touchesUi: boolean;
  hasImage: boolean;
}

export const RELEASE_FRAGMENT_PATTERN = ".release/changes/*.md";

export function evaluateContract(input: {
  policy: Pick<RepoPolicy, "contract">;
  body: string | null;
  files: readonly ChangedFile[];
  checks: CheckSummary;
  bodyEditedAt: Date | null;
  lastPushAt: Date | null;
}): ContractResult {
  const { contract } = input.policy;
  const items: ContractItem[] = [];
  const ciOk = input.checks.state === "success" || input.checks.state === "none";
  items.push({ key: "ci", ok: ciOk, blocking: true, label: "CI 全绿" });

  const missingSections = contract.sections.filter((section) => !hasSection(input.body, section));
  items.push({
    key: "sections",
    ok: missingSections.length === 0,
    blocking: false,
    label:
      missingSections.length === 0
        ? "PR 描述段落齐全"
        : `PR 描述缺少「${missingSections.map((s) => SECTION_LABELS[s] ?? s).join("」「")}」`,
  });

  const hasImage = extractFirstImage(input.body) !== null;
  const touchesUi = input.files.some((file) => matchesAny(file.filename, contract.uiPaths));
  const needsScreenshot =
    contract.screenshots === "always" || (contract.screenshots === "when-ui" && touchesUi);
  if (needsScreenshot) {
    items.push({
      key: "screenshots",
      ok: hasImage,
      blocking: false,
      label: hasImage ? "附有截图" : "改到 UI 但没有截图",
    });
  }

  const hasFragment = input.files.some(
    (file) => file.status !== "removed" && matchesAny(file.filename, [RELEASE_FRAGMENT_PATTERN]),
  );
  if (contract.releaseFragment === "required" && !hasFragment) {
    // release-kit is not wired in yet (plan 2.4), so a missing fragment is only reported.
    items.push({
      key: "releaseFragment",
      ok: false,
      blocking: false,
      label: "未检测到发版片段（release-kit 接入前不要求）",
    });
  }

  const flags: string[] = [];
  const hasEvidence = hasImage || hasSection(input.body, "verify");
  if (
    contract.flags.staleEvidence &&
    hasEvidence &&
    input.bodyEditedAt &&
    input.lastPushAt &&
    input.lastPushAt > input.bodyEditedAt
  ) {
    flags.push("证据之后又有新提交");
  }
  if (contract.flags.testDeletion) flags.push(...detectTestWeakening(input.files).slice(0, 3));

  const missing = items
    .filter((item) => !item.ok && item.key !== "ci" && item.key !== "releaseFragment")
    .map((item) => item.label);
  return { items, missing, flags, touchesUi, hasImage };
}
