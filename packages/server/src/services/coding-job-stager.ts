import { constants } from "node:fs";
import {
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const globalStagingLock = new KeyedAsyncLock();
const GLOBAL_SLOT = "coding-job";

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

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  limits: FileTreeLimits,
  owner?: { uid: number; gid: number },
): Promise<void> {
  let files = 0;
  let bytes = 0;

  const visit = async (relative: string): Promise<void> => {
    const source = path.join(sourceRoot, relative);
    const entries = await opendir(source);
    for await (const entry of entries) {
      if (!relative && (entry.name === ".git" || entry.name === ".cos-pi-cache")) continue;
      files += 1;
      if (files > limits.maxFiles) throw new Error("Coding workspace exceeds the file-count limit");
      const childRelative = path.join(relative, entry.name);
      const sourceChild = path.join(sourceRoot, childRelative);
      const destinationChild = path.join(destinationRoot, childRelative);
      const info = await lstat(sourceChild);
      if (info.isDirectory()) {
        await mkdir(destinationChild, { mode: info.mode & 0o777 });
        if (owner) await chown(destinationChild, owner.uid, owner.gid);
        await visit(childRelative);
      } else if (info.isFile()) {
        const sourceHandle = await open(sourceChild, constants.O_RDONLY | constants.O_NOFOLLOW);
        const destinationHandle = await open(
          destinationChild,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          info.mode & 0o777,
        );
        const buffer = Buffer.allocUnsafe(64 * 1024);
        try {
          const verified = await sourceHandle.stat();
          if (!verified.isFile() || verified.dev !== info.dev || verified.ino !== info.ino) {
            throw new Error(`File changed while staging: ${childRelative}`);
          }
          while (true) {
            const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > limits.maxBytes) {
              throw new Error("Coding workspace exceeds the byte limit");
            }
            await destinationHandle.write(buffer, 0, bytesRead);
          }
        } finally {
          await Promise.all([sourceHandle.close(), destinationHandle.close()]);
        }
        if (owner) await chown(destinationChild, owner.uid, owner.gid);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(sourceChild);
        if (path.isAbsolute(target))
          throw new Error(`Absolute symlink is not allowed: ${childRelative}`);
        const resolvedTarget = path.resolve(path.dirname(sourceChild), target);
        if (!isWithin(sourceRoot, resolvedTarget)) {
          throw new Error(`Traversing symlink is not allowed: ${childRelative}`);
        }
        await symlink(target, destinationChild);
        if (owner) await lchown(destinationChild, owner.uid, owner.gid);
      } else {
        throw new Error(`Special file is not allowed in coding workspace: ${childRelative}`);
      }
    }
  };

  await visit("");
}

async function validateTree(root: string, limits: FileTreeLimits): Promise<void> {
  let files = 0;
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await opendir(path.join(root, relative));
    for await (const entry of entries) {
      files += 1;
      if (files > limits.maxFiles) throw new Error("Coding result exceeds the file-count limit");
      const childRelative = path.join(relative, entry.name);
      const child = path.join(root, childRelative);
      const info = await lstat(child);
      if (info.isDirectory()) await visit(childRelative);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > limits.maxBytes) throw new Error("Coding result exceeds the byte limit");
      } else if (info.isSymbolicLink()) {
        const target = await readlink(child);
        if (path.isAbsolute(target) || !isWithin(root, path.resolve(path.dirname(child), target))) {
          throw new Error(`Unsafe symlink in coding result: ${childRelative}`);
        }
      } else {
        throw new Error(`Special file in coding result: ${childRelative}`);
      }
    }
  };
  await visit("");
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
      await copyTree(path.resolve(sourceWorkspace), workspace, this.limits, this.owner);
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
    await validateTree(staged.path, this.limits);
  }

  async cleanup(): Promise<void> {
    const rootIdentity = await captureDirectoryIdentity(this.root);
    await clearDirectory(rootIdentity.path);
  }
}
