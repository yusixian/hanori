import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
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
import { createHash } from "node:crypto";
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

export type RecoverySnapshotEntry =
  | { path: string; type: "deleted" }
  | { path: string; type: "file"; mode: number; size: number; digest: string }
  | { path: string; type: "symlink"; mode: number; target: string };

export interface RecoverySnapshot {
  branch: string;
  headSha: string;
  clean: boolean;
  changedPaths: string[];
  fingerprint: string;
  entries: RecoverySnapshotEntry[];
  untrackedPaths: string[];
}

const DEFAULT_LIMITS: FileTreeLimits = {
  maxFiles: 100_000,
  maxBytes: 1024 * 1024 * 1024,
};
const MAX_GIT_MANIFEST_BYTES = 64 * 1024 * 1024;

export const PROTECTED_LOCAL_GIT_EXCLUDES = [
  "/.env",
  "/.cos-pi-cache",
  "/.cos-pi-cache/**",
] as const;

export function isProtectedLocalPath(relative: string): boolean {
  return (
    relative === ".env" || relative === ".cos-pi-cache" || relative.startsWith(".cos-pi-cache/")
  );
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function validateManifestPath(relative: string): void {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\0") ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe Git manifest path: ${JSON.stringify(relative)}`);
  }
}

function splitNullRecords(output: Buffer): string[] {
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue;
    const raw = output.subarray(start, index);
    const decoded = raw.toString("utf8");
    if (!Buffer.from(decoded).equals(raw)) throw new Error("Non-UTF-8 Git paths are not supported");
    if (decoded) records.push(decoded);
    start = index + 1;
  }
  if (start !== output.length) throw new Error("Git manifest was not NUL terminated");
  return records;
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
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

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: os.tmpdir(),
    PATH: process.env["PATH"],
    LANG: process.env["LANG"],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function runGitRaw(
  sourceWorkspace: string,
  args: string[],
  owner?: { uid: number; gid: number },
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "-C",
        sourceWorkspace,
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        env: gitEnvironment(),
        encoding: "buffer",
        maxBuffer: MAX_GIT_MANIFEST_BYTES,
        signal,
        ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error) {
          reject(new Error((stderr.toString("utf8") || error.message).trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function assertNoSymlinkParents(root: string, relative: string): Promise<void> {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Unsafe parent in coding workspace: ${relative}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

async function captureFileEntry(
  root: string,
  relative: string,
  initial: BigIntStats,
  signal?: AbortSignal,
): Promise<RecoverySnapshotEntry> {
  const absolute = path.join(root, relative);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStat(initial, before)) {
      throw new Error(`File changed while inspecting recovery snapshot: ${relative}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after)) {
      throw new Error(`File changed while inspecting recovery snapshot: ${relative}`);
    }
    return {
      path: relative,
      type: "file",
      mode: Number(before.mode & 0o777n),
      size: Number(before.size),
      digest: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function updateFingerprintField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(String(bytes.length));
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
}

function changedPathsFromStatus(status: Buffer): string[] {
  const records = splitNullRecords(status);
  const changed = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status record");
    const state = record.slice(0, 2);
    const relative = record.slice(3);
    validateManifestPath(relative);
    changed.add(relative);
    if (state.includes("R") || state.includes("C")) {
      const original = records[++index];
      if (!original) throw new Error("Invalid Git rename status record");
      validateManifestPath(original);
      changed.add(original);
    }
  }
  return [...changed].sort();
}

function withoutProtectedUntrackedStatus(status: Buffer): Buffer {
  const records = splitNullRecords(status);
  const retained: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status record");
    const state = record.slice(0, 2);
    const relative = record.slice(3);
    validateManifestPath(relative);
    const original = state.includes("R") || state.includes("C") ? records[++index] : undefined;
    if ((state.includes("R") || state.includes("C")) && !original) {
      throw new Error("Invalid Git rename status record");
    }
    if (original) validateManifestPath(original);
    if (state === "??" && isProtectedLocalPath(relative)) continue;
    retained.push(record);
    if (original) retained.push(original);
  }
  return retained.length ? Buffer.from(`${retained.join("\0")}\0`) : Buffer.alloc(0);
}

function assertNoGitlinks(index: Buffer): void {
  for (const record of splitNullRecords(index)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Invalid Git index manifest record");
    const metadata = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    validateManifestPath(relative);
    if (metadata[0] === "160000") {
      throw new Error(`Git submodules are not supported in recovery snapshots: ${relative}`);
    }
  }
}

async function captureRecoverySnapshot(
  sourceWorkspace: string,
  branch: string,
  headSha: string,
  limits: FileTreeLimits,
  owner?: { uid: number; gid: number },
  signal?: AbortSignal,
): Promise<RecoverySnapshot> {
  signal?.throwIfAborted();
  const sourceRoot = await realpath(sourceWorkspace);
  const [trackedRaw, untrackedRaw, indexRaw, unfilteredStatusRaw] = await Promise.all([
    runGitRaw(sourceRoot, ["ls-files", "-z", "--cached"], owner, signal),
    runGitRaw(
      sourceRoot,
      [
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        ...PROTECTED_LOCAL_GIT_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
      ],
      owner,
      signal,
    ),
    runGitRaw(sourceRoot, ["ls-files", "-z", "--stage"], owner, signal),
    runGitRaw(
      sourceRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      owner,
      signal,
    ),
  ]);
  const trackedPaths = new Set(splitNullRecords(trackedRaw));
  for (const relative of trackedPaths) {
    if (isProtectedLocalPath(relative)) {
      throw new Error(`Tracked protected local path cannot be recovered: ${relative}`);
    }
  }
  const untrackedPaths = new Set(
    splitNullRecords(untrackedRaw).filter((relative) => !isProtectedLocalPath(relative)),
  );
  const statusRaw = withoutProtectedUntrackedStatus(unfilteredStatusRaw);
  assertNoGitlinks(indexRaw);
  for (const relative of trackedPaths) {
    if (untrackedPaths.has(relative)) throw new Error("Git returned a duplicate recovery path");
  }
  const paths = [
    ...[...trackedPaths].map((relative) => ({ relative, tracked: true })),
    ...[...untrackedPaths].map((relative) => ({ relative, tracked: false })),
  ].sort((left, right) => left.relative.localeCompare(right.relative));
  if (paths.length > limits.maxFiles) {
    throw new Error("Coding workspace exceeds the file-count limit");
  }
  const entries: RecoverySnapshotEntry[] = [];
  let bytes = 0;
  for (const { relative, tracked } of paths) {
    signal?.throwIfAborted();
    validateManifestPath(relative);
    await assertNoSymlinkParents(sourceRoot, relative);
    const absolute = path.join(sourceRoot, relative);
    let info: BigIntStats;
    try {
      info = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        if (tracked) {
          entries.push({ path: relative, type: "deleted" });
          continue;
        }
        throw new Error(`Untracked file changed while inspecting recovery snapshot: ${relative}`);
      }
      throw error;
    }
    if (info.isFile()) {
      const entry = await captureFileEntry(sourceRoot, relative, info, signal);
      bytes += entry.type === "file" ? entry.size : 0;
      if (bytes > limits.maxBytes) throw new Error("Coding workspace exceeds the byte limit");
      entries.push(entry);
      continue;
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const after = await lstat(absolute, { bigint: true });
      if (!sameStat(info, after)) {
        throw new Error(`Symlink changed while inspecting recovery snapshot: ${relative}`);
      }
      if (
        path.isAbsolute(target) ||
        !isWithin(sourceRoot, path.resolve(path.dirname(absolute), target))
      ) {
        throw new Error(`Unsafe symlink in coding workspace: ${relative}`);
      }
      bytes += Buffer.byteLength(target);
      if (bytes > limits.maxBytes) throw new Error("Coding workspace exceeds the byte limit");
      entries.push({
        path: relative,
        type: "symlink",
        mode: Number(info.mode & 0o777n),
        target,
      });
      continue;
    }
    if (tracked) {
      entries.push({ path: relative, type: "deleted" });
      continue;
    }
    throw new Error(`Special file is not allowed in coding workspace: ${relative}`);
  }

  const fingerprint = createHash("sha256");
  updateFingerprintField(fingerprint, "cos-tool-bot/recovery-snapshot/v3");
  updateFingerprintField(fingerprint, branch);
  updateFingerprintField(fingerprint, headSha);
  updateFingerprintField(fingerprint, indexRaw);
  updateFingerprintField(fingerprint, statusRaw);
  for (const entry of entries) {
    updateFingerprintField(fingerprint, entry.path);
    updateFingerprintField(fingerprint, entry.type);
    if (entry.type === "file") {
      updateFingerprintField(fingerprint, String(entry.mode));
      updateFingerprintField(fingerprint, String(entry.size));
      updateFingerprintField(fingerprint, entry.digest);
    } else if (entry.type === "symlink") {
      updateFingerprintField(fingerprint, String(entry.mode));
      updateFingerprintField(fingerprint, entry.target);
    }
  }
  return {
    branch,
    headSha,
    clean: statusRaw.length === 0,
    changedPaths: changedPathsFromStatus(statusRaw),
    fingerprint: fingerprint.digest("hex"),
    entries,
    untrackedPaths: [...untrackedPaths].sort(),
  };
}

async function validateTree(
  root: string,
  limits: FileTreeLimits,
  phase: "workspace" | "result",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const label = phase === "workspace" ? "Coding workspace" : "Coding result";
  let files = 0;
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await opendir(path.join(root, relative));
    for await (const entry of entries) {
      signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const environment: NodeJS.ProcessEnv = {
    HOME: os.tmpdir(),
    PATH: process.env["PATH"],
    LANG: process.env["LANG"],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  try {
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
        signal,
        ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

async function ensureDestinationParent(
  root: string,
  relative: string,
  owner?: { uid: number; gid: number },
): Promise<void> {
  let current = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Unsafe recovery staging parent: ${relative}`);
    }
    if (owner) await chown(current, owner.uid, owner.gid);
  }
}

async function copyRecoveryEntry(
  sourceRoot: string,
  destinationRoot: string,
  entry: Exclude<RecoverySnapshotEntry, { type: "deleted" }>,
  owner?: { uid: number; gid: number },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertNoSymlinkParents(sourceRoot, entry.path);
  await ensureDestinationParent(destinationRoot, entry.path, owner);
  const source = path.join(sourceRoot, entry.path);
  const destination = path.join(destinationRoot, entry.path);
  if (entry.type === "symlink") {
    const before = await lstat(source, { bigint: true });
    if (!before.isSymbolicLink() || Number(before.mode & 0o777n) !== entry.mode) {
      throw new Error(`Symlink changed before recovery staging: ${entry.path}`);
    }
    const target = await readlink(source);
    const after = await lstat(source, { bigint: true });
    if (target !== entry.target || !sameStat(before, after)) {
      throw new Error(`Symlink changed before recovery staging: ${entry.path}`);
    }
    await symlink(target, destination);
    if (owner) await lchown(destination, owner.uid, owner.gid);
    return;
  }

  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      entry.mode,
    );
    try {
      const before = await sourceHandle.stat({ bigint: true });
      if (
        !before.isFile() ||
        Number(before.mode & 0o777n) !== entry.mode ||
        Number(before.size) !== entry.size
      ) {
        throw new Error(`File changed before recovery staging: ${entry.path}`);
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(buffer, written, bytesRead - written);
          if (!result.bytesWritten) throw new Error(`Could not stage recovery file: ${entry.path}`);
          written += result.bytesWritten;
        }
      }
      const after = await sourceHandle.stat({ bigint: true });
      if (!sameStat(before, after) || digest.digest("hex") !== entry.digest) {
        throw new Error(`File changed while staging recovery snapshot: ${entry.path}`);
      }
      await destinationHandle.chmod(entry.mode);
      if (owner) await destinationHandle.chown(owner.uid, owner.gid);
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await sourceHandle.close();
  }
}

