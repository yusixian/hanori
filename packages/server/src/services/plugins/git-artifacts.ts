import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parsePluginManifest, type PluginManifest } from "@cos-tool-bot/shared";

const MANIFEST = "hanori.plugin.json";
const IDENTITY = ".hanori-artifact.json";
const MAX_OUTPUT_BYTES = 65_536;
const MAX_FILES = 512;
const MAX_CHECKOUT_BYTES = 32 * 1024 * 1024;
const MAX_STAGING_BYTES = 64 * 1024 * 1024;
const DEADLINE_MS = 90_000;
const COMMIT = /^[a-f0-9]{40}$(?![\s\S])/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$(?![\s\S])/;
const RESERVED_IDS = new Set(["hanori.bilibili", "hanori.netease"]);

type ArtifactErrorCode =
  | "invalid_source"
  | "invalid_artifact"
  | "artifact_not_found"
  | "artifact_conflict"
  | "git_failed"
  | "limit_exceeded"
  | "cancelled"
  | "timeout"
  | "storage_failed";

/** Codes and messages never include child output, supplied URLs, or filesystem paths. */
export class GitPluginArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode) {
    super(`Plugin artifact: ${code}`);
    this.name = "GitPluginArtifactError";
  }
}

function fail(code: ArtifactErrorCode): never {
  throw new GitPluginArtifactError(code);
}

function canonicalRepository(repository: string): string {
  // Match the original string, rather than accepting URL normalization of credentials or traversal.
  const match =
    /^https:\/\/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})$/.exec(
      repository,
    );
  if (!match || match[0] !== repository) fail("invalid_source");
  const name = match[2]!.replace(/\.git$/i, "");
  if (!name || name === "." || name === ".." || /\.git$/i.test(name)) fail("invalid_source");
  return `https://github.com/${match[1]!.toLowerCase()}/${name.toLowerCase()}`;
}

function validId(id: string): boolean {
  return id.length <= 100 && PLUGIN_ID.test(id) && !RESERVED_IDS.has(id);
}

function checkCancelled(signal?: AbortSignal, deadline?: number): void {
  if (signal?.aborted) fail("cancelled");
  if (deadline !== undefined && Date.now() >= deadline) fail("timeout");
}

function errorCode(error: unknown): GitPluginArtifactError {
  return error instanceof GitPluginArtifactError
    ? error
    : new GitPluginArtifactError("storage_failed");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Walk each ancestor so mkdir/read never knowingly follows an existing directory symlink. */
async function safeDirectory(path: string, create: boolean): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await safeDirectory(parent, create);
  if (create && !(await exists(path))) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid_artifact");
}

/** Includes git objects while staging. Published artifacts are checked without any git metadata. */
async function inspectTree(directory: string, staging: boolean): Promise<void> {
  let bytes = 0;
  let files = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        !staging &&
        (entry.name.toLowerCase() === ".git" || entry.name.toLowerCase() === ".gitmodules")
      )
        fail("invalid_artifact");
      const child = join(path, entry.name);
      const stat = await lstat(child).catch((error: unknown) => {
        // Git renames/removes transient pack and lock files while the monitor walks them.
        if (staging && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) fail("invalid_artifact");
      files++;
      if (files > (staging ? MAX_FILES * 4 : MAX_FILES)) fail("limit_exceeded");
      if (stat.isDirectory()) {
        await visit(child).catch((error: unknown) => {
          if (staging && (error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        });
      } else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size;
        if (bytes > (staging ? MAX_STAGING_BYTES : MAX_CHECKOUT_BYTES)) fail("limit_exceeded");
      } else fail("invalid_artifact");
    }
  };
  await visit(directory);
}

async function readBoundedJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_OUTPUT_BYTES) fail("invalid_artifact");
  const data = await readFile(path);
  if (data.length > MAX_OUTPUT_BYTES) fail("invalid_artifact");
  try {
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    fail("invalid_artifact");
  }
}

async function artifactManifest(directory: string): Promise<PluginManifest> {
  await safeDirectory(directory, false);
  await inspectTree(directory, false);
  const entry = await lstat(join(directory, "index.mjs"));
  if (!entry.isFile() || entry.nlink !== 1 || entry.size === 0) fail("invalid_artifact");
  try {
    const manifest = parsePluginManifest(await readBoundedJson(join(directory, MANIFEST)));
    if (!validId(manifest.id)) fail("invalid_artifact");
    return manifest;
  } catch (error) {
    if (error instanceof GitPluginArtifactError) throw error;
    fail("invalid_artifact");
  }
}

async function readIdentity(directory: string): Promise<{ repository: string; commit: string }> {
  const input = await readBoundedJson(join(directory, IDENTITY));
  if (!input || typeof input !== "object") fail("invalid_artifact");
  const value = input as Record<string, unknown>;
  if (
    typeof value.repository !== "string" ||
    typeof value.commit !== "string" ||
    !COMMIT.test(value.commit)
  )
    fail("invalid_artifact");
  try {
    if (canonicalRepository(value.repository) !== value.repository) fail("invalid_artifact");
  } catch {
    fail("invalid_artifact");
  }
  return { repository: value.repository, commit: value.commit };
}

const GIT_OPTIONS = [
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "init.templateDir=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
  "-c",
  "http.maxRequests=1",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.fsckObjects=true",
  "-c",
  "core.fsmonitor=false",
];

