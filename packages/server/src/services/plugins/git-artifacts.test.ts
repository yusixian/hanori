import { truncate, readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { mkdtemp, writeFile, mkdir, readdir, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: mocks.spawn, realSpawn: original.spawn };
});
import { GitPluginArtifacts } from "./git-artifacts.js";

const COMMIT = "a".repeat(40);
const REPOSITORY = "https://github.com/Example/Plugin.git";
const manifest = {
  apiVersion: 1,
  id: "example.plugin",
  name: "Example",
  version: "1.0.0",
  description: "An example plugin",
  author: "Example",
  config: [],
};
const tree =
  [`100644 blob ${COMMIT} 200\thanori.plugin.json`, `100644 blob ${COMMIT} 100\tindex.mjs`].join(
    "\0",
  ) + "\0";

let root: string;
let installer: GitPluginArtifacts;
let artifactManifest = manifest;
let treeOutput = tree;
let fetchedCommit = COMMIT;
let headCommit = COMMIT;
let stalledCommand: string | undefined;
let failedCommand: string | undefined;
let oversizedCommand: string | undefined;
let lastChild: EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function command(args: string[]): string {
  return args.find((arg) => ["init", "fetch", "rev-parse", "ls-tree", "checkout"].includes(arg))!;
}

beforeEach(async () => {
  root = await mkdtemp("/private/tmp/hanori-artifact-test-");
  installer = new GitPluginArtifacts(join(root, "artifacts"));
  artifactManifest = manifest;
  treeOutput = tree;
  fetchedCommit = headCommit = COMMIT;
  stalledCommand = failedCommand = oversizedCommand = undefined;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((_binary: string, args: string[], options: { cwd: string }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      }),
    });
    lastChild = child;
    const operation = command(args);
    if (operation !== stalledCommand) {
      void Promise.resolve()
        .then(async () => {
          if (operation === failedCommand) {
            child.stderr.write("Authorization: secret-owner-token");
            child.emit("close", 128);
            return;
          }
          if (operation === oversizedCommand) child.stdout.write(Buffer.alloc(65_537));
          else if (operation === "init") await mkdir(join(options.cwd, ".git"));
          else if (operation === "rev-parse")
            child.stdout.write(args.at(-1) === "HEAD" ? headCommit : fetchedCommit);
          else if (operation === "ls-tree") child.stdout.write(treeOutput);
          else if (operation === "checkout") {
            await writeFile(
              join(options.cwd, "hanori.plugin.json"),
              JSON.stringify(artifactManifest),
            );
            // Any accidental import of the entry fails the test and would create an observable marker.
            await writeFile(
              join(options.cwd, "index.mjs"),
              "throw new Error('installer executed plugin');",
            );
            await writeFile(
              join(options.cwd, "package.json"),
              JSON.stringify({ scripts: { postinstall: "exit 1", build: "exit 1" } }),
            );
          }
          child.emit("close", 0);
        })
        .catch((error: unknown) => child.emit("error", error));
    }
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function stage() {
  return installer.stage({ repository: REPOSITORY, commit: COMMIT });
}

async function stagedDirectories() {
  return (await readdir(join(root, "artifacts"))).filter((name) => name.startsWith(".stage-"));
}