async function clearDirectory(root: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const entries = await opendir(root);
  for await (const entry of entries) {
    signal?.throwIfAborted();
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

  captureRecoverySnapshot(
    sourceWorkspace: string,
    branch: string,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<RecoverySnapshot> {
    return captureRecoverySnapshot(
      sourceWorkspace,
      branch,
      headSha,
      this.limits,
      this.owner,
      signal,
    );
  }

  async stage(sourceWorkspace: string, signal?: AbortSignal): Promise<StagedWorkspace> {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    signal?.throwIfAborted();
    const rootIdentity = await captureDirectoryIdentity(this.root);
    const workspace = path.join(rootIdentity.path, this.workspaceName);
    try {
      await clearDirectory(rootIdentity.path, signal);
      signal?.throwIfAborted();
      await mkdir(workspace, { mode: 0o700 });
      if (this.owner) await chown(workspace, this.owner.uid, this.owner.gid);
      signal?.throwIfAborted();
      await checkoutTrackedTree(path.resolve(sourceWorkspace), workspace, this.owner, signal);
      await validateTree(workspace, this.limits, "workspace", signal);
      signal?.throwIfAborted();
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

  async stageRecoverySnapshot(
    sourceWorkspace: string,
    snapshot: RecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<StagedWorkspace> {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    const rootIdentity = await captureDirectoryIdentity(this.root);
    const workspace = path.join(rootIdentity.path, this.workspaceName);
    try {
      await clearDirectory(rootIdentity.path, signal);
      await mkdir(workspace, { mode: 0o700 });
      if (this.owner) await chown(workspace, this.owner.uid, this.owner.gid);
      const sourceRoot = await realpath(sourceWorkspace);
      for (const entry of snapshot.entries) {
        signal?.throwIfAborted();
        if (entry.type !== "deleted") {
          await copyRecoveryEntry(sourceRoot, workspace, entry, this.owner, signal);
        }
      }
      await validateTree(workspace, this.limits, "workspace", signal);
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

  async validateResult(staged: StagedWorkspace, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await assertDirectoryIdentity(staged.rootIdentity);
    signal?.throwIfAborted();
    await assertDirectoryIdentity(staged.identity);
    const rootEntries = await opendir(staged.rootIdentity.path);
    for await (const entry of rootEntries) {
      signal?.throwIfAborted();
      if (entry.name !== this.workspaceName) {
        throw new Error(`Unexpected entry outside coding workspace: ${entry.name}`);
      }
    }
    await validateTree(staged.path, this.limits, "result", signal);
  }

  async cleanup(): Promise<void> {
    const rootIdentity = await captureDirectoryIdentity(this.root);
    await clearDirectory(rootIdentity.path);
  }
}