async function runGit(
  directory: string,
  args: string[],
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  checkCancelled(signal, deadline);
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn("git", [...GIT_OPTIONS, ...args], {
      cwd: directory,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // Do not forward owner credentials, proxy settings, Git config, or shell environment.
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
        GIT_ALLOW_PROTOCOL: "https",
        GIT_LFS_SKIP_SMUDGE: "1",
        LC_ALL: "C",
      },
    });
    let failure: GitPluginArtifactError | undefined;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let checkingDisk = false;
    let closed = false;
    const kill = (code: ArtifactErrorCode) => {
      if (closed) return;
      failure ??= new GitPluginArtifactError(code);
      // Kill remote helpers as well as git; wait for close before cleaning the temporary directory.
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => kill("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => kill("timeout"), Math.max(1, deadline - Date.now()));
    const monitor = setInterval(() => {
      if (checkingDisk || failure) return;
      checkingDisk = true;
      void inspectTree(directory, true)
        .catch((error: unknown) => kill(errorCode(error).code))
        .finally(() => {
          checkingDisk = false;
        });
    }, 100);
    const collect = (chunk: Buffer, isStdout: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) kill("limit_exceeded");
      else if (isStdout) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => {
      failure ??= new GitPluginArtifactError("git_failed");
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      clearInterval(monitor);
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitPluginArtifactError("git_failed"));
      else resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function validateGitTree(tree: string): void {
  let bytes = 0;
  const entries = tree.split("\0").filter(Boolean);
  if (!entries.length || entries.length > MAX_FILES - 1) fail("limit_exceeded");
  const files = new Set<string>();
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\s+(\d+)\t(.+)$/.exec(entry);
    if (!match) fail("invalid_artifact"); // Reject symlink and submodule modes before checkout.
    const path = match[3]!;
    const components = path.split("/");
    if (
      path.includes("\\") ||
      components.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          [".git", ".gitmodules", IDENTITY].includes(part.toLowerCase()),
      )
    )
      fail("invalid_artifact");
    bytes += Number(match[2]);
    if (bytes > MAX_CHECKOUT_BYTES - MAX_OUTPUT_BYTES) fail("limit_exceeded");
    if (path === MANIFEST && Number(match[2]) > MAX_OUTPUT_BYTES) fail("invalid_artifact");
    files.add(path);
  }
  if (!files.has(MANIFEST) || !files.has("index.mjs")) fail("invalid_artifact");
}

export class GitPluginArtifacts {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async stage(
    source: { repository: string; commit: string },
    signal?: AbortSignal,
  ): Promise<{ repository: string; commit: string; manifest: PluginManifest; directory: string }> {
    const repository = canonicalRepository(source.repository);
    if (!COMMIT.test(source.commit)) fail("invalid_source");
    checkCancelled(signal);
    const deadline = Date.now() + DEADLINE_MS;
    let temporary: string | undefined;
    try {
      await safeDirectory(this.rootDirectory, true);
      temporary = await mkdtemp(join(this.rootDirectory, ".stage-"));
      await runGit(temporary, ["init", "--quiet"], deadline, signal);
      await runGit(
        temporary,
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          repository,
          source.commit,
        ],
        deadline,
        signal,
      );
      const fetched = (
        await runGit(temporary, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], deadline, signal)
      ).trim();
      if (fetched !== source.commit) fail("invalid_artifact");
      validateGitTree(
        await runGit(temporary, ["ls-tree", "-r", "-l", "-z", source.commit], deadline, signal),
      );
      await inspectTree(temporary, true);
      await runGit(
        temporary,
        ["checkout", "--quiet", "--detach", "--no-recurse-submodules", source.commit, "--"],
        deadline,
        signal,
      );
      const checkedOut = (
        await runGit(temporary, ["rev-parse", "--verify", "HEAD"], deadline, signal)
      ).trim();
      if (checkedOut !== source.commit) fail("invalid_artifact");
      await inspectTree(temporary, true);
      await rm(join(temporary, ".git"), { recursive: true, force: true });
      const manifest = await artifactManifest(temporary);
      await writeFile(
        join(temporary, IDENTITY),
        JSON.stringify({ repository, commit: source.commit }),
        { flag: "wx", mode: 0o600 },
      );
      await inspectTree(temporary, false);
      checkCancelled(signal, deadline);
      const parent = join(this.rootDirectory, manifest.id);
      await safeDirectory(parent, true);
      const directory = join(parent, source.commit);
      const reuseExisting = async () => {
        const existing = await this.locate(manifest.id, source.commit);
        const identity = await readIdentity(existing.directory);
        if (
          identity.repository !== repository ||
          JSON.stringify(existing.manifest) !== JSON.stringify(manifest)
        )
          fail("artifact_conflict");
        return { repository, commit: source.commit, ...existing };
      };
      checkCancelled(signal, deadline);
      if (await exists(directory)) return await reuseExisting();
      try {
        await rename(temporary, directory);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          return await reuseExisting();
        throw error;
      }
      temporary = undefined;
      return { repository, commit: source.commit, manifest, directory };
    } catch (error) {
      throw errorCode(error);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async locate(
    pluginId: string,
    commit: string,
  ): Promise<{ manifest: PluginManifest; directory: string }> {
    if (!validId(pluginId) || !COMMIT.test(commit)) fail("invalid_source");
    const directory = join(this.rootDirectory, pluginId, commit);
    // Defense in depth if a future change weakens plugin-ID validation.
    if (!directory.startsWith(`${this.rootDirectory}${sep}`)) fail("invalid_source");
    try {
      const manifest = await artifactManifest(directory);
      const identity = await readIdentity(directory);
      if (manifest.id !== pluginId || identity.commit !== commit) fail("invalid_artifact");
      return { manifest, directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("artifact_not_found");
      throw errorCode(error);
    }
  }
}
