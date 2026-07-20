import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  return { root, source, sibling, staging };
}

describe("CodingJobStager", () => {
  it("copies only one repository without Git metadata, caches, or sibling canaries", async () => {
    const { source, sibling, staging } = await fixture();
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git", "config"), "secret\n");
    await mkdir(path.join(source, ".cos-pi-cache"));
    await writeFile(path.join(source, ".cos-pi-cache", "entry"), "cached\n");
    const stager = new CodingJobStager(staging);
    const job = await stager.stage(source);

    expect(await readFile(path.join(job.path, "README.md"), "utf8")).toBe("source\n");
    await expect(readFile(path.join(job.path, ".git", "config"))).rejects.toThrow();
    await expect(readFile(path.join(job.path, ".cos-pi-cache", "entry"))).rejects.toThrow();
    expect(await readFile(path.join(sibling, "canary"), "utf8")).toBe("must stay private\n");
  });

  it("rejects escaping symlinks and initial file budgets", async () => {
    const { source, staging } = await fixture();
    await symlink("../../outside", path.join(source, "escape"));
    await expect(new CodingJobStager(staging).stage(source)).rejects.toThrow("Traversing symlink");
    await rm(path.join(source, "escape"));
    await writeFile(path.join(source, "second"), "two\n");
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