describe("GitPluginArtifacts", () => {
  it.each([
    "https://user:token@github.com/example/plugin",
    "http://github.com/example/plugin",
    "https://github.com:443/example/plugin",
    "https://github.com/example/plugin?secret=token",
    "https://github.com/example/plugin#main",
    "https://github.com/example/plugin/",
    "https://github.com/example/../plugin",
    "https://github.com/example/%70lugin",
    "https://github.com/example/plugin\n",
    "https://github.com/example/plugin.git.git",
    "https://github.com/example/-plugin",
    "https://github.com/example/plugin --upload-pack=evil",
    "git@github.com:example/plugin",
    "file:///tmp/plugin",
  ])("rejects unsupported or ambiguous repository %s before spawning", async (repository) => {
    await expect(installer.stage({ repository, commit: COMMIT })).rejects.toMatchObject({
      code: "invalid_source",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["main", "a".repeat(39), "a".repeat(41), "A".repeat(40), COMMIT + "\n", "--help"])(
    "rejects non-exact commit %s",
    async (commit) => {
      await expect(installer.stage({ repository: REPOSITORY, commit })).rejects.toMatchObject({
        code: "invalid_source",
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("publishes the exact checkout atomically, strips git, and never runs build or plugin scripts", async () => {
    const result = await stage();
    expect(result).toEqual({
      repository: "https://github.com/example/plugin",
      commit: COMMIT,
      manifest,
      directory: join(root, "artifacts", manifest.id, COMMIT),
    });
    expect(await installer.locate(manifest.id, COMMIT)).toEqual({
      manifest,
      directory: result.directory,
    });
    expect(await readdir(result.directory)).not.toContain(".git");
    expect(await stagedDirectories()).toEqual([]);
    expect(mocks.spawn.mock.calls.map((call) => command(call[1]))).toEqual([
      "init",
      "fetch",
      "rev-parse",
      "ls-tree",
      "checkout",
      "rev-parse",
    ]);
    for (const [binary, args, options] of mocks.spawn.mock.calls) {
      expect(binary).toBe("git");
      expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
      expect(options.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "https",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(options.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(args).toContain("core.hooksPath=/dev/null");
      expect(args).toContain("credential.helper=");
      expect(args).toContain("init.templateDir=");
      expect(args).toContain("protocol.allow=never");
    }
    expect(mocks.spawn.mock.calls.find((call) => command(call[1]) === "fetch")?.[1]).toEqual(
      expect.arrayContaining([
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "https://github.com/example/plugin",
        COMMIT,
      ]),
    );
  });

  it("normalizes an uppercase optional Git suffix to a stable canonical origin", async () => {
    const result = await installer.stage({
      repository: "https://github.com/EXAMPLE/PLUGIN.GIT",
      commit: COMMIT,
    });
    expect(result.repository).toBe("https://github.com/example/plugin");
    expect((await installer.locate(manifest.id, COMMIT)).directory).toBe(result.directory);
  });

  it("reuses a valid identical artifact and rejects conflicting manifests and origins", async () => {
    const first = await stage();
    expect((await stage()).directory).toBe(first.directory);
    artifactManifest = { ...manifest, version: "1.0.1" };
    await expect(stage()).rejects.toMatchObject({ code: "artifact_conflict" });
    artifactManifest = manifest;
    await expect(
      installer.stage({ repository: "https://github.com/other/plugin", commit: COMMIT }),
    ).rejects.toMatchObject({ code: "artifact_conflict" });
    expect(await stagedDirectories()).toEqual([]);
  });

  it.each(["hanori.bilibili", "hanori.netease"])("rejects reserved builtin ID %s", async (id) => {
    artifactManifest = { ...manifest, id };
    await expect(stage()).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(await stagedDirectories()).toEqual([]);
  });

  it.each(["fetch", "checkout"])(
    "cleans partial stage and redacts failed %s stderr",
    async (operation) => {
      failedCommand = operation;
      await expect(stage()).rejects.toMatchObject({
        code: "git_failed",
        message: "Plugin artifact: git_failed",
      });
      expect(await stagedDirectories()).toEqual([]);
    },
  );

  it.each(["fetch", "checkout"])("rejects a mismatched %s commit", async (operation) => {
    if (operation === "fetch") fetchedCommit = "b".repeat(40);
    else headCommit = "b".repeat(40);
    await expect(stage()).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(await stagedDirectories()).toEqual([]);
    if (operation === "fetch")
      expect(mocks.spawn.mock.calls.some((call) => command(call[1]) === "checkout")).toBe(false);
  });

  it.each([
    `120000 blob ${COMMIT} 10\tindex.mjs\0`,
    `160000 commit ${COMMIT} -\tsubmodule\0`,
    `100644 blob ${COMMIT} 10\t.gitmodules\0`,
    `100644 blob ${COMMIT} 10\ta/../evil\0`,
    `100644 blob ${COMMIT} 10\ta/../../evil\0`,
    `100644 blob ${COMMIT} 10\t.GIT/config\0`,
    `100644 blob ${COMMIT} 10\t.hanori-artifact.json\0`,
    `100644 blob ${COMMIT} 10\t/absolute\0`,
    `100644 blob ${COMMIT} 33554433\tlarge.bin\0`,
  ])("rejects dangerous or oversized git tree before checkout", async (entry) => {
    treeOutput = tree + entry;
    await expect(stage()).rejects.toBeInstanceOf(Error);
    expect(mocks.spawn.mock.calls.some((call) => command(call[1]) === "checkout")).toBe(false);
    expect(await stagedDirectories()).toEqual([]);
  });

  it("caps subprocess output and removes staging data", async () => {
    oversizedCommand = "fetch";
    await expect(stage()).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(lastChild.kill).toHaveBeenCalled();
    expect(await stagedDirectories()).toEqual([]);
  });

  it("cancels before starting without touching storage", async () => {
    await expect(
      installer.stage({ repository: REPOSITORY, commit: COMMIT }, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("kills a stalled fetch on abort and cleans its partial directory", async () => {
    stalledCommand = "fetch";
    const controller = new AbortController();
    const pending = installer.stage({ repository: REPOSITORY, commit: COMMIT }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() =>
      expect(mocks.spawn.mock.calls.some((call) => command(call[1]) === "fetch")).toBe(true),
    );
    controller.abort();
    await assertion;
    expect(lastChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await stagedDirectories()).toEqual([]);
  });

  it("uses a bounded shared deadline and kills a timed-out fetch", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    stalledCommand = "fetch";
    const pending = stage();
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(command(mocks.spawn.mock.calls.at(-1)![1])).toBe("fetch"));
    const deadlineTimers = timers.mock.calls.filter(
      ([, milliseconds]) => Number(milliseconds) > 80_000,
    );
    expect(deadlineTimers).toHaveLength(2);
    expect(deadlineTimers[1]![1]).toBeLessThanOrEqual(deadlineTimers[0]![1]!);
    expect(deadlineTimers[0]![1]).toBeLessThanOrEqual(90_000);
    const expireFetch = deadlineTimers[1]![0] as () => void;
    expireFetch();
    await assertion;
    expect(lastChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await stagedDirectories()).toEqual([]);
    timers.mockRestore();
  });

  it("rejects an empty or missing ESM entry without executing anything", async () => {
    const result = await stage();
    await writeFile(join(result.directory, "index.mjs"), "");
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    treeOutput = tree.split("\0")[0]! + "\0";
    await expect(installer.stage({ repository: REPOSITORY, commit: COMMIT })).rejects.toMatchObject(
      { code: "invalid_artifact" },
    );
  });

  it("rejects staging disk usage above its bound while fetch is running", async () => {
    stalledCommand = "fetch";
    const pending = stage();
    const assertion = expect(pending).rejects.toMatchObject({ code: "limit_exceeded" });
    await vi.waitFor(() => expect(command(mocks.spawn.mock.calls.at(-1)![1])).toBe("fetch"));
    const directory = mocks.spawn.mock.calls.at(-1)![2].cwd;
    const oversized = join(directory, "oversized-pack");
    await writeFile(oversized, "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await assertion;
    expect(lastChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await stagedDirectories()).toEqual([]);
  });

  it("executes the git checkout protocol against an offline temporary fixture repository", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = join(root, "source");
    await mkdir(fixture);
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        actual.execFile(
          "git",
          ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args],
          { cwd: fixture, env },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
    await git(["init", "--quiet"]);
    await writeFile(join(fixture, "hanori.plugin.json"), JSON.stringify(manifest));
    await writeFile(
      join(fixture, "index.mjs"),
      "throw new Error('never execute during installation');",
    );
    await git(["add", "--", "hanori.plugin.json", "index.mjs"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const commit = (await git(["rev-parse", "HEAD"])).trim();
    mocks.spawn.mockImplementation((binary, args: string[], options) => {
      if (command(args) === "fetch") {
        const adapted = ["-c", "protocol.file.allow=always", ...args];
        adapted[adapted.indexOf("https://github.com/example/plugin")] = fixture;
        return actual.spawn(binary, adapted, {
          ...options,
          env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" },
        });
      }
      return actual.spawn(binary, args, options);
    });
    const result = await installer.stage({ repository: REPOSITORY, commit });
    expect(result.commit).toBe(commit);
    expect(result.manifest).toEqual(manifest);
    expect(await readFile(join(result.directory, "index.mjs"), "utf8")).toContain("never execute");
    expect(await readdir(result.directory)).not.toContain(".git");
    expect((await installer.locate(manifest.id, commit)).directory).toBe(result.directory);
  });

  it("rejects unsafe or modified published artifacts on locate", async () => {
    const result = await stage();
    await writeFile(
      join(result.directory, "hanori.plugin.json"),
      JSON.stringify({ ...manifest, id: "other.plugin" }),
    );
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await writeFile(join(result.directory, "hanori.plugin.json"), JSON.stringify(manifest));
    await writeFile(
      join(result.directory, ".hanori-artifact.json"),
      JSON.stringify({ repository: "https://github.com/example/plugin", commit: "b".repeat(40) }),
    );
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await writeFile(
      join(result.directory, ".hanori-artifact.json"),
      JSON.stringify({ repository: "https://github.com/example/plugin", commit: COMMIT }),
    );
    await symlink("index.mjs", join(result.directory, "linked"));
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await rm(join(result.directory, "linked"));
    await link(join(result.directory, "index.mjs"), join(result.directory, "hardlinked"));
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
  });

  it("rejects oversized metadata and published submodule metadata", async () => {
    const result = await stage();
    await writeFile(join(result.directory, "hanori.plugin.json"), " ".repeat(65_537));
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await writeFile(join(result.directory, "hanori.plugin.json"), JSON.stringify(manifest));
    await writeFile(join(result.directory, ".gitmodules"), "");
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "invalid_artifact",
    });
  });

  it("refuses existing artifact-root and plugin-directory symlinks", async () => {
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "artifacts"));
    await expect(stage()).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    await rm(join(root, "artifacts"));
    await mkdir(join(root, "artifacts"));
    await symlink(join(root, "outside"), join(root, "artifacts", manifest.id));
    await expect(stage()).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });

  it("rejects locate traversal and missing artifacts", async () => {
    await expect(installer.locate("../escape", COMMIT)).rejects.toMatchObject({
      code: "invalid_source",
    });
    await expect(installer.locate(manifest.id, COMMIT)).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  });
});
