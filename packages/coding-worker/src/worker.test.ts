import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodingWorkerHandler,
  createPiRuntime,
  type CodingWorkerJob,
  resolveWorkspace,
} from "./worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-worker-test-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "workspace"), { recursive: true });
  return root;
}

function job(): CodingWorkerJob {
  return {
    workspacePath: "workspace",
    task: "Update the README",
    timeoutMs: 60_000,
    model: {
      apiKey: "model-secret",
      baseURL: "https://example.com/v1",
      id: "test-model",
      providerFormat: "openai",
      capabilities: ["tool_calling", "code"],
    },
  };
}

describe("coding worker boundary", () => {
  it("reports a stable boot id and marks accepted jobs as one-shot", async () => {
    const root = await workspaceRoot();
    const onJobAccepted = vi.fn();
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      bootId: "boot-one",
      runJob: vi.fn().mockResolvedValue({ summary: "done", durationMs: 1 }),
      onJobAccepted,
    });
    const health = await handler(new Request("http://worker/health"));
    expect(await health.json()).toEqual({ ok: true, busy: false, bootId: "boot-one" });
    const challenge = Buffer.alloc(32, 7).toString("base64url");
    const authenticatedHealth = await handler(
      new Request(`http://worker/health?challenge=${challenge}`),
    );
    const expectedProof = createHmac("sha256", "worker-secret")
      .update("cos-tool-bot/coding-worker-health/v1\0")
      .update(challenge)
      .update("\0")
      .update("boot-one")
      .digest("base64url");
    expect(await authenticatedHealth.json()).toEqual({
      ok: true,
      busy: false,
      bootId: "boot-one",
      challenge,
      proof: expectedProof,
    });

    const response = await handler(
      new Request("http://worker/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret" },
        body: JSON.stringify(job()),
      }),
    );
    expect(response.headers.get("X-Coding-Worker-One-Shot")).toBe("true");
    expect(onJobAccepted).toHaveBeenCalledOnce();
  });

  it("requires the internal bearer secret", async () => {
    const root = await workspaceRoot();
    const runJob = vi.fn();
    const onJobAccepted = vi.fn();
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
      onJobAccepted,
    });

    const response = await handler(
      new Request("http://worker/jobs", { method: "POST", body: JSON.stringify(job()) }),
    );

    expect(response.status).toBe(401);
    expect(runJob).not.toHaveBeenCalled();
    expect(onJobAccepted).not.toHaveBeenCalled();
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
      await realpath(path.join(root, "workspace")),
      expect.any(AbortSignal),
    );
  });

  it("rejects workspace symlinks", async () => {
    const root = await workspaceRoot();
    await symlink(path.join(root, "workspace"), path.join(root, "linked"));
    await expect(resolveWorkspace(root, "linked")).rejects.toThrow("must not contain symlinks");
  });

  it("rejects any user-controlled workspace path", async () => {
    const root = await workspaceRoot();
    const runJob = vi.fn();
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
    });
    const response = await handler(
      new Request("http://worker/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret" },
        body: JSON.stringify({ ...job(), workspacePath: "another-repo" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(runJob).not.toHaveBeenCalled();
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

  it("passes client cancellation to the running one-shot job", async () => {
    const root = await workspaceRoot();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runJob = vi.fn(
      async (_job: CodingWorkerJob, _workspace: string, signal?: AbortSignal) => {
        receivedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    );
    const handler = createCodingWorkerHandler({
      secret: "worker-secret",
      workspacesRoot: root,
      runJob,
    });
    const responsePromise = handler(
      new Request("http://worker/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret" },
        body: JSON.stringify(job()),
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(runJob).toHaveBeenCalledOnce());

    controller.abort(new Error("client disconnected"));
    const response = await responsePromise;

    expect(receivedSignal).toBeDefined();
    if (!receivedSignal) throw new Error("worker did not receive a signal");
    expect(receivedSignal.aborted).toBe(true);
    expect((receivedSignal.reason as Error).message).toBe("client disconnected");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Coding-Worker-One-Shot")).toBe("true");
  });

  it("registers the runtime provider without loading repository extensions", async () => {
    const root = await workspaceRoot();
    const workspace = path.join(root, "workspace");
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
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(32_000);
    expect(model.maxTokens).toBe(8_192);
  });

  it("derives vision, context, and disabled reasoning metadata from model capabilities", async () => {
    const root = await workspaceRoot();
    const workspace = path.join(root, "workspace");
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "coding-worker-agent-test-"));
    tempDirs.push(agentDir);
    const configuredJob = job();
    configuredJob.model.capabilities = ["vision", "reasoning", "long_context"];
    configuredJob.model.thinking = "disabled";
    configuredJob.model.maxTokens = 12_000;

    const { model } = await createPiRuntime(configuredJob, workspace, agentDir);

    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(12_000);
  });
});
import { createHmac } from "node:crypto";
