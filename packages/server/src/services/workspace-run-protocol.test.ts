import type { GitHubCodingModelConfig } from "@cos-tool-bot/shared";
import { describe, expect, it } from "vitest";
import type { StagedWorkspace } from "./coding-job-stager.js";
import type { CodingWorkerJob } from "./coding-worker-client.js";
import {
  runWorkspaceProtocol,
  type WorkspaceRunControl,
  type WorkspaceRunPlan,
  type WorkspaceRunPorts,
} from "./workspace-run-protocol.js";

const model: GitHubCodingModelConfig = {
  apiKey: "model-secret",
  baseURL: "https://example.com/v1",
  id: "model",
  providerFormat: "openai",
  capabilities: ["tool_calling", "code"],
};
const staged: StagedWorkspace = {
  path: "/staging/workspace",
  identity: { path: "/staging/workspace", dev: 1, ino: 2 },
  rootIdentity: { path: "/staging", dev: 1, ino: 1 },
};
const FAILURE_MESSAGE = "Run failed; rollback and/or staging cleanup could not be completed";
const ROLLBACK = "rollback worktree=false";
const ROLLBACK_WORKTREE = "rollback worktree=true";
const CLEANUP = "cleanup";
const FULL_RUN = [
  "prepare",
  "waitForFreshBoot",
  "stage",
  "identity",
  "beforeRun",
  "run",
  "validateResult",
  "afterRun",
  "staged branch",
  "protected",
  "identity",
  "indexResult",
  "identity",
  "staged commit",
  "cleanup",
  "identity",
  "git rev-parse",
  "identity",
  "git reset",
  "afterReset",
  "git diff",
];

type TouchingHook = "prepare" | "beforeRun" | "indexResult" | "never";

interface HarnessOptions {
  touch?: TouchingHook;
  fail?: string[];
  indexed?: boolean;
  head?: string;
  stagedBranch?: string;
  commitMessage?: string;
  signal?: AbortSignal;
  onStep?: (name: string) => void;
}

/** Fake ports and plan; `fail` entries name a step, or its nth call as `step:n`. */
function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const jobs: CodingWorkerJob[] = [];
  const gitCalls: string[][] = [];
  const calls = new Map<string, number>();
  const step = (name: string) => {
    const count = (calls.get(name) ?? 0) + 1;
    calls.set(name, count);
    events.push(name);
    options.onStep?.(name);
    if (options.fail?.some((spec) => spec === name || spec === `${name}:${count}`)) {
      throw new Error(`${name} failed`);
    }
  };
  const touch = (hook: TouchingHook, control: WorkspaceRunControl) => {
    if (options.touch === hook) control.markCanonicalTouched();
  };
  const ports: WorkspaceRunPorts = {
    worker: {
      waitForFreshBoot: async () => step("waitForFreshBoot"),
      run: async (job) => {
        jobs.push(job);
        step("run");
        return { summary: "worker summary", durationMs: 1 };
      },
    },
    stager: {
      workspaceName: "workspace",
      validateResult: async () => step("validateResult"),
      cleanup: async () => step("cleanup"),
    },
    git: async (args) => {
      gitCalls.push(args);
      step(`git ${args[0]}`);
      if (args[0] === "rev-parse") return options.head ?? "head-sha";
      return args[0] === "diff" ? "a.txt\n\nb.txt" : "";
    },
    stagedGit: async (_staged, args) => {
      gitCalls.push(args);
      step(`staged ${args[0]}`);
      return args[0] === "branch" ? (options.stagedBranch ?? "feat/run") : "";
    },
    assertIdentity: async () => step("identity"),
    assertNoProtectedChanges: async () => step("protected"),
  };
  const plan: WorkspaceRunPlan = {
    repository: "owner/repo",
    branch: "feat/run",
    task: "Update README",
    model,
    commitMessage: options.commitMessage,
    defaultCommitMessage: "chore: default subject",
    failureMessage: FAILURE_MESSAGE,
    branchChangedMessage: (current) => `branch changed to ${current || "detached HEAD"}`,
    prepare: async (control) => {
      touch("prepare", control);
      step("prepare");
      return "base-sha";
    },
    stage: async () => {
      step("stage");
      return staged;
    },
    beforeRun: async (_staged, control) => {
      touch("beforeRun", control);
      step("beforeRun");
    },
    afterRun: async () => step("afterRun"),
    indexResult: async (_staged, control) => {
      touch("indexResult", control);
      step("indexResult");
      return options.indexed ?? true;
    },
    afterReset: async () => step("afterReset"),
    rollback: async (worktreeTouched) => step(`rollback worktree=${worktreeTouched}`),
  };
  return { events, jobs, gitCalls, run: () => runWorkspaceProtocol(ports, plan, options.signal) };
}

function eventsUntil(spec: string): string[] {
  const [name, occurrence = "1"] = spec.split(":");
  let seen = 0;
  const index = FULL_RUN.findIndex((event) => event === name && ++seen === Number(occurrence));
  return FULL_RUN.slice(0, index + 1);
}

