import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingWorkerHandler, createPiRuntime, resolveWorkspace } from "./worker.js";

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

  it.each([
    ["a chunked body without Content-Length", undefined],
    ["a body with a forged Content-Length", "1"],
  ])("rejects %s while streaming past the byte limit", async (_, contentLength) => {
    const root = await workspaceRoot();
    const runJob = vi.fn();
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (chunks === 16) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers: Record<string, string> = { Authorization: "Bearer worker-secret" };
    if (contentLength) headers["Content-Length"] = contentLength;
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
    });
    const response = await handler(
      new Request("http://worker/jobs", {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(16);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("registers the runtime provider without loading repository extensions", async () => {
    const root = await workspaceRoot();
    const workspace = path.join(root, "bot", "owner", "repo");
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "coding-worker-agent-test-"));
    tempDirs.push(agentDir);
    await mkdir(path.join(workspace, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "# Repository guidance\n");
    await writeFile(
      path.join(workspace, ".pi", "extensions", "must-not-load.js"),
      'throw new Error("repository extension executed");\n',
    );

    const { modelRuntime, model, resourceLoader, settingsManager } = await createPiRuntime(
      job(),
      workspace,
      agentDir,
    );

    expect(modelRuntime.getProvider(model.provider)).toBeDefined();
    expect(modelRuntime.hasConfiguredAuth(model.provider)).toBe(true);
    expect((await modelRuntime.getAuth(model.provider))?.auth.apiKey).toBe("model-secret");
    expect(settingsManager.isProjectTrusted()).toBe(false);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(0);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([
      expect.objectContaining({ path: path.join(workspace, "AGENTS.md") }),
    ]);
  });
});
