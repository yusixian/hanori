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
} from "@cos-tool-bot/shared";
import type { CodingWorkerModel } from "./coding-worker-client.js";
import { CodingWorkerClient } from "./coding-worker-client.js";
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  CodingJobStager,
  type PathIdentity,
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

interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  uid?: number;
  gid?: number;
}

interface WorkspaceIdentity {
  workspace: PathIdentity;
  gitDir: PathIdentity;
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

async function run(command: string, args: string[], options: ExecOptions): Promise<string> {
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
      },
      (error, stdout, stderr) => {
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
        await this.ensureWorkspace(options.botId, options.repository, options.token);
        await this.prepareBranch(workspace, options);
        const startSha = await this.git(workspace, ["rev-parse", "HEAD"]);
        const canonicalIdentity = await this.assertWorkspace(workspace);
        const staged = await this.stager.stage(workspace);
        try {
          await this.assertWorkspaceIdentity(canonicalIdentity);
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
          await this.stager.validateResult(staged);
          signal?.throwIfAborted();
          await this.assertWorkspaceIdentity(canonicalIdentity);
          const currentBranch = await this.gitWithWorkTree(workspace, staged.path, [
            "branch",
            "--show-current",
          ]);
          if (currentBranch !== options.branch) {
            throw new Error(
              `Pi changed the checked-out branch to ${currentBranch || "detached HEAD"}`,
            );
          }

          await this.assertWorkspaceIdentity(canonicalIdentity);
          const status = await this.gitWithWorkTree(workspace, staged.path, [
            "status",
            "--porcelain",
          ]);
          if (status) {
            signal?.throwIfAborted();
            await this.assertWorkspaceIdentity(canonicalIdentity);
            await this.gitWithWorkTree(workspace, staged.path, ["add", "-A"]);
            const commitMessage =
              options.commitMessage?.trim().split("\n")[0]?.slice(0, 200) ||
              "chore: apply Ai-chan coding task";
            await this.assertWorkspaceIdentity(canonicalIdentity);
            signal?.throwIfAborted();
            await this.gitWithWorkTree(workspace, staged.path, ["commit", "-m", commitMessage]);
          }

          await this.assertWorkspaceIdentity(canonicalIdentity);
          const commitSha = await this.git(workspace, ["rev-parse", "HEAD"]);
          await this.assertWorkspaceIdentity(canonicalIdentity);
          await this.git(workspace, ["reset", "--hard", commitSha]);
          const changed =
            commitSha === startSha
              ? []
              : (await this.git(workspace, ["diff", "--name-only", `${startSha}..${commitSha}`]))
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

  private async prepareBranch(workspace: string, options: GitWorkspaceTaskOptions): Promise<void> {
    await this.git(workspace, ["check-ref-format", "--branch", options.branch]);
    await this.git(workspace, ["config", "--local", "user.name", options.authorName]);
    await this.git(workspace, ["config", "--local", "user.email", options.authorEmail]);
    const currentBranch = await this.git(workspace, ["branch", "--show-current"]);
    const status = await this.git(workspace, ["status", "--porcelain"]);
    const branchExists = await this.gitSucceeds(workspace, [
      "show-ref",
      "--verify",
      `refs/heads/${options.branch}`,
    ]);
    if (status) {
      throw new Error(
        "Workspace has uncommitted changes from an earlier coding job; resolve them before continuing",
      );
    }
    if (branchExists) {
      if (currentBranch !== options.branch) {
        await this.git(workspace, ["checkout", options.branch]);
      }
      return;
    }
    const base = options.baseRef
      ? `refs/remotes/origin/${options.baseRef}`
      : await this.git(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    await this.git(workspace, ["rev-parse", "--verify", `${base}^{commit}`]);
    await this.git(workspace, ["checkout", "-b", options.branch, base]);
  }

  private async ensureWorkspace(botId: string, repository: string, token: string): Promise<string> {
    const workspace = this.workspacePath(botId, repository);
    const parent = path.dirname(workspace);
    const gitDir = this.gitDirForWorkspace(workspace);
    const gitParent = path.dirname(gitDir);
    await mkdir(parent, { recursive: true });
    await mkdir(gitParent, { recursive: true });
    await chown(parent, this.workspaceUid, this.workspaceGid);
    await chown(gitParent, this.workspaceUid, this.workspaceGid);
    let exists = true;
    try {
      await stat(workspace);
    } catch {
      exists = false;
    }
    if (!exists) {
      await this.withAuth(token, (env) =>
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
          },
        ),
      );
    }
    await this.assertWorkspace(workspace);
    await this.ensureLocalExcludes(workspace);
    await this.git(workspace, ["remote", "set-url", "origin", this.remoteUrl(repository)]);
    await this.withAuth(token, (env) => this.git(workspace, ["fetch", "--prune", "origin"], env));
    return workspace;
  }

  private workspacePath(botId: string, repository: string): string {
    if (!BOT_ID_RE.test(botId)) throw new Error("Invalid bot id for coding workspace");
    validateRepository(repository);
    return path.join(this.root, botId, ...repository.toLowerCase().split("/"));
  }

  private async resolvedRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private async resolvedGitRoot(): Promise<string> {
    await mkdir(this.gitRoot, { recursive: true });
    return realpath(this.gitRoot);
  }

  private async assertWorkspace(workspace: string): Promise<WorkspaceIdentity> {
    const root = await this.resolvedRoot();
    const resolved = path.resolve(workspace);
    const configuredRoot = path.resolve(this.root);
    if (!resolved.startsWith(`${configuredRoot}${path.sep}`))
      throw new Error("Workspace escapes configured root");
    const workspaceIdentity = await captureDirectoryIdentity(resolved);
    if (!workspaceIdentity.path.startsWith(`${root}${path.sep}`)) {
      throw new Error("Workspace escapes configured root through a symlink");
    }
    const gitRoot = await this.resolvedGitRoot();
    const gitDir = this.gitDirForWorkspace(resolved);
    const resolvedGitDir = path.resolve(gitDir);
    const configuredGitRoot = path.resolve(this.gitRoot);
    if (!resolvedGitDir.startsWith(`${configuredGitRoot}${path.sep}`)) {
      throw new Error("Git metadata escapes configured root");
    }
    const gitDirIdentity = await captureDirectoryIdentity(resolvedGitDir);
    if (!gitDirIdentity.path.startsWith(`${gitRoot}${path.sep}`)) {
      throw new Error("Git metadata escapes configured root through a symlink");
    }
    return { workspace: workspaceIdentity, gitDir: gitDirIdentity };
  }

  private async assertWorkspaceIdentity(identity: WorkspaceIdentity): Promise<void> {
    await assertDirectoryIdentity(identity.workspace);
    await assertDirectoryIdentity(identity.gitDir);
  }

  private async ensureLocalExcludes(workspace: string): Promise<void> {
    const excludePath = path.join(this.gitDirForWorkspace(workspace), "info", "exclude");
    const content = await readFile(excludePath, "utf8").catch(() => "");
    if (content.split(/\r?\n/).includes(".cos-pi-cache/")) return;
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${content}${separator}.cos-pi-cache/\n`, { mode: 0o600 });
    await chown(excludePath, this.workspaceUid, this.workspaceGid);
  }

  private git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return this.gitWithWorkTree(cwd, cwd, args, env);
  }

  private gitWithWorkTree(
    canonicalWorkspace: string,
    workTree: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
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
      },
    );
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try {
      await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async withAuth<T>(
    token: string,
    operation: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cos-git-auth-"));
    const askPass = path.join(tempDir, "askpass.sh");
    await writeFile(
      askPass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$COS_GITHUB_TOKEN" ;;\nesac\n',
    );
    await chmod(askPass, 0o700);
    await chown(tempDir, this.workspaceUid, this.workspaceGid);
    await chown(askPass, this.workspaceUid, this.workspaceGid);
    try {
      return await operation(
        this.gitEnvironment({
          GIT_ASKPASS: askPass,
          GIT_TERMINAL_PROMPT: "0",
          COS_GITHUB_TOKEN: token,
        }),
      );
    } catch (error) {
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