// Rows: failing step, then the failure frame when the canonical workspace is first marked touched
// in beforeRun (code task), indexResult (resume), or prepare (a code task's branch checkout).
const FAILURE_FRAMES: Array<[string, string[], string[], string[]]> = [
  ["prepare", [], [], [ROLLBACK]],
  ["waitForFreshBoot", [], [], [ROLLBACK]],
  ["stage", [], [], [ROLLBACK]],
  ["identity:1", [CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["beforeRun", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["run", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["validateResult", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["afterRun", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["staged branch", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["protected", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["identity:2", [ROLLBACK, CLEANUP], [CLEANUP], [ROLLBACK, CLEANUP]],
  ["indexResult", [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP]],
  ["identity:3", [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP]],
  ["staged commit", [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP]],
  ["cleanup:1", [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP], [ROLLBACK, CLEANUP]],
  ["identity:4", [ROLLBACK], [ROLLBACK], [ROLLBACK]],
  ["git rev-parse", [ROLLBACK], [ROLLBACK], [ROLLBACK]],
  ["identity:5", [ROLLBACK], [ROLLBACK], [ROLLBACK]],
  ["git reset", [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE]],
  ["afterReset", [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE]],
  ["git diff", [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE], [ROLLBACK_WORKTREE]],
];

describe("workspace run protocol", () => {
  it("runs one bounded worker job between fixed identity checks and returns the commit", async () => {
    const { events, jobs, gitCalls, run } = harness();

    await expect(run()).resolves.toEqual({
      repository: "owner/repo",
      branch: "feat/run",
      commitSha: "head-sha",
      changedFiles: ["a.txt", "b.txt"],
      summary: "worker summary",
      status: "committed",
    });
    expect(events).toEqual(FULL_RUN);
    expect(jobs).toEqual([
      { workspacePath: "workspace", task: "Update README", timeoutMs: 240_000, model },
    ]);
    expect(gitCalls).toContainEqual(["reset", "--hard", "head-sha"]);
    expect(gitCalls).toContainEqual(["diff", "--name-only", "base-sha..head-sha"]);
  });

  it("skips the commit and reports no changes when nothing was indexed", async () => {
    const { events, run } = harness({ indexed: false, head: "base-sha" });

    await expect(run()).resolves.toMatchObject({
      commitSha: "base-sha",
      changedFiles: [],
      status: "no_changes",
    });
    expect(events).toEqual([
      ...eventsUntil("indexResult"),
      "cleanup",
      "identity",
      "git rev-parse",
      "identity",
      "git reset",
      "afterReset",
    ]);
  });

  it.each([
    ["  fix: tidy up\nlong body", "fix: tidy up"],
    [`feat: ${"x".repeat(300)}`, `feat: ${"x".repeat(194)}`],
    ["   ", "chore: default subject"],
    [undefined, "chore: default subject"],
  ])("commits %j with the subject %j", async (commitMessage, subject) => {
    const { gitCalls, run } = harness({ commitMessage });

    await run();

    expect(gitCalls).toContainEqual(["commit", "-m", subject]);
  });

  it("rejects a branch the worker switched to before indexing anything", async () => {
    const { events, run } = harness({ touch: "indexResult", stagedBranch: "" });

    await expect(run()).rejects.toThrow("branch changed to detached HEAD");
    expect(events).toEqual([...eventsUntil("staged branch"), CLEANUP]);
  });

  describe.each([
    ["code task", "beforeRun", 1],
    ["resume", "indexResult", 2],
    ["code task with a prepare checkout", "prepare", 3],
  ] as const)("%s failure frame", (_caller, touch, column) => {
    it.each(FAILURE_FRAMES.map((row) => [row[0], row[column]] as const))(
      "after %s fails runs %j",
      async (failure, frame) => {
        const { events, run } = harness({ touch, fail: [failure] });

        await expect(run()).rejects.toThrow(`${failure.split(":")[0]} failed`);
        expect(events).toEqual([...eventsUntil(failure), ...frame]);
      },
    );
  });

  it.each([
    ["identity:4", []],
    ["git rev-parse", [ROLLBACK]],
    ["git reset", [ROLLBACK_WORKTREE]],
  ])("treats the canonical workspace as touched from reading HEAD (%s)", async (failure, frame) => {
    const { events, run } = harness({ touch: "never", fail: [failure] });

    await expect(run()).rejects.toThrow(`${failure.split(":")[0]} failed`);
    expect(events).toEqual([...eventsUntil(failure), ...frame]);
  });

  it("aggregates rollback and staging cleanup failures under the plan's message", async () => {
    const { run } = harness({ touch: "beforeRun", fail: ["run", ROLLBACK, CLEANUP] });

    const error = await run().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(FAILURE_MESSAGE);
    expect((error as AggregateError).errors.map((failure: Error) => failure.message)).toEqual([
      "run failed",
      `${ROLLBACK} failed`,
      "cleanup failed",
    ]);
  });

  it("cleans staging, then stops before reading HEAD when cancelled during the commit", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const { events, run } = harness({
      touch: "beforeRun",
      signal: controller.signal,
      onStep: (name) => {
        if (name === "staged commit") controller.abort(reason);
      },
    });

    await expect(run()).rejects.toBe(reason);
    expect(events).toEqual([...eventsUntil("staged commit"), CLEANUP, ROLLBACK]);
  });
});
