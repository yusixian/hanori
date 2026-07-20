import { execFile } from "node:child_process";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  GitHubCodeTaskInput,
  GitHubCodeTaskResult,
  GitHubPushPreview,
  GitHubPushResult,
  GitHubWorkspaceDiscardResult,
  GitHubWorkspaceInspection,
  GitHubWorkspaceResumeInput,
} from "@cos-tool-bot/shared";
import type { CodingWorkerModel } from "./coding-worker-client.js";
import { CodingWorkerClient } from "./coding-worker-client.js";
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  CodingJobStager,
  type PathIdentity,
  type RecoverySnapshot,
} from "./coding-job-stager.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BOT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 4 * 60 * 1000;

export interface GitWorkspaceTaskOptions extends GitHubCodeTaskInput {
  botId: string;
  token: string;
  authorName: string;
  authorEmail: string;
  model: CodingWorkerModel;
}

export interface GitWorkspacePushOptions {
  botId: string;
  repository: string;
  branch: string;
  token: string;
  expectedCommitSha?: string;
}

export interface GitWorkspaceInspectOptions {
  botId: string;
  repository: string;
}

export interface GitWorkspaceResumeOptions extends GitHubWorkspaceResumeInput {
  botId: string;
  authorName: string;
  authorEmail: string;
  model: CodingWorkerModel;
}

export type GitWorkspaceDiscardOptions = GitWorkspaceInspectOptions;

interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  uid?: number;
  gid?: number;
  signal?: AbortSignal;
}

interface WorkspaceIdentity {
  workspace: PathIdentity;
  gitDir: PathIdentity;
}

interface InspectedWorkspace {
  identity: WorkspaceIdentity;
  inspection: GitHubWorkspaceInspection;
  snapshot: RecoverySnapshot;
}

export function validateRepository(repository: string): void {
  if (!REPOSITORY_RE.test(repository)) throw new Error("Invalid GitHub repository");
  const [owner, name] = repository.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new Error("Invalid GitHub repository");
  }
}

export function validateGitBranch(branch: string): void {
  if (
    !branch ||
    branch.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  ) {
    throw new Error("Invalid Git branch name");
  }
}

function gitUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

