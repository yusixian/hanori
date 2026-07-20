import { execFile } from "node:child_process";
import { chown, lstat, mkdir, opendir, readlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const globalStagingLock = new KeyedAsyncLock();
const GLOBAL_SLOT = "coding-job";
const exec = promisify(execFile);

export interface FileTreeLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface PathIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface StagedWorkspace {
  path: string;
  identity: PathIdentity;
  rootIdentity: PathIdentity;
}

const DEFAULT_LIMITS: FileTreeLimits = {
  maxFiles: 100_000,
  maxBytes: 1024 * 1024 * 1024,
};

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function captureDirectoryIdentity(directory: string): Promise<PathIdentity> {
  const expected = path.resolve(directory);
  const info = await lstat(expected);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${expected}`);
  }
  const actual = await realpath(expected);
  return { path: actual, dev: info.dev, ino: info.ino };
}

export async function assertDirectoryIdentity(identity: PathIdentity): Promise<void> {
  const current = await captureDirectoryIdentity(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`Directory identity changed during coding job: ${identity.path}`);
  }
}

async function validateTree(
  root: string,
  limits: FileTreeLimits,
  phase: "workspace" | "result",
): Promise<void> {
  const label = phase === "workspace" ? "Coding workspace" : "Coding result";
  let files = 0;
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await opendir(path.join(root, relative));
    for await (const entry of entries) {
      files += 1;
      if (files > limits.maxFiles) throw new Error(`${label} exceeds the file-count limit`);
      const childRelative = path.join(relative, entry.name);
      const child = path.join(root, childRelative);
      const info = await lstat(child);
      if (info.isDirectory()) await visit(childRelative);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > limits.maxBytes) throw new Error(`${label} exceeds the byte limit`);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(child);
        if (path.isAbsolute(target) || !isWithin(root, path.resolve(path.dirname(child), target))) {
          throw new Error(`Unsafe symlink in coding ${phase}: ${childRelative}`);
        }
      } else {
        throw new Error(`Special file in coding ${phase}: ${childRelative}`);
      }
    }
  };
  await visit("");
}

async function checkoutTrackedTree(
  sourceWorkspace: string,
  destination: string,
  owner?: { uid: number; gid: number },
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    HOME: os.tmpdir(),
    PATH: process.env["PATH"],
    LANG: process.env["LANG"],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  await exec(
    "git",
    [
      "-C",
      sourceWorkspace,
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "checkout-index",
      "--all",
      "--force",
      `--prefix=${destination}${path.sep}`,
    ],
    {
      env: environment,
      ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
    },
  );
}

async function clearDirectory(root: string): Promise<void> {
  const entries = await opendir(root);
  for await (const entry of entries) {
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

export class CodingJobStager {
  readonly workspaceName = "workspace";
  private readonly limits: FileTreeLimits;

  constructor(
    private readonly root: string,
    limits: Partial<FileTreeLimits> = {},
    private readonly owner?: { uid: number; gid: number },
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return globalStagingLock.run(GLOBAL_SLOT, operation);
  }

  async stage(sourceWorkspace: string): Promise<StagedWorkspace> {
    await mkdir(this.root, { recursive: true });
    const rootIdentity = await captureDirectoryIdentity(this.root);
    const workspace = path.join(rootIdentity.path, this.workspaceName);
    await clearDirectory(rootIdentity.path);
    await mkdir(workspace, { mode: 0o700 });
    if (this.owner) await chown(workspace, this.owner.uid, this.owner.gid);
    try {
      await checkoutTrackedTree(path.resolve(sourceWorkspace), workspace, this.owner);
      await validateTree(workspace, this.limits, "workspace");
      return {
        path: workspace,
        identity: await captureDirectoryIdentity(workspace),
        rootIdentity,
      };
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async validateResult(staged: StagedWorkspace): Promise<void> {
    await assertDirectoryIdentity(staged.rootIdentity);
    await assertDirectoryIdentity(staged.identity);
    const rootEntries = await opendir(staged.rootIdentity.path);
    for await (const entry of rootEntries) {
      if (entry.name !== this.workspaceName) {
        throw new Error(`Unexpected entry outside coding workspace: ${entry.name}`);
      }
    }
    await validateTree(staged.path, this.limits, "result");
  }

  async cleanup(): Promise<void> {
    const rootIdentity = await captureDirectoryIdentity(this.root);
    await clearDirectory(rootIdentity.path);
  }
}
