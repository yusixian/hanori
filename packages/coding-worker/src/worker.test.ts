import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingWorkerHandler, resolveWorkspace } from "./worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-worker-test-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "bot", "owner", "repo"), { recursive: true });
  return root;
}

function job() {
  return {
    workspacePath: "bot/owner/repo",
    task: "Update the README",
    timeoutMs: 60_000,
    model: {
      apiKey: "model-secret",
      baseURL: "https://example.com/v1",
      id: "test-model",
      providerFormat: "openai" as const,
    },
  };
}

describe("coding worker boundary", () => {
  it("requires the internal bearer secret", async () => {
    const root = await workspaceRoot();
    const runJob = vi.fn();
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
    });

    const response = await handler(
      new Request("http://worker/jobs", { method: "POST", body: JSON.stringify(job()) }),
    );

    expect(response.status).toBe(401);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("resolves a canonical workspace and passes the model key only to the job runner", async () => {
    const root = await workspaceRoot();
    const runJob = vi.fn().mockResolvedValue({ summary: "done", durationMs: 10 });
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
    });
    const response = await handler(
      new Request("http://worker/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret" },
        body: JSON.stringify(job()),
      }),
    );

    expect(response.status).toBe(200);
    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.objectContaining({ apiKey: "model-secret" }) }),
      await realpath(path.join(root, "bot", "owner", "repo")),
    );
  });

  it("rejects workspace symlinks", async () => {
    const root = await workspaceRoot();
    await symlink(path.join(root, "bot", "owner", "repo"), path.join(root, "linked"));
    await expect(resolveWorkspace(root, "linked")).rejects.toThrow("must not contain symlinks");
  });
});