function gitHubBranchUrl(repository: string, branch: string): string {
  return `https://github.com/${repository}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

function displayPath(value: string): string {
  let display = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    display += code <= 0x1f || code === 0x7f ? "�" : character;
  }
  return display.slice(0, 500);
}

async function run(command: string, args: string[], options: ExecOptions): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        uid: options.uid,
        gid: options.gid,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason);
          return;
        }
        if (error) {
          reject(new Error((stderr || error.message || `${command} failed`).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export class GitWorkspaceService {
  private readonly locks = new KeyedAsyncLock();

  constructor(
    private readonly root: string,
    private readonly gitRoot: string,
    private readonly worker: CodingWorkerClient,
    private readonly workspaceUid: number = process.getuid?.() ?? 1000,
    private readonly workspaceGid: number = process.getgid?.() ?? 1000,
    private readonly remoteUrl: (repository: string) => string = gitUrl,
    private readonly stager: CodingJobStager = new CodingJobStager(
      process.env["CODING_JOB_DIR"] ?? "./data/coding-job",
      {},
      { uid: workspaceUid, gid: workspaceGid },
    ),
  ) {}

  async runCodeTask(
    options: GitWorkspaceTaskOptions,
    signal?: AbortSignal,
  ): Promise<GitHubCodeTaskResult> {
    signal?.throwIfAborted();
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.stager.runExclusive(() =>
      this.locks.run(workspace, async () => {
        signal?.throwIfAborted();
        validateGitBranch(options.branch);
        if (options.baseRef) validateGitBranch(options.baseRef);
        await this.ensureWorkspace(options.botId, options.repository, options.token, signal);
        signal?.throwIfAborted();
        await this.prepareBranch(workspace, options, signal);
        signal?.throwIfAborted();
        const startSha = await this.git(workspace, ["rev-parse", "HEAD"], undefined, signal);
        const canonicalIdentity = await this.assertWorkspace(workspace, signal);
        const staged = await this.stager.stage(workspace, signal);
        try {
          await this.assertWorkspaceIdentity(canonicalIdentity, signal);
          const workerResult = await this.worker.run(
            {
              workspacePath: this.stager.workspaceName,
              task: options.task,
              timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
              model: options.model,
            },
            signal,
          );

          signal?.throwIfAborted();
          await this.stager.validateResult(staged, signal);
          signal?.throwIfAborted();
          await this.assertWorkspaceIdentity(canonicalIdentity, signal);
          const currentBranch = await this.gitWithWorkTree(
            workspace,
            staged.path,
            ["branch", "--show-current"],
            undefined,
            signal,
          );
          if (currentBranch !== options.branch) {
            throw new Error(
              `Pi changed the checked-out branch to ${currentBranch || "detached HEAD"}`,
            );
          }

          await this.assertWorkspaceIdentity(canonicalIdentity, signal);
          const status = await this.gitWithWorkTree(
            workspace,
            staged.path,
            ["status", "--porcelain"],
            undefined,
            signal,
          );
          if (status) {
            signal?.throwIfAborted();
            await this.assertWorkspaceIdentity(canonicalIdentity, signal);
            signal?.throwIfAborted();
            await this.gitWithWorkTree(workspace, staged.path, ["add", "-A"], undefined, signal);
            const commitMessage =
              options.commitMessage?.trim().split("\n")[0]?.slice(0, 200) ||
              "chore: apply Ai-chan coding task";
            await this.assertWorkspaceIdentity(canonicalIdentity, signal);
            signal?.throwIfAborted();
            await this.gitWithWorkTree(
              workspace,
              staged.path,
              ["commit", "-m", commitMessage],
              undefined,
              signal,
            );
          }

          signal?.throwIfAborted();
          await this.assertWorkspaceIdentity(canonicalIdentity, signal);
          const commitSha = await this.git(workspace, ["rev-parse", "HEAD"], undefined, signal);
          await this.assertWorkspaceIdentity(canonicalIdentity, signal);
          await this.git(workspace, ["reset", "--hard", commitSha], undefined, signal);
          const changed =
            commitSha === startSha
              ? []
              : (
                  await this.git(
                    workspace,
                    ["diff", "--name-only", `${startSha}..${commitSha}`],
                    undefined,
                    signal,
                  )
                )
                  .split("\n")
                  .filter(Boolean)
                  .slice(0, 200);
          return {
            repository: options.repository,
            branch: options.branch,
            commitSha,
            changedFiles: changed,
            summary: workerResult.summary,
            status: commitSha === startSha ? "no_changes" : "committed",
          };
        } catch (error) {
          await this.assertWorkspaceIdentity(canonicalIdentity)
            .then(() => this.git(workspace, ["reset", "--mixed", "HEAD"]))
            .catch(() => undefined);
          throw error;
        } finally {
          await this.stager.cleanup();
        }
      }),
    );
  }

  async inspectWorkspace(
    options: GitWorkspaceInspectOptions,
    signal?: AbortSignal,
  ): Promise<GitHubWorkspaceInspection> {
    signal?.throwIfAborted();
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.locks.run(workspace, async () => {
      const inspected = await this.inspectWorkspaceLocked(workspace, options.repository, signal);
      return inspected.inspection;
    });
  }

  async resumeWorkspace(
    options: GitWorkspaceResumeOptions,
    expected: GitHubWorkspaceInspection,
    signal?: AbortSignal,
  ): Promise<GitHubCodeTaskResult> {
    signal?.throwIfAborted();
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.stager.runExclusive(() =>
      this.locks.run(workspace, async () => {
        signal?.throwIfAborted();
        const inspected = await this.inspectWorkspaceLocked(workspace, options.repository, signal);
        this.assertExpectedInspection(inspected.inspection, expected);
        if (inspected.inspection.clean) {
          throw new Error("Workspace is already clean; there is nothing to resume");
        }
        if (!inspected.inspection.branch) {
          throw new Error("Detached workspace cannot be resumed");
        }
        await this.assertWorkspaceIdentity(inspected.identity, signal);
        await this.git(
          workspace,
          ["config", "--local", "user.name", options.authorName],
          undefined,
          signal,
        );
        await this.assertWorkspaceIdentity(inspected.identity, signal);
        await this.git(
          workspace,
          ["config", "--local", "user.email", options.authorEmail],
          undefined,
          signal,
        );
        const staged = await this.stager.stageRecoverySnapshot(
          workspace,
          inspected.snapshot,
          signal,
        );
        let indexTouched = false;
        try {
          await this.assertWorkspaceIdentity(inspected.identity, signal);
          const afterStage = await this.inspectWorkspaceLocked(
            workspace,
            options.repository,
            signal,
          );
          this.assertExpectedInspection(afterStage.inspection, expected);
          const workerResult = await this.worker.run(
            {
              workspacePath: this.stager.workspaceName,
              task: options.task,
              timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
              model: options.model,
            },
            signal,
          );

          signal?.throwIfAborted();
          await this.stager.validateResult(staged, signal);
          const beforeCommit = await this.inspectWorkspaceLocked(
            workspace,
            options.repository,
            signal,
          );
          this.assertExpectedInspection(beforeCommit.inspection, expected);
          const currentBranch = await this.gitWithWorkTree(
            workspace,
            staged.path,
            ["branch", "--show-current"],
            undefined,
            signal,
          );
          if (currentBranch !== expected.branch) {
            throw new Error("Workspace branch changed while resuming; request a new inspection");
          }
          const status = await this.gitWithWorkTree(
            workspace,
            staged.path,
            ["status", "--porcelain"],
            undefined,
            signal,
          );
          if (status) {
            signal?.throwIfAborted();
            indexTouched = true;
            await this.assertWorkspaceIdentity(inspected.identity, signal);
            await this.gitWithWorkTree(workspace, staged.path, ["add", "-A"], undefined, signal);
            await this.assertWorkspaceIdentity(inspected.identity, signal);
            const stagedChanges = await this.gitWithWorkTree(
              workspace,
              staged.path,
              ["diff", "--cached", "--name-only"],
              undefined,
              signal,
            );
            if (stagedChanges) {
              const commitMessage =
                options.commitMessage?.trim().split("\n")[0]?.slice(0, 200) ||
                "chore: recover Ai-chan coding workspace";
              await this.assertWorkspaceIdentity(inspected.identity, signal);
              signal?.throwIfAborted();
              await this.gitWithWorkTree(
                workspace,
                staged.path,
                ["commit", "-m", commitMessage],
                undefined,
                signal,
              );
            }
          }

          signal?.throwIfAborted();
          await this.assertWorkspaceIdentity(inspected.identity, signal);
          const commitSha = await this.git(workspace, ["rev-parse", "HEAD"], undefined, signal);
          await this.assertWorkspaceIdentity(inspected.identity, signal);
          await this.git(workspace, ["reset", "--hard", commitSha], undefined, signal);
          await this.assertWorkspaceIdentity(inspected.identity, signal);
          await this.git(workspace, ["clean", "-fd"], undefined, signal);
          const finalInspection = await this.inspectWorkspaceLocked(
            workspace,
            options.repository,
            signal,
          );
          if (!finalInspection.inspection.clean) {
            throw new Error("Recovered workspace did not become clean");
          }
          const changed =
            commitSha === expected.headSha
              ? []
              : (
                  await this.git(
                    workspace,
                    ["diff", "--name-only", `${expected.headSha}..${commitSha}`],
                    undefined,
                    signal,
                  )
                )
                  .split("\n")
                  .filter(Boolean)
                  .slice(0, 200);
          return {
            repository: options.repository,
            branch: expected.branch,
            commitSha,
            changedFiles: changed,
            summary: workerResult.summary,
            status: commitSha === expected.headSha ? "no_changes" : "committed",
          };
        } catch (error) {
          if (indexTouched) {
            await this.assertWorkspaceIdentity(inspected.identity)
              .then(() => this.git(workspace, ["reset", "--mixed", expected.headSha]))
              .catch(() => undefined);
          }
          throw error;
        } finally {
          await this.stager.cleanup();
        }
      }),
    );
  }

  async discardWorkspace(
    options: GitWorkspaceDiscardOptions,
    expected: GitHubWorkspaceInspection,
    signal?: AbortSignal,
  ): Promise<GitHubWorkspaceDiscardResult> {
    signal?.throwIfAborted();
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.locks.run(workspace, async () => {
      const inspected = await this.inspectWorkspaceLocked(workspace, options.repository, signal);
      this.assertExpectedInspection(inspected.inspection, expected);
      if (inspected.inspection.clean) {
        throw new Error("Workspace is already clean; there is nothing to discard");
      }
      signal?.throwIfAborted();
      await this.assertWorkspaceIdentity(inspected.identity, signal);
      await this.git(workspace, ["reset", "--hard", expected.headSha], undefined, signal);
      await this.assertWorkspaceIdentity(inspected.identity, signal);
      await this.git(workspace, ["clean", "-fd"], undefined, signal);
      const finalInspection = await this.inspectWorkspaceLocked(
        workspace,
        options.repository,
        signal,
      );
      if (!finalInspection.inspection.clean) {
        throw new Error("Workspace still has non-ignored changes after discard");
      }
      return {
        repository: options.repository,
        branch: expected.branch,
        headSha: expected.headSha,
        summary: `已丢弃 ${options.repository}:${expected.branch} 的未提交改动`,
      };
    });
  }

  async previewPush(options: GitWorkspacePushOptions): Promise<GitHubPushPreview> {
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.locks.run(workspace, async () => {
      validateGitBranch(options.branch);
      await this.assertWorkspace(workspace);
      const status = await this.git(workspace, ["status", "--porcelain"]);
      if (status)
        throw new Error("Workspace has uncommitted changes; finish the local commit first");
      const commitSha = await this.git(workspace, ["rev-parse", `refs/heads/${options.branch}`]);
      await this.git(workspace, [
        "remote",
        "set-url",
        "origin",
        this.remoteUrl(options.repository),
      ]);
      const remoteOutput = await this.withAuth(options.token, (env) =>
        this.git(
          workspace,
          ["ls-remote", "--heads", "origin", `refs/heads/${options.branch}`],
          env,
        ),
      );
      const remoteCommitSha = remoteOutput.split(/\s+/)[0] || undefined;
      if (remoteCommitSha === commitSha)
        throw new Error("This branch is already up to date on GitHub");
      return { repository: options.repository, branch: options.branch, commitSha, remoteCommitSha };
    });
  }

  async pushBranch(options: GitWorkspacePushOptions): Promise<GitHubPushResult> {
    const workspace = this.workspacePath(options.botId, options.repository);
    return this.locks.run(workspace, async () => {
      validateGitBranch(options.branch);
      await this.assertWorkspace(workspace);
      const commitSha = await this.git(workspace, ["rev-parse", `refs/heads/${options.branch}`]);
      if (options.expectedCommitSha && commitSha !== options.expectedCommitSha) {
        throw new Error(
          "The local branch changed after confirmation was requested; request a new push",
        );
      }
      const status = await this.git(workspace, ["status", "--porcelain"]);
      if (status) throw new Error("Workspace has uncommitted changes; refusing to push");
      await this.git(workspace, [
        "remote",
        "set-url",
        "origin",
        this.remoteUrl(options.repository),
      ]);
      await this.withAuth(options.token, (env) =>
        this.git(
          workspace,
          [
            "push",
            "--set-upstream",
            "origin",
            `refs/heads/${options.branch}:refs/heads/${options.branch}`,
          ],
          env,
        ),
      );
      return {
        summary: `已推送 ${options.repository}:${options.branch}（${commitSha.slice(0, 12)}）`,
        url: gitHubBranchUrl(options.repository, options.branch),
      };
    });
  }

  private async inspectWorkspaceLocked(
    workspace: string,
    repository: string,
    signal?: AbortSignal,
  ): Promise<InspectedWorkspace> {
    signal?.throwIfAborted();
    const identity = await this.assertWorkspace(workspace, signal);
    const [branch, headSha] = await Promise.all([
      this.git(workspace, ["branch", "--show-current"], undefined, signal),
      this.git(workspace, ["rev-parse", "HEAD"], undefined, signal),
    ]);
    const snapshot = await this.stager.captureRecoverySnapshot(workspace, branch, headSha, signal);
    await this.assertWorkspaceIdentity(identity, signal);
    return {
      identity,
      snapshot,
      inspection: {
        repository,
        branch,
        headSha,
        clean: snapshot.clean,
        changedFiles: snapshot.changedPaths.slice(0, 200).map(displayPath),
        fingerprint: snapshot.fingerprint,
      },
    };
  }

  private assertExpectedInspection(
    current: GitHubWorkspaceInspection,
    expected: GitHubWorkspaceInspection,
  ): void {
    if (
      current.repository !== expected.repository ||
      current.branch !== expected.branch ||
      current.headSha !== expected.headSha ||
      current.clean !== expected.clean ||
      current.fingerprint !== expected.fingerprint
    ) {
      throw new Error("Workspace changed after confirmation preview; request a new inspection");
    }
  }

  private async prepareBranch(
    workspace: string,
    options: GitWorkspaceTaskOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.git(workspace, ["check-ref-format", "--branch", options.branch], undefined, signal);
    await this.git(
      workspace,
      ["config", "--local", "user.name", options.authorName],
      undefined,
      signal,
    );
    await this.git(
      workspace,
      ["config", "--local", "user.email", options.authorEmail],
      undefined,
      signal,
    );
    const currentBranch = await this.git(
      workspace,
      ["branch", "--show-current"],
      undefined,
      signal,
    );
    const status = await this.git(workspace, ["status", "--porcelain"], undefined, signal);
    const branchExists = await this.gitSucceeds(
      workspace,
      ["show-ref", "--verify", `refs/heads/${options.branch}`],
      signal,
    );
    if (status) {
      throw new Error(
        "Workspace has uncommitted changes from an earlier coding job; resolve them before continuing",
      );
    }
    if (branchExists) {
      if (currentBranch !== options.branch) {
        signal?.throwIfAborted();
        await this.git(workspace, ["checkout", options.branch], undefined, signal);
      }
      return;
    }
    const base = options.baseRef
      ? `refs/remotes/origin/${options.baseRef}`
      : await this.git(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD"], undefined, signal);
    await this.git(workspace, ["rev-parse", "--verify", `${base}^{commit}`], undefined, signal);
    signal?.throwIfAborted();
    await this.git(workspace, ["checkout", "-b", options.branch, base], undefined, signal);
  }

  private async ensureWorkspace(
    botId: string,
    repository: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const workspace = this.workspacePath(botId, repository);
    const parent = path.dirname(workspace);
    const gitDir = this.gitDirForWorkspace(workspace);
    const gitParent = path.dirname(gitDir);
    await mkdir(parent, { recursive: true });
    await mkdir(gitParent, { recursive: true });
    signal?.throwIfAborted();
    await chown(parent, this.workspaceUid, this.workspaceGid);
    await chown(gitParent, this.workspaceUid, this.workspaceGid);
    let exists = true;
    try {
      await stat(workspace);
    } catch {
      exists = false;
    }
    if (!exists) {
      signal?.throwIfAborted();
      try {
        await this.withAuth(
          token,
          (env) =>
            run(
              "git",
              [
                "-c",
                "credential.helper=",
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "--origin",
                "origin",
                "--separate-git-dir",
                gitDir,
                this.remoteUrl(repository),
                workspace,
              ],
              {
                cwd: parent,
                env,
                uid: this.workspaceUid,
                gid: this.workspaceGid,
                signal,
              },
            ),
          signal,
        );
      } catch (error) {
        await Promise.all([
          rm(workspace, { recursive: true, force: true }),
          rm(gitDir, { recursive: true, force: true }),
        ]);
        throw error;
      }
    }
    await this.assertWorkspace(workspace, signal);
    await this.ensureLocalExcludes(workspace, signal);
    await this.git(
      workspace,
      ["remote", "set-url", "origin", this.remoteUrl(repository)],
      undefined,
      signal,
    );
    await this.withAuth(
      token,
      (env) => this.git(workspace, ["fetch", "--prune", "origin"], env, signal),
      signal,
    );
    return workspace;
  }

  private workspacePath(botId: string, repository: string): string {
    if (!BOT_ID_RE.test(botId)) throw new Error("Invalid bot id for coding workspace");
    validateRepository(repository);
    return path.join(this.root, botId, ...repository.toLowerCase().split("/"));
  }

  private async resolvedRoot(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    signal?.throwIfAborted();
    return realpath(this.root);
  }

  private async resolvedGitRoot(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await mkdir(this.gitRoot, { recursive: true });
    signal?.throwIfAborted();
    return realpath(this.gitRoot);
  }

  private async assertWorkspace(
    workspace: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceIdentity> {
    signal?.throwIfAborted();
    const root = await this.resolvedRoot(signal);
    const resolved = path.resolve(workspace);
    const configuredRoot = path.resolve(this.root);
    if (!resolved.startsWith(`${configuredRoot}${path.sep}`))
      throw new Error("Workspace escapes configured root");
    const workspaceIdentity = await captureDirectoryIdentity(resolved);
    signal?.throwIfAborted();
    if (!workspaceIdentity.path.startsWith(`${root}${path.sep}`)) {
      throw new Error("Workspace escapes configured root through a symlink");
    }
    const gitRoot = await this.resolvedGitRoot(signal);
    const gitDir = this.gitDirForWorkspace(resolved);
    const resolvedGitDir = path.resolve(gitDir);
    const configuredGitRoot = path.resolve(this.gitRoot);
    if (!resolvedGitDir.startsWith(`${configuredGitRoot}${path.sep}`)) {
      throw new Error("Git metadata escapes configured root");
    }
    const gitDirIdentity = await captureDirectoryIdentity(resolvedGitDir);
    signal?.throwIfAborted();
    if (!gitDirIdentity.path.startsWith(`${gitRoot}${path.sep}`)) {
      throw new Error("Git metadata escapes configured root through a symlink");
    }
    return { workspace: workspaceIdentity, gitDir: gitDirIdentity };
  }

  private async assertWorkspaceIdentity(
    identity: WorkspaceIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await assertDirectoryIdentity(identity.workspace);
    signal?.throwIfAborted();
    await assertDirectoryIdentity(identity.gitDir);
    signal?.throwIfAborted();
  }

  private async ensureLocalExcludes(workspace: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const excludePath = path.join(this.gitDirForWorkspace(workspace), "info", "exclude");
    const content = await readFile(excludePath, "utf8").catch(() => "");
    signal?.throwIfAborted();
    if (content.split(/\r?\n/).includes(".cos-pi-cache/")) return;
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${content}${separator}.cos-pi-cache/\n`, { mode: 0o600 });
    signal?.throwIfAborted();
    await chown(excludePath, this.workspaceUid, this.workspaceGid);
  }

  private git(
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.gitWithWorkTree(cwd, cwd, args, env, signal);
  }

  private gitWithWorkTree(
    canonicalWorkspace: string,
    workTree: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    return run(
      "git",
      [
        `--git-dir=${this.gitDirForWorkspace(canonicalWorkspace)}`,
        `--work-tree=${workTree}`,
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: workTree,
        env: this.gitEnvironment(env),
        uid: this.workspaceUid,
        gid: this.workspaceGid,
        signal,
      },
    );
  }

  private async gitSucceeds(cwd: string, args: string[], signal?: AbortSignal): Promise<boolean> {
    try {
      await this.git(cwd, args, undefined, signal);
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  private async withAuth<T>(
    token: string,
    operation: (env: NodeJS.ProcessEnv) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cos-git-auth-"));
    const askPass = path.join(tempDir, "askpass.sh");
    await writeFile(
      askPass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$COS_GITHUB_TOKEN" ;;\nesac\n',
    );
    await chmod(askPass, 0o700);
    await chown(tempDir, this.workspaceUid, this.workspaceGid);
    await chown(askPass, this.workspaceUid, this.workspaceGid);
    signal?.throwIfAborted();
    try {
      return await operation(
        this.gitEnvironment({
          GIT_ASKPASS: askPass,
          GIT_TERMINAL_PROMPT: "0",
          COS_GITHUB_TOKEN: token,
        }),
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.split(token).join("[redacted]"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private gitDirForWorkspace(workspace: string): string {
    const relative = path.relative(path.resolve(this.root), path.resolve(workspace));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Workspace escapes configured root");
    }
    return path.join(this.gitRoot, `${relative}.git`);
  }

  private gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "LANG",
      "LC_ALL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ] as const;
    const safe: NodeJS.ProcessEnv = {
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    for (const name of inheritedNames) {
      if (process.env[name]) safe[name] = process.env[name];
    }
    return { ...safe, ...extra };
  }
}
