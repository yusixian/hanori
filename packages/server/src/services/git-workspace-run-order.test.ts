import { execFile } from "node:child_process";
import type { GitHubCodingModelConfig } from "@cos-tool-bot/shared";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  providerFormat: "openai",
  capabilities: ["tool_calling", "code"],
};
const inspectOptions = { botId: "bot-1", repository: "owner/repo" };
const taskOptions = {
  ...inspectOptions,
  token: "github-secret",
  authorName: "Hanori",
  authorEmail: "hanori@example.com",
  task: "Update README",
  branch: "feat/run-order",
  model,
};
const resumeOptions = {
  ...inspectOptions,
  task: "Finish recovery",
  authorName: "Hanori",
  authorEmail: "hanori@example.com",
  model,
};

type Method = (...args: unknown[]) => Promise<unknown>;
type Methods = Record<string, Method>;

const COMPOSITE_STEPS = [
  "ensureWorkspace",
  "createCodeTaskCheckpoint",
  "prepareBranch",
  "inspectWorkspaceLocked",
  "createRecoveryCheckpoint",
  "assertNoProtectedStagedChanges",
  "addBoundUntrackedPaths",
  "cleanRecoveryPaths",
  "restoreCodeTaskCheckpoint",
  "restoreRecoveryCheckpoint",
];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-workspace-run-order-test-"));
  tempDirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "main", seed]);
  await writeFile(path.join(seed, "README.md"), "before\n");
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
  const originalHead = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();

  const workspaceRoot = path.join(root, "workspaces");
  const gitRoot = path.join(root, "metadata");
  const stagingRoot = path.join(root, "coding-job");
  await Promise.all([mkdir(workspaceRoot), mkdir(gitRoot), mkdir(stagingRoot)]);
  const events: string[] = [];
  let runs = 0;
  const worker = new CodingWorkerClient({ url: "", secret: "" });
  vi.spyOn(worker, "run").mockImplementation(async (job) => {
    events.push("worker.run");
    await writeFile(path.join(stagingRoot, job.workspacePath, "README.md"), `after ${++runs}\n`);
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
  return {
    events,
    service,
    stager,
    worker,
    originalHead,
    stagingRoot,
    workspace: path.join(workspaceRoot, "bot-1", "owner", "repo"),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Records top-level protocol steps; calls made inside a composite helper are folded into the
 * helper's own event so the log shows exactly what each entry point sequences itself.
 */
function recordSteps({ events, service, stager, worker }: Fixture, failAfter?: string): void {
  let depth = 0;
  const intercept = (
    target: Methods,
    name: string,
    label: (args: unknown[]) => string,
    composite = false,
  ) => {
    const original = target[name]!.bind(target);
    vi.spyOn(target, name).mockImplementation(async (...args) => {
      const event = depth === 0 ? label(args) : undefined;
      if (event) events.push(event);
      if (composite) depth++;
      try {
        const result = await original(...args);
        if (event && event === failAfter) throw new Error(`injected failure after ${event}`);
        return result;
      } finally {
        if (composite) depth--;
      }
    });
  };
  const internals = service as unknown as Methods;
  for (const name of COMPOSITE_STEPS) intercept(internals, name, () => name, true);
  intercept(internals, "assertWorkspaceIdentity", () => "identity");
  intercept(internals, "gitWithWorkTree", ([canonical, workTree, args]) => {
    const command = (args as string[]).slice(0, 2).join(" ");
    return canonical === workTree ? `git ${command}` : `staged git ${command}`;
  });
  for (const name of ["stage", "stageRecoverySnapshot", "validateResult", "cleanup"]) {
    intercept(stager as unknown as Methods, name, () => `stager.${name}`);
  }
  intercept(worker as unknown as Methods, "waitForFreshBoot", () => "worker.waitForFreshBoot");
}

async function dirtyRecoveryFixture(): Promise<
  Fixture & { inspection: Awaited<ReturnType<GitWorkspaceService["inspectWorkspace"]>> }
> {
  const context = await fixture();
  await context.service.runCodeTask({ ...taskOptions, branch: "feat/recovery" });
  context.events.length = 0;
  await writeFile(path.join(context.workspace, "README.md"), "dirty\n");
  return { ...context, inspection: await context.service.inspectWorkspace(inspectOptions) };
}

const CODE_TASK_STEPS = [
  "ensureWorkspace",
  "createCodeTaskCheckpoint",
  "prepareBranch",
  "git rev-parse HEAD",
  "worker.waitForFreshBoot",
  "stager.stage",
  "identity",
  "worker.run",
  "stager.validateResult",
  "identity",
  "staged git branch --show-current",
  "assertNoProtectedStagedChanges",
  "identity",
  "staged git status --porcelain",
  "identity",
  "staged git add -A",
  "identity",
  "staged git commit -m",
  "stager.cleanup",
  "identity",
  "git rev-parse HEAD",
  "identity",
  "git reset --hard",
  "git diff --name-only",
];

const RESUME_STEPS = [
  "inspectWorkspaceLocked",
  "identity",
  "git config --local",
  "identity",
  "git config --local",
  "worker.waitForFreshBoot",
  "stager.stageRecoverySnapshot",
  "identity",
  "inspectWorkspaceLocked",
  "createRecoveryCheckpoint",
  "inspectWorkspaceLocked",
  "worker.run",
  "stager.validateResult",
  "inspectWorkspaceLocked",
  "staged git branch --show-current",
  "assertNoProtectedStagedChanges",
  "identity",
  "staged git add -A",
  "addBoundUntrackedPaths",
  "identity",
  "staged git diff --cached",
  "identity",
  "staged git commit -m",
  "stager.cleanup",
  "identity",
  "git rev-parse HEAD",
  "identity",
  "git reset --hard",
  "cleanRecoveryPaths",
  "inspectWorkspaceLocked",
  "git diff --name-only",
];

// Real Git subprocesses on a shared runner; the step logs pin the security-relevant order.
describe("Git workspace run protocol order", { timeout: 60_000 }, () => {
  it("sequences a code task with an identity check before every canonical step", async () => {
    const context = await fixture();
    recordSteps(context);

    const result = await context.service.runCodeTask(taskOptions);

    expect(result.status).toBe("committed");
    expect(context.events).toEqual(CODE_TASK_STEPS);
    expect(context.events.filter((event) => event === "identity")).toHaveLength(7);
  });

  it("sequences a workspace resume with an identity check before every canonical step", async () => {
    const context = await dirtyRecoveryFixture();
    recordSteps(context);

    const result = await context.service.resumeWorkspace(resumeOptions, context.inspection);

    expect(result.status).toBe("committed");
    expect(context.events).toEqual(RESUME_STEPS);
    expect(context.events.filter((event) => event === "identity")).toHaveLength(8);
  });

  it("rolls a code task back before cleaning staging when the branch check fails", async () => {
    const context = await fixture();
    recordSteps(context, "staged git branch --show-current");

    await expect(context.service.runCodeTask(taskOptions)).rejects.toThrow(
      "injected failure after staged git branch --show-current",
    );

    expect(
      context.events.slice(CODE_TASK_STEPS.indexOf("staged git branch --show-current")),
    ).toEqual(["staged git branch --show-current", "restoreCodeTaskCheckpoint", "stager.cleanup"]);
    await expectCodeTaskRestored(context);
  });

  it("leaves an untouched resume unrolled and only cleans staging when the branch check fails", async () => {
    const context = await dirtyRecoveryFixture();
    recordSteps(context, "staged git branch --show-current");

    await expect(
      context.service.resumeWorkspace(resumeOptions, context.inspection),
    ).rejects.toThrow("injected failure after staged git branch --show-current");

    expect(context.events.slice(RESUME_STEPS.indexOf("staged git branch --show-current"))).toEqual([
      "staged git branch --show-current",
      "stager.cleanup",
    ]);
    expect(await context.service.inspectWorkspace(inspectOptions)).toEqual(context.inspection);
  });

  it("rolls a code task back after the canonical reset without cleaning staging twice", async () => {
    const context = await fixture();
    recordSteps(context, "git reset --hard");

    await expect(context.service.runCodeTask(taskOptions)).rejects.toThrow(
      "injected failure after git reset --hard",
    );

    expect(context.events.slice(CODE_TASK_STEPS.indexOf("git reset --hard"))).toEqual([
      "git reset --hard",
      "restoreCodeTaskCheckpoint",
    ]);
    await expectCodeTaskRestored(context);
  });

  it("restores the resumed worktree after the canonical reset without cleaning staging twice", async () => {
    const context = await dirtyRecoveryFixture();
    recordSteps(context, "git reset --hard");
    const restore = vi.mocked(
      (context.service as unknown as Methods)["restoreRecoveryCheckpoint"]!,
    );

    await expect(
      context.service.resumeWorkspace(resumeOptions, context.inspection),
    ).rejects.toThrow("injected failure after git reset --hard");

    expect(context.events.slice(RESUME_STEPS.indexOf("git reset --hard"))).toEqual([
      "git reset --hard",
      "restoreRecoveryCheckpoint",
    ]);
    expect(restore.mock.calls[0]?.[3]).toBe(true);
    expect(await context.service.inspectWorkspace(inspectOptions)).toEqual(context.inspection);
    expect(await readFile(path.join(context.workspace, "README.md"), "utf8")).toBe("dirty\n");
  });
});

async function expectCodeTaskRestored({ workspace, originalHead, stagingRoot }: Fixture) {
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", workspace, ...args])).stdout.trim();
  expect(await git("branch", "--show-current")).toBe("main");
  expect(await git("rev-parse", "HEAD")).toBe(originalHead);
  expect(await git("status", "--porcelain")).toBe("");
  await expect(git("show-ref", "--verify", "refs/heads/feat/run-order")).rejects.toThrow();
  expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("before\n");
  await expect(readFile(path.join(stagingRoot, "workspace", "README.md"))).rejects.toThrow();
}
