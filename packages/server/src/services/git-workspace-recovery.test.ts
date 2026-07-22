import { execFile } from "node:child_process";
import type { GitHubCodingModelConfig, GitHubWorkspaceInspection } from "@cos-tool-bot/shared";
import { mkdirSync, renameSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingJobStager } from "./coding-job-stager.js";
import { CodingWorkerClient } from "./coding-worker-client.js";
import { GitWorkspaceService } from "./git-workspace-service.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];
const model: GitHubCodingModelConfig = {
  apiKey: "model-secret",
  baseURL: "https://example.com/v1",
  id: "model",
  providerFormat: "openai" as const,
  capabilities: ["tool_calling", "code"],
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-recovery-test-"));
  tempDirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "main", seed]);
  await writeFile(path.join(seed, "README.md"), "before\n");
  await writeFile(path.join(seed, "delete-me.txt"), "tracked\n");
  await writeFile(path.join(seed, "script.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(seed, "script.sh"), 0o755);
  await writeFile(path.join(seed, ".gitignore"), ".env\n.cos-pi-cache/\n");
  await exec("git", ["-C", seed, "add", "."]);
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
  await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
  const worker = new CodingWorkerClient({ url: "", secret: "" });
  const run = vi.spyOn(worker, "run").mockResolvedValue({ summary: "bootstrap", durationMs: 1 });
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
  await service.runCodeTask({
    botId: "bot-1",
    repository: "owner/repo",
    token: "github-secret",
    authorName: "Ai-chan",
    authorEmail: "ai-chan@example.com",
    task: "Bootstrap workspace",
    branch: "feat/recovery",
    model,
  });
  run.mockClear();
  return {
    service,
    stager,
    worker,
    run,
    workspace: path.join(workspaceRoot, "bot-1", "owner", "repo"),
    stagingRoot,
  };
}

const inspectOptions = { botId: "bot-1", repository: "owner/repo" };

async function commitNegatedProtectedIgnores(workspace: string): Promise<void> {
  await writeFile(
    path.join(workspace, ".gitignore"),
    "!.env\n!.cos-pi-cache/\n!.cos-pi-cache/**\n",
  );
  await exec("git", ["-C", workspace, "add", ".gitignore"]);
  await exec("git", ["-C", workspace, "commit", "-m", "expose protected local paths"]);
}

describe("Git workspace recovery", () => {
  it("inspects clean state and fingerprints branch, HEAD, index, content, and metadata", async () => {
    const { service, workspace } = await fixture();
    const clean = await service.inspectWorkspace(inspectOptions);
    expect(clean).toMatchObject({ branch: "feat/recovery", clean: true, changedFiles: [] });

    await writeFile(path.join(workspace, ".env"), "IGNORED_SECRET_CANARY\n");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache"), "ignored\n");
    const withIgnoredFiles = await service.inspectWorkspace(inspectOptions);
    expect(withIgnoredFiles.fingerprint).toBe(clean.fingerprint);
    expect(withIgnoredFiles.changedFiles).toEqual([]);

    const fingerprints = new Set<string>([clean.fingerprint]);
    await writeFile(path.join(workspace, "README.md"), "dirty-one\n");
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await writeFile(path.join(workspace, "README.md"), "dirty-two\n");
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await exec("git", ["-C", workspace, "add", "README.md"]);
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await writeFile(path.join(workspace, "untracked.txt"), "new\n");
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await rm(path.join(workspace, "delete-me.txt"));
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await symlink("README.md", path.join(workspace, "safe-link"));
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await rm(path.join(workspace, "safe-link"));
    await symlink("script.sh", path.join(workspace, "safe-link"));
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    await chmod(path.join(workspace, "script.sh"), 0o644);
    fingerprints.add((await service.inspectWorkspace(inspectOptions)).fingerprint);
    expect(fingerprints).toHaveLength(9);

    await exec("git", ["-C", workspace, "reset", "--hard", "HEAD"]);
    await exec("git", ["-C", workspace, "clean", "-fd"]);
    await exec("git", ["-C", workspace, "checkout", "-b", "feat/other"]);
    const otherBranch = await service.inspectWorkspace(inspectOptions);
    expect(otherBranch.headSha).toBe(clean.headSha);
    expect(otherBranch.fingerprint).not.toBe(clean.fingerprint);
    await exec("git", ["-C", workspace, "commit", "--allow-empty", "-m", "advance"]);
    const otherHead = await service.inspectWorkspace(inspectOptions);
    expect(otherHead.headSha).not.toBe(clean.headSha);
    expect(otherHead.fingerprint).not.toBe(otherBranch.fingerprint);
  });

  it("keeps protected untracked paths out of inspection even when .gitignore negates local excludes", async () => {
    const { service, workspace } = await fixture();
    await commitNegatedProtectedIgnores(workspace);
    const clean = await service.inspectWorkspace(inspectOptions);

    await writeFile(path.join(workspace, ".env"), "LOCAL_SECRET_CANARY\n");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache"), "local cache\n");
    const rawStatus = (await exec("git", ["-C", workspace, "status", "--porcelain"])).stdout;
    expect(rawStatus).toContain("?? .env");
    expect(rawStatus).toContain("?? .cos-pi-cache/");

    const inspected = await service.inspectWorkspace(inspectOptions);
    expect(inspected).toEqual(clean);
  });

  it("does not copy or commit protected untracked paths when resuming through negated ignores", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await commitNegatedProtectedIgnores(workspace);
    await writeFile(path.join(workspace, ".env"), "LOCAL_SECRET_CANARY\n");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache"), "local cache\n");
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    expect(inspection.changedFiles).toEqual(["README.md"]);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await expect(readFile(path.join(staged, ".env"))).rejects.toThrow();
      await expect(readFile(path.join(staged, ".cos-pi-cache", "cache"))).rejects.toThrow();
      await writeFile(path.join(staged, "README.md"), "recovered\n");
      return { summary: "recovered", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Resume without local secrets",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("LOCAL_SECRET_CANARY\n");
    expect(await readFile(path.join(workspace, ".cos-pi-cache", "cache"), "utf8")).toBe(
      "local cache\n",
    );
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    const committedPaths = (
      await exec("git", ["-C", workspace, "show", "--pretty=", "--name-only", "HEAD"])
    ).stdout;
    expect(committedPaths).not.toContain(".env");
    expect(committedPaths).not.toContain(".cos-pi-cache");
  });

  it("rejects protected paths created by the worker instead of ignoring or committing them", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await commitNegatedProtectedIgnores(workspace);
    await writeFile(path.join(workspace, ".env"), "LOCAL_SECRET_CANARY\n");
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      await writeFile(path.join(stagingRoot, job.workspacePath, ".env"), "worker value\n");
      return { summary: "created env", durationMs: 1 };
    });

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Do not commit protected files",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
      ),
    ).rejects.toThrow("Pi result changed protected local paths");

    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("LOCAL_SECRET_CANARY\n");
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("dirty\n");
    await expect(
      exec("git", ["-C", workspace, "ls-files", "--error-unmatch", ".env"]),
    ).rejects.toThrow();
  });

  it("preserves protected untracked paths when discarding through negated ignores", async () => {
    const { service, workspace } = await fixture();
    await commitNegatedProtectedIgnores(workspace);
    await writeFile(path.join(workspace, ".env"), "LOCAL_SECRET_CANARY\n");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache"), "local cache\n");
    await writeFile(path.join(workspace, "untracked.txt"), "remove\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    expect(inspection.changedFiles).toEqual(["untracked.txt"]);

    const result = await service.discardWorkspace(inspectOptions, inspection);

    expect(result.clean).toBe(true);
    await expect(readFile(path.join(workspace, "untracked.txt"))).rejects.toThrow();
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toBe("LOCAL_SECRET_CANARY\n");
    expect(await readFile(path.join(workspace, ".cos-pi-cache", "cache"), "utf8")).toBe(
      "local cache\n",
    );
  });

  it.each([".env", ".cos-pi-cache/tracked"])(
    "fails closed when recovery encounters tracked protected path %s",
    async (protectedPath) => {
      const { service, stager, run, workspace } = await fixture();
      const expected = await service.inspectWorkspace(inspectOptions);
      await mkdir(path.dirname(path.join(workspace, protectedPath)), { recursive: true });
      await writeFile(path.join(workspace, protectedPath), "tracked secret\n");
      await exec("git", ["-C", workspace, "add", "-f", protectedPath]);
      await exec("git", ["-C", workspace, "commit", "-m", "track protected local path"]);
      const stage = vi.spyOn(stager, "stageRecoverySnapshot");

      await expect(service.inspectWorkspace(inspectOptions)).rejects.toThrow(
        `Tracked protected local path cannot be recovered: ${protectedPath}`,
      );
      await expect(
        service.resumeWorkspace(
          {
            ...inspectOptions,
            task: "Unsafe resume",
            authorName: "Ai-chan",
            authorEmail: "ai-chan@example.com",
            model,
          },
          expected,
        ),
      ).rejects.toThrow(`Tracked protected local path cannot be recovered: ${protectedPath}`);
      await expect(service.discardWorkspace(inspectOptions, expected)).rejects.toThrow(
        `Tracked protected local path cannot be recovered: ${protectedPath}`,
      );
      expect(stage).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(path.join(workspace, protectedPath), "utf8")).toBe("tracked secret\n");
    },
  );

  it("waits for worker readiness before staging a recovery snapshot and honors cancellation", async () => {
    const { service, stager, worker, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    const controller = new AbortController();
    const reason = new Error("cancelled while waiting for fresh worker");
    const waitForFreshBoot = vi.spyOn(worker, "waitForFreshBoot").mockImplementation(
      async (signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const stage = vi.spyOn(stager, "stageRecoverySnapshot");

    const resuming = service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Resume after restart",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
      controller.signal,
    );
    await vi.waitFor(() => expect(waitForFreshBoot).toHaveBeenCalledWith(controller.signal));
    expect(stage).not.toHaveBeenCalled();
    controller.abort(reason);

    await expect(resuming).rejects.toBe(reason);
    expect(stage).not.toHaveBeenCalled();
  });

  it("resumes the exact dirty snapshot and commits tracked deletions and safe untracked files", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    await rm(path.join(workspace, "delete-me.txt"));
    await writeFile(path.join(workspace, "untracked.txt"), "untracked\n");
    await chmod(path.join(workspace, "untracked.txt"), 0o755);
    await symlink("README.md", path.join(workspace, "safe-link"));
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      expect(await readFile(path.join(staged, "README.md"), "utf8")).toBe("dirty\n");
      await expect(readFile(path.join(staged, "delete-me.txt"))).rejects.toThrow();
      expect(await readFile(path.join(staged, "untracked.txt"), "utf8")).toBe("untracked\n");
      expect((await lstat(path.join(staged, "untracked.txt"))).mode & 0o111).toBe(0o111);
      expect(await readlink(path.join(staged, "safe-link"))).toBe("README.md");
      await writeFile(path.join(staged, "worker.txt"), "worker\n");
      return { summary: "recovered", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Finish recovery",
        commitMessage: "fix: recover workspace",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        "README.md",
        "delete-me.txt",
        "safe-link",
        "untracked.txt",
        "worker.txt",
      ]),
    );
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    await expect(readFile(path.join(workspace, "delete-me.txt"))).rejects.toThrow();
    expect(await readFile(path.join(workspace, "worker.txt"), "utf8")).toBe("worker\n");
  });

  it("force-stages a bound untracked file that the worker newly ignores", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "notes.local"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await writeFile(path.join(staged, ".gitignore"), ".env\n.cos-pi-cache/\nnotes.local\n");
      await writeFile(path.join(staged, "notes.local"), "updated notes\n");
      return { summary: "kept ignored notes", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Keep notes.local while ignoring future local notes",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "notes.local"), "utf8")).toBe("updated notes\n");
    expect(
      (await exec("git", ["-C", workspace, "show", `${result.commitSha}:notes.local`])).stdout,
    ).toBe("updated notes\n");
  });

  it("does not force-stage ignored descendants when a bound file becomes a directory", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "notes.local"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes.local"));
      await mkdir(path.join(staged, "notes.local"));
      await writeFile(path.join(staged, "notes.local", "secret.local"), "do not commit\n");
      await writeFile(path.join(staged, ".gitignore"), ".env\n.cos-pi-cache/\nnotes.local/\n");
      return { summary: "replaced notes with ignored directory", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Replace notes.local without committing ignored secrets",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    await expect(
      exec("git", ["-C", workspace, "show", `${result.commitSha}:notes.local/secret.local`]),
    ).rejects.toThrow();
    await expect(readFile(path.join(workspace, "notes.local", "secret.local"))).rejects.toThrow();
    await expect(
      readFile(path.join(stagingRoot, "workspace", "notes.local", "secret.local")),
    ).rejects.toThrow();
  });

  it("skips an empty directory that replaces a bound file while committing tracked changes", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "notes.local"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes.local"));
      await mkdir(path.join(staged, "notes.local"));
      await writeFile(path.join(staged, "README.md"), "worker update\n");
      return {
        summary: "updated README and replaced notes with an empty directory",
        durationMs: 1,
      };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Update README and replace notes.local with an empty directory",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("worker update\n");
    await expect(readFile(path.join(workspace, "notes.local"))).rejects.toThrow();
  });

  it("lets normal staging replace a bound path parent with a safe symlink", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await mkdir(path.join(workspace, "notes"));
    await writeFile(path.join(workspace, "notes", "local.txt"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes"), { recursive: true });
      await symlink("README.md", path.join(staged, "notes"));
      return { summary: "replaced notes directory with a symlink", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Replace the notes directory with a safe symlink",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readlink(path.join(workspace, "notes"))).toBe("README.md");
    expect((await exec("git", ["-C", workspace, "show", `${result.commitSha}:notes`])).stdout).toBe(
      "README.md",
    );
  });

  it("lets normal staging replace a bound path parent with a regular file", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await mkdir(path.join(workspace, "notes"));
    await writeFile(path.join(workspace, "notes", "local.txt"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes"), { recursive: true });
      await writeFile(path.join(staged, "notes"), "replacement file\n");
      return { summary: "replaced notes directory with a file", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Replace the notes directory with a regular file",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "notes"), "utf8")).toBe("replacement file\n");
    expect((await exec("git", ["-C", workspace, "show", `${result.commitSha}:notes`])).stdout).toBe(
      "replacement file\n",
    );
  });

  it("does not force-stage an ignored replacement for a bound path parent", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await mkdir(path.join(workspace, "notes"));
    await writeFile(path.join(workspace, "notes", "local.txt"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes"), { recursive: true });
      await symlink("README.md", path.join(staged, "notes"));
      await writeFile(path.join(staged, ".gitignore"), ".env\n.cos-pi-cache/\nnotes\n");
      await writeFile(path.join(staged, "README.md"), "worker update\n");
      return { summary: "ignored the replacement parent", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Ignore the replacement notes parent",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("worker update\n");
    await expect(
      exec("git", ["-C", workspace, "show", `${result.commitSha}:notes`]),
    ).rejects.toThrow();
    await expect(readFile(path.join(workspace, "notes", "local.txt"))).rejects.toThrow();
  });

  it("force-stages bound files when an untracked ignore file hides the whole result", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await exec("git", ["-C", workspace, "rm", ".gitignore"]);
    await exec("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "stop tracking ignore rules",
    ]);
    await writeFile(path.join(workspace, ".gitignore"), ".env\n.cos-pi-cache/\n");
    await writeFile(path.join(workspace, "notes.local"), "original notes\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await writeFile(
        path.join(staged, ".gitignore"),
        ".env\n.cos-pi-cache/\n.gitignore\nnotes.local\nunrelated.secret\n",
      );
      await writeFile(path.join(staged, "notes.local"), "updated notes\n");
      await writeFile(path.join(staged, "unrelated.secret"), "do not commit\n");
      return { summary: "kept bound ignored files", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Keep only the originally bound ignored files",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect(result.changedFiles).toEqual(expect.arrayContaining([".gitignore", "notes.local"]));
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "notes.local"), "utf8")).toBe("updated notes\n");
    expect(
      (await exec("git", ["-C", workspace, "show", `${result.commitSha}:.gitignore`])).stdout,
    ).toContain(".gitignore\nnotes.local\nunrelated.secret\n");
    await expect(
      exec("git", ["-C", workspace, "show", `${result.commitSha}:unrelated.secret`]),
    ).rejects.toThrow();
    await expect(readFile(path.join(workspace, "unrelated.secret"))).rejects.toThrow();
  });

  it("skips a deleted bound path while committing another worker change", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "notes.local"), "delete me\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      await rm(path.join(staged, "notes.local"));
      await writeFile(path.join(staged, "README.md"), "worker update\n");
      return { summary: "updated README and removed notes", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Update README and remove notes.local",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("worker update\n");
    await expect(readFile(path.join(workspace, "notes.local"))).rejects.toThrow();
  });

  it("returns no changes when the worker only deletes a bound untracked file", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "notes.local"), "delete me\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      await rm(path.join(stagingRoot, job.workspacePath, "notes.local"));
      return { summary: "removed notes", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Remove notes.local",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("no_changes");
    expect(result.commitSha).toBe(inspection.headSha);
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    await expect(readFile(path.join(workspace, "notes.local"))).rejects.toThrow();
  });

  it("recovers a tracked file replaced by a directory of non-ignored files", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await rm(path.join(workspace, "delete-me.txt"));
    await mkdir(path.join(workspace, "delete-me.txt"));
    await writeFile(path.join(workspace, "delete-me.txt", "child.txt"), "replacement\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      const staged = path.join(stagingRoot, job.workspacePath);
      expect(await readFile(path.join(staged, "delete-me.txt", "child.txt"), "utf8")).toBe(
        "replacement\n",
      );
      return { summary: "recovered replacement", durationMs: 1 };
    });

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Keep the replacement directory",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("committed");
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "delete-me.txt", "child.txt"), "utf8")).toBe(
      "replacement\n",
    );
  });

  it("returns no changes when adding the recovered worktree cancels staged-only changes", async () => {
    const { service, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "staged change\n");
    await exec("git", ["-C", workspace, "add", "README.md"]);
    await writeFile(path.join(workspace, "README.md"), "before\n");
    const inspection = await service.inspectWorkspace(inspectOptions);

    const result = await service.resumeWorkspace(
      {
        ...inspectOptions,
        task: "Keep the final worktree content",
        authorName: "Ai-chan",
        authorEmail: "ai-chan@example.com",
        model,
      },
      inspection,
    );

    expect(result.status).toBe("no_changes");
    expect(result.commitSha).toBe(inspection.headSha);
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
  });

  it.each(["add", "commit", "reset"] as const)(
    "restores the exact branch, index, and worktree after a post-%s failure",
    async (failurePoint) => {
      const { service, run, workspace, stagingRoot } = await fixture();
      await writeFile(path.join(workspace, "README.md"), "staged\n");
      await exec("git", ["-C", workspace, "add", "README.md"]);
      await writeFile(path.join(workspace, "README.md"), "unstaged\n");
      await writeFile(path.join(workspace, "untracked.txt"), "original untracked\n");
      const inspection = await service.inspectWorkspace(inspectOptions);
      run.mockImplementation(async (job) => {
        await writeFile(path.join(stagingRoot, job.workspacePath, "worker.txt"), "worker result\n");
        return { summary: "worker result", durationMs: 1 };
      });

      type GitWithWorkTree = (
        workspacePath: string,
        workTree: string,
        args: string[],
        env?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
      ) => Promise<string>;
      const internals = service as unknown as { gitWithWorkTree: GitWithWorkTree };
      const original = internals.gitWithWorkTree.bind(service);
      let injected = false;
      vi.spyOn(internals, "gitWithWorkTree").mockImplementation(async (...args) => {
        const result = await original(...args);
        const command = args[2][0];
        const isCanonicalAdd = command === "add" && !args[3]?.["GIT_INDEX_FILE"];
        const matches =
          (failurePoint === "add" && isCanonicalAdd) ||
          (failurePoint === "commit" && command === "commit") ||
          (failurePoint === "reset" && command === "reset" && args[2][1] === "--hard");
        if (!injected && matches) {
          injected = true;
          throw new Error(`injected post-${failurePoint} failure`);
        }
        return result;
      });

      await expect(
        service.resumeWorkspace(
          {
            ...inspectOptions,
            task: "Resume",
            authorName: "Ai-chan",
            authorEmail: "ai-chan@example.com",
            model,
          },
          inspection,
        ),
      ).rejects.toThrow(`injected post-${failurePoint} failure`);

      expect(await service.inspectWorkspace(inspectOptions)).toEqual(inspection);
      expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("unstaged\n");
      expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe(
        "original untracked\n",
      );
      await expect(readFile(path.join(workspace, "worker.txt"))).rejects.toThrow();
    },
  );

  it("restores the exact dirty snapshot when staging cleanup fails after commit", async () => {
    const { service, stager, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "staged\n");
    await exec("git", ["-C", workspace, "add", "README.md"]);
    await writeFile(path.join(workspace, "README.md"), "unstaged\n");
    await writeFile(path.join(workspace, "untracked.txt"), "original untracked\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      await writeFile(path.join(stagingRoot, job.workspacePath, "worker.txt"), "worker result\n");
      return { summary: "worker result", durationMs: 1 };
    });
    const cleanupFailure = new Error("injected staging cleanup failure");
    const cleanup = vi.spyOn(stager, "cleanup").mockRejectedValueOnce(cleanupFailure);

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Resume",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
      ),
    ).rejects.toBe(cleanupFailure);

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(await service.inspectWorkspace(inspectOptions)).toEqual(inspection);
    expect((await exec("git", ["-C", workspace, "show", ":README.md"])).stdout).toBe("staged\n");
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("unstaged\n");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe(
      "original untracked\n",
    );
    await expect(readFile(path.join(workspace, "worker.txt"))).rejects.toThrow();
    await expect(
      readFile(path.join(stagingRoot, "workspace", "worker.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("fails and rolls back resume when a result exposes a previously ignored file", async () => {
    const { service, run, workspace, stagingRoot } = await fixture();
    const dirtyIgnore = ".env\n.cos-pi-cache/\npreserved.secret\n";
    await writeFile(path.join(workspace, ".gitignore"), dirtyIgnore);
    await writeFile(path.join(workspace, "preserved.secret"), "do not delete\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    run.mockImplementation(async (job) => {
      await writeFile(
        path.join(stagingRoot, job.workspacePath, ".gitignore"),
        ".env\n.cos-pi-cache/\n",
      );
      return { summary: "remove ignore", durationMs: 1 };
    });

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Remove the ignore rule",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
      ),
    ).rejects.toThrow("did not become clean");

    expect(await service.inspectWorkspace(inspectOptions)).toEqual(inspection);
    expect(await readFile(path.join(workspace, ".gitignore"), "utf8")).toBe(dirtyIgnore);
    expect(await readFile(path.join(workspace, "preserved.secret"), "utf8")).toBe(
      "do not delete\n",
    );
  });

  it("rejects a canonical directory swap before adding the recovery result", async () => {
    const { service, run, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    const movedWorkspace = `${workspace}-moved`;
    type GitWithWorkTree = (
      workspacePath: string,
      workTree: string,
      args: string[],
      env?: NodeJS.ProcessEnv,
      signal?: AbortSignal,
    ) => Promise<string>;
    const internals = service as unknown as { gitWithWorkTree: GitWithWorkTree };
    const original = internals.gitWithWorkTree.bind(service);
    let swapped = false;
    const gitWithWorkTree = vi
      .spyOn(internals, "gitWithWorkTree")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!swapped && args[1] !== args[0] && args[2][0] === "branch") {
          swapped = true;
          await rename(workspace, movedWorkspace);
          await mkdir(workspace);
        }
        return result;
      });

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Resume",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
      ),
    ).rejects.toThrow("identity changed");
    expect(run).toHaveBeenCalledOnce();
    expect(
      gitWithWorkTree.mock.calls.some(
        (call) => call[2][0] === "add" && !call[3]?.["GIT_INDEX_FILE"],
      ),
    ).toBe(false);
  });

  it("rejects stale recovery state before invoking the worker", async () => {
    const { service, run, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "first\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    await writeFile(path.join(workspace, "README.md"), "second\n");

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Resume",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
      ),
    ).rejects.toThrow("changed after confirmation preview");
    await expect(service.discardWorkspace(inspectOptions, inspection)).rejects.toThrow(
      "changed after confirmation preview",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a canonical directory swap before discarding changes", async () => {
    const { service, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    const movedWorkspace = `${workspace}-moved`;
    type AssertExpectedInspection = (
      current: GitHubWorkspaceInspection,
      expected: GitHubWorkspaceInspection,
    ) => void;
    const internals = service as unknown as {
      assertExpectedInspection: AssertExpectedInspection;
    };
    const original = internals.assertExpectedInspection.bind(service);
    let swapped = false;
    vi.spyOn(internals, "assertExpectedInspection").mockImplementation((...args) => {
      original(...args);
      if (!swapped) {
        swapped = true;
        renameSync(workspace, movedWorkspace);
        mkdirSync(workspace);
      }
    });

    await expect(service.discardWorkspace(inspectOptions, inspection)).rejects.toThrow(
      "identity changed",
    );
    expect(await readFile(path.join(movedWorkspace, "README.md"), "utf8")).toBe("dirty\n");
  });

  it.each(["failure", "cancel"])("leaves canonical changes dirty after worker %s", async (kind) => {
    const { service, run, workspace, stagingRoot } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    const inspection = await service.inspectWorkspace(inspectOptions);
    const controller = new AbortController();
    const reason = new Error(kind);
    run.mockImplementation(async (_job, signal) => {
      expect(signal).toBe(controller.signal);
      if (kind === "cancel") controller.abort(reason);
      throw reason;
    });

    await expect(
      service.resumeWorkspace(
        {
          ...inspectOptions,
          task: "Resume",
          authorName: "Ai-chan",
          authorEmail: "ai-chan@example.com",
          model,
        },
        inspection,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(false);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("dirty\n");
    await expect(readFile(path.join(stagingRoot, "workspace", "README.md"))).rejects.toThrow();
  });

  it("discards tracked and untracked changes while preserving ignored files", async () => {
    const { service, workspace } = await fixture();
    await writeFile(path.join(workspace, "README.md"), "dirty\n");
    await rm(path.join(workspace, "delete-me.txt"));
    await writeFile(path.join(workspace, "untracked.txt"), "remove\n");
    await writeFile(path.join(workspace, ".env"), "IGNORED_SECRET_CANARY\n");
    await mkdir(path.join(workspace, ".cos-pi-cache"));
    await writeFile(path.join(workspace, ".cos-pi-cache", "cache"), "keep\n");
    const inspection = await service.inspectWorkspace(inspectOptions);

    await service.discardWorkspace(inspectOptions, inspection);

    expect((await service.inspectWorkspace(inspectOptions)).clean).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(workspace, "delete-me.txt"), "utf8")).toBe("tracked\n");
    await expect(readFile(path.join(workspace, "untracked.txt"))).rejects.toThrow();
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toContain("IGNORED_SECRET");
    expect(await readFile(path.join(workspace, ".cos-pi-cache", "cache"), "utf8")).toBe("keep\n");
  });

  it("preserves data made visible by discarding a dirty ignore rule", async () => {
    const { service, workspace } = await fixture();
    await writeFile(
      path.join(workspace, ".gitignore"),
      ".env\n.cos-pi-cache/\npreserved.secret\nglob1.txt\n",
    );
    await writeFile(path.join(workspace, "preserved.secret"), "do not delete\n");
    await writeFile(path.join(workspace, "glob1.txt"), "ignored pattern match\n");
    await writeFile(path.join(workspace, "glob[1].txt"), "remove exact literal\n");
    const inspection = await service.inspectWorkspace(inspectOptions);

    const result = await service.discardWorkspace(inspectOptions, inspection);

    expect(result.clean).toBe(false);
    expect(result.remainingFiles).toContain("preserved.secret");
    expect(result.summary).toContain("workspace 仍为 dirty");
    expect(await readFile(path.join(workspace, "preserved.secret"), "utf8")).toBe(
      "do not delete\n",
    );
    expect(await readFile(path.join(workspace, "glob1.txt"), "utf8")).toBe(
      "ignored pattern match\n",
    );
    await expect(readFile(path.join(workspace, "glob[1].txt"))).rejects.toThrow();
  });

  it("rejects gitlinks instead of treating submodule directories as deletions", async () => {
    const { service, workspace } = await fixture();
    const head = (await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", [
      "-C",
      workspace,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},vendor/submodule`,
    ]);

    await expect(service.inspectWorkspace(inspectOptions)).rejects.toThrow(
      "Git submodules are not supported in recovery snapshots: vendor/submodule",
    );
  });
});
