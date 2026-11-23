import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingWorkerClient } from "./coding-worker-client.js";
import { CodingJobStager } from "./coding-job-stager.js";
import {
  GitWorkspaceService,
  validateGitBranch,
  validateRepository,
} from "./git-workspace-service.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Integration cases spawn real Git processes; allow for shared-runner I/O contention.
describe("Git workspace input validation", { timeout: 30_000 }, () => {
  it("accepts normal repositories and feature branches", () => {
    expect(() => validateRepository("owner/repository.js")).not.toThrow();
    expect(() => validateGitBranch("feat/hanori-fix")).not.toThrow();
  });

  it("rejects traversal repositories and dangerous refs", () => {
    expect(() => validateRepository("../repo")).toThrow("Invalid GitHub repository");
    expect(() => validateGitBranch("feat/../main")).toThrow("Invalid Git branch name");
    expect(() => validateGitBranch("main.lock")).toThrow("Invalid Git branch name");
    expect(() => validateGitBranch("bad@{ref")).toThrow("Invalid Git branch name");
  });

  it("passes cancellation into git push and reports remote mutation ambiguity", async () => {
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    const service = new GitWorkspaceService("/tmp/workspaces", "/tmp/git", worker);
    type Git = (
      cwd: string,
      args: string[],
      env?: NodeJS.ProcessEnv,
      signal?: AbortSignal,
    ) => Promise<string>;
    type AssertWorkspace = (workspace: string, signal?: AbortSignal) => Promise<unknown>;
    const internals = service as unknown as {
      git: Git;
      assertWorkspace: AssertWorkspace;
    };
    vi.spyOn(internals, "assertWorkspace").mockResolvedValue({});
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let pushSignal: AbortSignal | undefined;
    vi.spyOn(internals, "git").mockImplementation(async (_cwd, args, _env, signal) => {
      if (args[0] === "rev-parse") return "a".repeat(40);
      if (args[0] === "status" || args[0] === "ls-files" || args[0] === "remote") return "";
      if (args[0] === "push") {
        pushSignal = signal;
        started();
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });
    const controller = new AbortController();
    const pushing = service.pushBranch(
      {
        botId: "bot-1",
        repository: "owner/repo",
        branch: "feat/ai",
        token: "github-secret",
        expectedCommitSha: "a".repeat(40),
      },
      controller.signal,
    );
    await didStart;

    controller.abort(new Error("runtime destroyed"));

    await expect(pushing).rejects.toThrow("remote branch may have been updated");
    expect(pushSignal).toBe(controller.signal);
  });

  it("keeps Git metadata outside Pi's working tree, commits as Hanori, and pushes only explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-test-"));
    tempDirs.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "before\n");
    await writeFile(path.join(seed, ".gitignore"), ".env\n.cos-pi-cache/\n");
    await exec("git", ["-C", seed, "add", "README.md", ".gitignore"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await exec("git", [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const workspaceRoot = path.join(root, "workspaces");
    const gitRoot = path.join(root, "metadata");
    const stagingRoot = path.join(root, "coding-job");
    await mkdir(workspaceRoot);
    await mkdir(gitRoot);
    await mkdir(stagingRoot);
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    const run = vi.spyOn(worker, "run").mockImplementation(async (job) => {
      expect(JSON.stringify(job)).not.toContain("github-secret");
      expect(job.workspacePath).toBe("workspace");
      await expect(readFile(path.join(stagingRoot, job.workspacePath, ".env"))).rejects.toThrow();
      await writeFile(
        path.join(stagingRoot, job.workspacePath, ".gitignore"),
        "!.env\n!.cos-pi-cache/\n!.cos-pi-cache/**\n",
      );
      await writeFile(path.join(stagingRoot, job.workspacePath, "README.md"), "after\n");
      return { summary: "updated README", durationMs: 1 };
    });
    const stager = new CodingJobStager(stagingRoot);
    const service = new GitWorkspaceService(
      workspaceRoot,
      gitRoot,
      worker,
      process.getuid?.() ?? 1000,
      process.getgid?.() ?? 1000,
      () => remote,
      stager,
    );

    const result = await service.runCodeTask({
      botId: "bot-1",
      repository: "owner/repo",
      token: "github-secret",
      authorName: "Hanori",
      authorEmail: "hanori@example.com",
      task: "Update README",
      branch: "feat/ai-readme",
      commitMessage: "docs: update README",
      model: {
        apiKey: "model-secret",
        baseURL: "https://example.com/v1",
        id: "model",
        providerFormat: "openai",
        capabilities: ["tool_calling", "code"],
      },
    });

    expect(result.status).toBe("committed");
    expect(run).toHaveBeenCalledOnce();
    const workspace = path.join(workspaceRoot, "bot-1", "owner", "repo");
    const gitFile = await readFile(path.join(workspace, ".git"), "utf8");
    expect(gitFile).toContain(path.join(gitRoot, "bot-1", "owner", "repo.git"));
    await expect(
      exec("git", [
        `--git-dir=${path.join(gitRoot, "bot-1", "owner", "repo.git")}`,
        "config",
        "--get",
        "remote.origin.partialclonefilter",
      ]),
    ).rejects.toThrow();
    const excludeFile = await readFile(
      path.join(gitRoot, "bot-1", "owner", "repo.git", "info", "exclude"),
      "utf8",
    );
    expect(excludeFile).toContain(".cos-pi-cache/");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache-entry"), "cached\n");
    await writeFile(path.join(workspace, ".env"), "IGNORED_SECRET_CANARY\n");
    const rawStatus = (await exec("git", ["-C", workspace, "status", "--porcelain"])).stdout;
    expect(rawStatus).toContain("?? .env");
    expect(rawStatus).toContain("?? .cos-pi-cache/");
    type Git = (
      cwd: string,
      args: string[],
      env?: NodeJS.ProcessEnv,
      signal?: AbortSignal,
    ) => Promise<string>;
    const internals = service as unknown as { git: Git };
    const git = vi.spyOn(internals, "git");
    let releaseFreshBoot!: () => void;
    const freshBoot = new Promise<void>((resolve) => {
      releaseFreshBoot = resolve;
    });
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const waitForFreshBoot = vi.spyOn(worker, "waitForFreshBoot").mockImplementationOnce(() => {
      notifyWaiting();
      return freshBoot;
    });
    const stage = vi.spyOn(stager, "stage");
    const secondRun = service.runCodeTask({
      botId: "bot-1",
      repository: "owner/repo",
      token: "github-secret",
      authorName: "Hanori",
      authorEmail: "hanori@example.com",
      task: "Check README",
      branch: "feat/ai-readme",
      model: {
        apiKey: "model-secret",
        baseURL: "https://example.com/v1",
        id: "model",
        providerFormat: "openai",
        capabilities: ["tool_calling", "code"],
      },
    });
    await Promise.race([waiting, secondRun]);
    expect(waitForFreshBoot).toHaveBeenCalledOnce();
    expect(stage).not.toHaveBeenCalled();
    expect(git.mock.calls.some((call) => call[1].join(" ") === "fetch --prune origin")).toBe(true);
    releaseFreshBoot();
    await secondRun;
    expect(await readFile(path.join(workspace, ".cos-pi-cache", "cache-entry"), "utf8")).toBe(
      "cached\n",
    );
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("IGNORED_SECRET_CANARY\n");
    const author = await exec("git", [
      `--git-dir=${path.join(gitRoot, "bot-1", "owner", "repo.git")}`,
      "show",
      "-s",
      "--format=%an|%ae",
      result.commitSha,
    ]);
    expect(author.stdout.trim()).toBe("Hanori|hanori@example.com");

    const preview = await service.previewPush({
      botId: "bot-1",
      repository: "owner/repo",
      branch: "feat/ai-readme",
      token: "github-secret",
    });
    expect(preview.commitSha).toBe(result.commitSha);
    const beforePush = await exec("git", [
      `--git-dir=${remote}`,
      "branch",
      "--list",
      "feat/ai-readme",
    ]);
    expect(beforePush.stdout.trim()).toBe("");

    await service.pushBranch({
      botId: "bot-1",
      repository: "owner/repo",
      branch: "feat/ai-readme",
      token: "github-secret",
      expectedCommitSha: preview.commitSha,
    });
    const pushed = await exec("git", [
      `--git-dir=${remote}`,
      "rev-parse",
      "refs/heads/feat/ai-readme",
    ]);
    expect(pushed.stdout.trim()).toBe(result.commitSha);

    await writeFile(path.join(workspace, "README.md"), "left over from a failed job\n");
    await expect(
      service.runCodeTask({
        botId: "bot-1",
        repository: "owner/repo",
        token: "github-secret",
        authorName: "Hanori",
        authorEmail: "hanori@example.com",
        task: "Try another edit",
        branch: "feat/ai-readme",
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      }),
    ).rejects.toThrow("uncommitted changes from an earlier coding job");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("removes a committed target branch when staging cleanup fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-cleanup-test-"));
    tempDirs.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "before\n");
    await exec("git", ["-C", seed, "add", "README.md"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await exec("git", [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const originalHead = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();

    const workspaceRoot = path.join(root, "workspaces");
    const gitRoot = path.join(root, "metadata");
    const stagingRoot = path.join(root, "coding-job");
    await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    vi.spyOn(worker, "run").mockImplementation(async (job) => {
      await writeFile(path.join(stagingRoot, job.workspacePath, "README.md"), "after\n");
      return { summary: "updated README", durationMs: 1 };
    });
    const stager = new CodingJobStager(stagingRoot);
    const service = new GitWorkspaceService(
      workspaceRoot,
      gitRoot,
      worker,
      process.getuid?.() ?? 1000,
      process.getgid?.() ?? 1000,
      () => remote,
      stager,
    );
    const cleanupFailure = new Error("injected staging cleanup failure");
    const cleanup = vi.spyOn(stager, "cleanup").mockRejectedValueOnce(cleanupFailure);

    await expect(
      service.runCodeTask({
        botId: "bot-1",
        repository: "owner/repo",
        token: "github-secret",
        authorName: "Hanori",
        authorEmail: "hanori@example.com",
        task: "Update README",
        branch: "feat/cleanup-failure",
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
          capabilities: ["tool_calling", "code"],
        },
      }),
    ).rejects.toBe(cleanupFailure);

    const workspace = path.join(workspaceRoot, "bot-1", "owner", "repo");
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await exec("git", ["-C", workspace, "branch", "--show-current"])).stdout.trim()).toBe(
      "main",
    );
    expect((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      originalHead,
    );
    expect((await exec("git", ["-C", workspace, "status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
    await expect(
      exec("git", ["-C", workspace, "show-ref", "--verify", "refs/heads/feat/cleanup-failure"]),
    ).rejects.toThrow();
    expect(
      (await exec("git", ["-C", workspace, "rev-list", "--all", "--count"])).stdout.trim(),
    ).toBe("1");
    await expect(
      readFile(path.join(stagingRoot, "workspace", "README.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("restores an existing target branch when cancellation follows a successful commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-abort-test-"));
    tempDirs.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "before\n");
    await exec("git", ["-C", seed, "add", "README.md"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await exec("git", [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const originalHead = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();

    const workspaceRoot = path.join(root, "workspaces");
    const gitRoot = path.join(root, "metadata");
    const stagingRoot = path.join(root, "coding-job");
    await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
    const controller = new AbortController();
    const reason = new Error("stopped");
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    vi.spyOn(worker, "run").mockImplementation(async (job, signal) => {
      expect(signal).toBe(controller.signal);
      await writeFile(path.join(stagingRoot, job.workspacePath, "README.md"), "after\n");
      return { summary: "must not commit", durationMs: 1 };
    });
    const service = new GitWorkspaceService(
      workspaceRoot,
      gitRoot,
      worker,
      process.getuid?.() ?? 1000,
      process.getgid?.() ?? 1000,
      () => remote,
      new CodingJobStager(stagingRoot),
    );
    const internals = service as unknown as {
      ensureWorkspace: (
        botId: string,
        repository: string,
        token: string,
        signal?: AbortSignal,
      ) => Promise<string>;
      gitWithWorkTree: (
        canonicalWorkspace: string,
        workTree: string,
        args: string[],
        env?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
      ) => Promise<string>;
    };
    const workspace = await internals.ensureWorkspace("bot-1", "owner/repo", "github-secret");
    await exec("git", ["-C", workspace, "branch", "feat/aborted", originalHead]);
    const gitWithWorkTree = internals.gitWithWorkTree.bind(service);
    vi.spyOn(internals, "gitWithWorkTree").mockImplementation(
      async (canonicalWorkspace, workTree, args, env, signal) => {
        const result = await gitWithWorkTree(canonicalWorkspace, workTree, args, env, signal);
        if (args[0] === "commit") controller.abort(reason);
        return result;
      },
    );

    await expect(
      service.runCodeTask(
        {
          botId: "bot-1",
          repository: "owner/repo",
          token: "github-secret",
          authorName: "Hanori",
          authorEmail: "hanori@example.com",
          task: "Update README",
          branch: "feat/aborted",
          model: {
            apiKey: "model-secret",
            baseURL: "https://example.com/v1",
            id: "model",
            providerFormat: "openai",
            capabilities: ["tool_calling", "code"],
          },
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);

    expect((await exec("git", ["-C", workspace, "branch", "--show-current"])).stdout.trim()).toBe(
      "main",
    );
    expect((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      originalHead,
    );
    expect((await exec("git", ["-C", workspace, "status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
    expect(
      (
        await exec("git", ["-C", workspace, "rev-parse", "--verify", "refs/heads/feat/aborted"])
      ).stdout.trim(),
    ).toBe(originalHead);
    expect(
      (await exec("git", ["-C", workspace, "rev-list", "--all", "--count"])).stdout.trim(),
    ).toBe("1");
    await expect(
      readFile(path.join(stagingRoot, "workspace", "README.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("does not create a branch when cancellation reaches checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-branch-abort-test-"));
    tempDirs.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "before\n");
    await exec("git", ["-C", seed, "add", "README.md"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await exec("git", [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const originalHead = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();

    const workspaceRoot = path.join(root, "workspaces");
    const gitRoot = path.join(root, "metadata");
    const stagingRoot = path.join(root, "coding-job");
    await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
    const controller = new AbortController();
    const reason = new Error("stopped before branch creation");
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    const runWorker = vi.spyOn(worker, "run");
    const service = new GitWorkspaceService(
      workspaceRoot,
      gitRoot,
      worker,
      process.getuid?.() ?? 1000,
      process.getgid?.() ?? 1000,
      () => remote,
      new CodingJobStager(stagingRoot),
    );
    const internals = service as unknown as {
      git: (
        cwd: string,
        args: string[],
        env?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
      ) => Promise<string>;
    };
    const git = internals.git.bind(service);
    vi.spyOn(internals, "git").mockImplementation(async (cwd, args, env, signal) => {
      const result = await git(cwd, args, env, signal);
      if (args[0] === "checkout" && args[1] === "-b") controller.abort(reason);
      return result;
    });

    await expect(
      service.runCodeTask(
        {
          botId: "bot-1",
          repository: "owner/repo",
          token: "github-secret",
          authorName: "Hanori",
          authorEmail: "hanori@example.com",
          task: "Update README",
          branch: "feat/must-not-exist",
          model: {
            apiKey: "model-secret",
            baseURL: "https://example.com/v1",
            id: "model",
            providerFormat: "openai",
            capabilities: ["tool_calling", "code"],
          },
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);

    const workspace = path.join(workspaceRoot, "bot-1", "owner", "repo");
    expect((await exec("git", ["-C", workspace, "branch", "--show-current"])).stdout.trim()).toBe(
      "main",
    );
    expect((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      originalHead,
    );
    expect((await exec("git", ["-C", workspace, "status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
    const gitDir = path.join(gitRoot, "bot-1", "owner", "repo.git");
    await expect(
      exec("git", [
        `--git-dir=${gitDir}`,
        "show-ref",
        "--verify",
        "refs/heads/feat/must-not-exist",
      ]),
    ).rejects.toThrow();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("blocks lazy object fetches in the credential-less git environment", () => {
    const worker = new CodingWorkerClient({ url: "", secret: "" });
    const service = new GitWorkspaceService("/tmp/workspaces", "/tmp/git", worker);
    const internals = service as unknown as {
      gitEnvironment: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    };
    expect(internals.gitEnvironment()).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });

  it("backfills promised objects and drops partial clone config from legacy workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-partial-test-"));
    tempDirs.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", [`--git-dir=${remote}`, "config", "uploadpack.allowFilter", "true"]);
    await exec("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "before\n");
    await exec("git", ["-C", seed, "add", "README.md"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
    await exec("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await exec("git", [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await exec("git", ["-C", seed, "checkout", "-b", "side"]);
    await writeFile(path.join(seed, "SIDE.md"), "side only\n");
    await exec("git", ["-C", seed, "add", "SIDE.md"]);
    await exec("git", [
      "-C",
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "side",
    ]);
    await exec("git", ["-C", seed, "push", "origin", "side"]);

    const workspaceRoot = path.join(root, "workspaces");
    const gitRoot = path.join(root, "metadata");
    const stagingRoot = path.join(root, "coding-job");
    await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
    const workspace = path.join(workspaceRoot, "bot-1", "owner", "repo");
    const gitDir = path.join(gitRoot, "bot-1", "owner", "repo.git");
    await mkdir(path.dirname(workspace), { recursive: true });
    await mkdir(path.dirname(gitDir), { recursive: true });
    const remoteUrl = `file://${remote}`;
    await exec("git", [
      "clone",
      "--origin",
      "origin",
      "--filter=blob:none",
      "--separate-git-dir",
      gitDir,
      remoteUrl,
      workspace,
    ]);
    expect(
      (await exec("git", [`--git-dir=${gitDir}`, "config", "--get", "remote.origin.promisor"]))
        .stdout,
    ).toContain("true");
    const noLazyFetch = { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } };
    await expect(
      exec("git", [`--git-dir=${gitDir}`, "cat-file", "-e", "origin/side:SIDE.md"], noLazyFetch),
    ).rejects.toThrow();

    const worker = new CodingWorkerClient({ url: "", secret: "" });
    const service = new GitWorkspaceService(
      workspaceRoot,
      gitRoot,
      worker,
      process.getuid?.() ?? 1000,
      process.getgid?.() ?? 1000,
      () => remoteUrl,
      new CodingJobStager(stagingRoot),
    );
    const internals = service as unknown as {
      ensureWorkspace: (
        botId: string,
        repository: string,
        token: string,
        signal?: AbortSignal,
      ) => Promise<string>;
      git: (
        cwd: string,
        args: string[],
        env?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
        timeoutMs?: number,
      ) => Promise<string>;
    };
    const git = vi.spyOn(internals, "git");
    await internals.ensureWorkspace("bot-1", "owner/repo", "github-secret");

    expect(git.mock.calls.some((call) => call[1].includes("--refetch"))).toBe(true);
    for (const key of [
      "remote.origin.promisor",
      "remote.origin.partialclonefilter",
      "extensions.partialClone",
    ]) {
      await expect(exec("git", [`--git-dir=${gitDir}`, "config", "--get", key])).rejects.toThrow();
    }
    await exec(
      "git",
      [`--git-dir=${gitDir}`, "cat-file", "-e", "origin/side:SIDE.md"],
      noLazyFetch,
    );

    git.mockClear();
    await internals.ensureWorkspace("bot-1", "owner/repo", "github-secret");
    expect(git.mock.calls.some((call) => call[1].includes("--refetch"))).toBe(false);
  });
});
