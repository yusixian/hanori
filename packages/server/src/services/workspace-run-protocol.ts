import type { GitHubCodeTaskResult } from "@cos-tool-bot/shared";
import type { CodingJobStager, StagedWorkspace } from "./coding-job-stager.js";
import type { CodingWorkerClient, CodingWorkerModel } from "./coding-worker-client.js";

const DEFAULT_JOB_TIMEOUT_MS = 4 * 60 * 1000;

/** Operations bound to one canonical workspace and the identity captured before the run. */
export interface WorkspaceRunPorts {
  worker: Pick<CodingWorkerClient, "waitForFreshBoot" | "run">;
  stager: Pick<CodingJobStager, "workspaceName" | "validateResult" | "cleanup">;
  git(args: string[], signal?: AbortSignal): Promise<string>;
  stagedGit(staged: StagedWorkspace, args: string[], signal?: AbortSignal): Promise<string>;
  assertIdentity(signal?: AbortSignal): Promise<void>;
  assertNoProtectedChanges(staged: StagedWorkspace, signal?: AbortSignal): Promise<void>;
}

export interface WorkspaceRunControl {
  /** Call before the first canonical ref, index, or worktree mutation; later failures roll back. */
  markCanonicalTouched(): void;
}

/**
 * Hooks must use the `signal` given to `runWorkspaceProtocol`; `rollback` deliberately runs
 * without it so a cancelled run is still restored.
 */
export interface WorkspaceRunPlan {
  repository: string;
  branch: string;
  task: string;
  model: CodingWorkerModel;
  commitMessage?: string;
  defaultCommitMessage: string;
  failureMessage: string;
  branchChangedMessage(current: string): string;
  /** Resolves the SHA that the committed result is diffed against. */
  prepare(control: WorkspaceRunControl): Promise<string>;
  stage(): Promise<StagedWorkspace>;
  beforeRun(staged: StagedWorkspace, control: WorkspaceRunControl): Promise<void>;
  afterRun(): Promise<void>;
  /** Adds the validated result to the canonical index; resolves whether there is anything to commit. */
  indexResult(staged: StagedWorkspace, control: WorkspaceRunControl): Promise<boolean>;
  afterReset?(): Promise<void>;
  rollback(worktreeTouched: boolean): Promise<void>;
}

/**
 * Runs one Pi job on a staged copy of the canonical workspace and commits the result there.
 *
 * Order: prepare → fresh worker boot → stage → identity → beforeRun → worker → validate result →
 * afterRun → staged branch equals `plan.branch` → protected paths unchanged → identity →
 * indexResult → identity and commit when it indexed changes → staging cleanup → identity →
 * read HEAD → identity → canonical `reset --hard` → afterReset → changed files since prepare's SHA.
 *
 * Callers hold the staging and workspace locks and check preconditions first. On failure,
 * `plan.rollback` runs once a hook marked the canonical workspace touched or HEAD is about to be
 * read; `worktreeTouched` reports whether the canonical reset started. Staging that was created
 * and not yet cleaned is cleaned. A failed rollback or cleanup rejects with an `AggregateError`
 * carrying `plan.failureMessage`; otherwise the original error is rethrown.
 */
export async function runWorkspaceProtocol(
  ports: WorkspaceRunPorts,
  plan: WorkspaceRunPlan,
  signal?: AbortSignal,
): Promise<GitHubCodeTaskResult> {
  let canonicalTouched = false;
  let worktreeTouched = false;
  let stagingCleaned = false;
  let staged: StagedWorkspace | undefined;
  const control: WorkspaceRunControl = {
    markCanonicalTouched: () => {
      canonicalTouched = true;
    },
  };
  try {
    const baseSha = await plan.prepare(control);
    await ports.worker.waitForFreshBoot(signal);
    staged = await plan.stage();
    await ports.assertIdentity(signal);
    await plan.beforeRun(staged, control);
    const workerResult = await ports.worker.run(
      {
        workspacePath: ports.stager.workspaceName,
        task: plan.task,
        timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
        model: plan.model,
      },
      signal,
    );

    signal?.throwIfAborted();
    await ports.stager.validateResult(staged, signal);
    await plan.afterRun();
    const currentBranch = await ports.stagedGit(staged, ["branch", "--show-current"], signal);
    if (currentBranch !== plan.branch) throw new Error(plan.branchChangedMessage(currentBranch));
    await ports.assertNoProtectedChanges(staged, signal);
    signal?.throwIfAborted();
    await ports.assertIdentity(signal);
    if (await plan.indexResult(staged, control)) {
      const commitMessage =
        plan.commitMessage?.trim().split("\n")[0]?.slice(0, 200) || plan.defaultCommitMessage;
      await ports.assertIdentity(signal);
      signal?.throwIfAborted();
      await ports.stagedGit(staged, ["commit", "-m", commitMessage], signal);
    }

    await ports.stager.cleanup();
    stagingCleaned = true;
    signal?.throwIfAborted();
    await ports.assertIdentity(signal);
    canonicalTouched = true;
    const commitSha = await ports.git(["rev-parse", "HEAD"], signal);
    await ports.assertIdentity(signal);
    worktreeTouched = true;
    await ports.git(["reset", "--hard", commitSha], signal);
    await plan.afterReset?.();
    const changedFiles =
      commitSha === baseSha
        ? []
        : (await ports.git(["diff", "--name-only", `${baseSha}..${commitSha}`], signal))
            .split("\n")
            .filter(Boolean)
            .slice(0, 200);
    return {
      repository: plan.repository,
      branch: plan.branch,
      commitSha,
      changedFiles,
      summary: workerResult.summary,
      status: commitSha === baseSha ? "no_changes" : "committed",
    };
  } catch (error) {
    const failures = [error];
    if (canonicalTouched) {
      try {
        await plan.rollback(worktreeTouched);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (staged && !stagingCleaned) {
      try {
        await ports.stager.cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, plan.failureMessage);
    throw error;
  }
}
