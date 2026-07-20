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

describe("Git workspace input validation", () => {
  it("accepts normal repositories and feature branches", () => {
    expect(() => validateRepository("owner/repository.js")).not.toThrow();
    expect(() => validateGitBranch("feat/ai-chan-fix")).not.toThrow();
  });

  it("rejects traversal repositories and dangerous refs", () => {
    expect(() => validateRepository("../repo")).toThrow("Invalid GitHub repository");
    expect(() => validateGitBranch("feat/../main")).toThrow("Invalid Git branch name");
    expect(() => validateGitBranch("main.lock")).toThrow("Invalid Git branch name");
    expect(() => validateGitBranch("bad@{ref")).toThrow("Invalid Git branch name");
  });

  it("keeps Git metadata outside Pi's working tree, commits as Ai-chan, and pushes only explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-test-"));
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
      await writeFile(path.join(stagingRoot, job.workspacePath, "README.md"), "after\n");
      return { summary: "updated README", durationMs: 1 };
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

    const result = await service.runCodeTask({
      botId: "bot-1",
      repository: "owner/repo",
      token: "github-secret",
      authorName: "Ai-chan",
      authorEmail: "ai-chan@example.com",
      task: "Update README",
      branch: "feat/ai-readme",
      commitMessage: "docs: update README",
      model: {
        apiKey: "model-secret",
        baseURL: "https://example.com/v1",
        id: "model",
        providerFormat: "openai",
      },
    });

    expect(result.status).toBe("committed");
    expect(run).toHaveBeenCalledOnce();
    const workspace = path.join(workspaceRoot, "bot-1", "owner", "repo");
    const gitFile = await readFile(path.join(workspace, ".git"), "utf8");
    expect(gitFile).toContain(path.join(gitRoot, "bot-1", "owner", "repo.git"));
    const excludeFile = await readFile(
      path.join(gitRoot, "bot-1", "owner", "repo.git", "info", "exclude"),
      "utf8",
    );
    expect(excludeFile).toContain(".cos-pi-cache/");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache-entry"), "cached\n");
    await service.runCodeTask({
      botId: "bot-1",
      repository: "owner/repo",
      token: "github-secret",
      authorName: "Ai-chan",
      authorEmail: "ai-chan@example.com",
      task: "Check README",
      branch: "feat/ai-readme",
      model: {
        apiKey: "model-secret",
        baseURL: "https://example.com/v1",
        id: "model",
        providerFormat: "openai",
      },
    });
    expect(await readFile(path.join(workspace, ".cos-pi-cache", "cache-entry"), "utf8")).toBe(
      "cached\n",
    );
    const author = await exec("git", [
      `--git-dir=${path.join(gitRoot, "bot-1", "owner", "repo.git")}`,
      "show",
      "-s",
      "--format=%an|%ae",
      result.commitSha,
    ]);
    expect(author.stdout.trim()).toBe("Ai-chan|ai-chan@example.com");

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
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        task: "Try another edit",
        branch: "feat/ai-readme",
        model: {
          apiKey: "model-secret",
          baseURL: "https://example.com/v1",
          id: "model",
          providerFormat: "openai",
        },
      }),
    ).rejects.toThrow("uncommitted changes from an earlier coding job");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
