import { execFile } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  CodingJobStager,
} from "./coding-job-stager.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-stager-test-"));
  tempDirs.push(root);
  const source = path.join(root, "canonical", "repo");
  const sibling = path.join(root, "canonical", "another-repo");
  const staging = path.join(root, "staging");
  await mkdir(source, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(staging);
  await writeFile(path.join(source, "README.md"), "source\n");
  await writeFile(path.join(sibling, "canary"), "must stay private\n");
  await exec("git", ["init", source]);
  await exec("git", ["-C", source, "add", "README.md"]);
  return { root, source, sibling, staging };
}

describe("CodingJobStager", () => {
  it("materializes only tracked index entries with executable bits and safe symlinks", async () => {
    const { source, sibling, staging } = await fixture();
    await writeFile(path.join(source, ".gitignore"), ".env\n.cos-pi-cache/\n");
    await writeFile(path.join(source, ".env"), "IGNORED_SECRET_CANARY\n");
    await mkdir(path.join(source, ".cos-pi-cache"));
    await writeFile(path.join(source, ".cos-pi-cache", "entry"), "cached\n");
    await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(source, "run.sh"), 0o755);
    await symlink("README.md", path.join(source, "README-link"));
    await exec("git", ["-C", source, "add", ".gitignore", "run.sh", "README-link"]);
    const stager = new CodingJobStager(staging);
    const job = await stager.stage(source);

    expect(await readFile(path.join(job.path, "README.md"), "utf8")).toBe("source\n");
    expect((await lstat(path.join(job.path, "run.sh"))).mode & 0o111).toBe(0o111);
    expect(await readlink(path.join(job.path, "README-link"))).toBe("README.md");
    await expect(readFile(path.join(job.path, ".env"))).rejects.toThrow();
    await expect(readFile(path.join(job.path, ".cos-pi-cache", "entry"))).rejects.toThrow();
    await expect(readFile(path.join(job.path, ".git", "config"))).rejects.toThrow();
    expect(await readFile(path.join(sibling, "canary"), "utf8")).toBe("must stay private\n");
  });

  it("rejects escaping symlinks and initial file budgets", async () => {
    const { source, staging } = await fixture();
    await symlink("../../outside", path.join(source, "escape"));
    await exec("git", ["-C", source, "add", "escape"]);
    await expect(new CodingJobStager(staging).stage(source)).rejects.toThrow("Unsafe symlink");
    await rm(path.join(source, "escape"));
    await exec("git", ["-C", source, "rm", "--cached", "escape"]);
    await writeFile(path.join(source, "second"), "two\n");
    await exec("git", ["-C", source, "add", "second"]);
    await expect(new CodingJobStager(staging, { maxFiles: 1 }).stage(source)).rejects.toThrow(
      "file-count limit",
    );
  });

  it("rejects a replaced staging root and special files in the result", async () => {
    const { source, staging } = await fixture();
    const stager = new CodingJobStager(staging);
    const first = await stager.stage(source);
    await rename(first.path, `${first.path}-replaced`);
    await mkdir(first.path);
    await expect(stager.validateResult(first)).rejects.toThrow("identity changed");

    const second = await stager.stage(source);
    await writeFile(path.join(staging, "outside-workspace"), "persistent\n");
    await expect(stager.validateResult(second)).rejects.toThrow("Unexpected entry");

    const third = await stager.stage(source);
    await exec("mkfifo", [path.join(third.path, "pipe")]);
    await expect(stager.validateResult(third)).rejects.toThrow("Special file");
  });

  it("detects canonical directory replacement by device and inode", async () => {
    const { source } = await fixture();
    const identity = await captureDirectoryIdentity(source);
    await rename(source, `${source}-old`);
    await mkdir(source);
    await expect(assertDirectoryIdentity(identity)).rejects.toThrow("identity changed");
  });
});
