import type { Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import { createGitHubTools } from "./github.js";

type ExecutableTool = {
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

async function execute(tool: Tool | undefined, input: unknown, abortSignal?: AbortSignal) {
  if (!tool) throw new Error("tool missing");
  return (tool as unknown as ExecutableTool).execute(input, { abortSignal });
}

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Api;
}

function repoResponse() {
  return new Response(
    JSON.stringify({
      full_name: "owner/repo",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/owner/repo",
      description: "test",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function branchResponse(branch: string, sha: string) {
  return new Response(
    JSON.stringify({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function pullResponse({
  repository = "owner/repo",
  head = "feat/ai",
  headSha = "a".repeat(40),
  base = "main",
  baseSha = "b".repeat(40),
  number = 42,
  title = "Add feature",
  draft = false,
}: Partial<{
  repository: string;
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  number: number;
  title: string;
  draft: boolean;
}> = {}) {
  return {
    number,
    title,
    state: "open",
    html_url: `https://github.com/${repository}/pull/${number}`,
    draft,
    head: { ref: head, sha: headSha, repo: { full_name: repository } },
    base: { ref: base, sha: baseSha, repo: { full_name: repository } },
  };
}

function adminConfig(token = "token") {
  return {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: false,
    token,
    authorName: "Ai-chan",
    authorEmail: "ai@example.com",
    repositories: ["owner/repo"],
  };
}

describe("GitHub tools permissions", () => {
  it("gives non-admins anonymous public-read tools only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(repoResponse());
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: true,
        token: "super-secret-token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/repo"],
      },
      isAdmin: false,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock,
      codeCallbacks: {
        runTask: vi.fn(),
        previewPush: vi.fn(),
        pushBranch: vi.fn(),
      },
    });

    expect(tools.github_code_task).toBeUndefined();
    expect(tools.github_push_branch).toBeUndefined();
    expect(tools.github_create_pull_request).toBeUndefined();
    expect(tools.github_create_issue).toBeUndefined();
    expect(tools.github_update_issue).toBeUndefined();
    await execute(tools.github_repository, { repository: "owner/repo" });

    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.has("Authorization")).toBe(false);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("super-secret-token");
    registry.destroy();
  });

  it("uses the credential only for an admin reading an allowlisted repository", async () => {
    const fetchMock = vi.fn().mockResolvedValue(repoResponse());
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: false,
        token: "super-secret-token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["Owner/Repo"],
      },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock,
    });

    await execute(tools.github_repository, { repository: "owner/repo" });

    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer super-secret-token");
    registry.destroy();
  });

  it("queues an allowlisted Issue write without calling GitHub", async () => {
    const fetchMock = vi.fn();
    const api = createApi();
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: false,
        token: "token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/repo"],
      },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api,
      pendingActions: registry,
      fetch: fetchMock,
    });

    const result = await execute(tools.github_create_issue, {
      repository: "owner/repo",
      title: "A safe proposal",
      body: "Details",
    });

    expect(result).toEqual(
      expect.objectContaining({ pending_confirmation: true, description: expect.any(String) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    registry.destroy();
  });

  it("rejects administrator writes outside the repository allowlist", async () => {
    const fetchMock = vi.fn();
    const api = createApi();
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: false,
        token: "token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/allowed"],
      },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api,
      pendingActions: registry,
      fetch: fetchMock,
    });

    await expect(
      execute(tools.github_create_issue, {
        repository: "owner/not-allowed",
        title: "Nope",
      }),
    ).resolves.toEqual({
      error: "Repository is not in the administrator-managed GitHub allowlist",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    registry.destroy();
  });

  it("rejects dot-segment file paths before making a request", async () => {
    const fetchMock = vi.fn();
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: false,
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: [],
      },
      isAdmin: false,
      userId: 8,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock,
    });

    await expect(
      execute(tools.github_read_file, {
        repository: "owner/repo",
        path: "../issues",
      }),
    ).resolves.toEqual({ error: "Invalid GitHub path" });
    expect(fetchMock).not.toHaveBeenCalled();
    registry.destroy();
  });

  it("offers PR creation independently of Pi but rejects missing credentials and allowlist entries", async () => {
    const registry = new PendingGitHubActionRegistry();
    const withoutToken = createGitHubTools({
      config: { ...adminConfig(), token: undefined },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: vi.fn(),
    });
    expect(withoutToken.github_create_pull_request).toBeDefined();
    await expect(
      execute(withoutToken.github_create_pull_request, {
        repository: "owner/repo",
        head: "feat/ai",
        base: "main",
        title: "Add feature",
        draft: false,
      }),
    ).resolves.toEqual({ error: "Ai-chan's GitHub token is not configured" });

    const outsideAllowlist = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: vi.fn(),
    });
    await expect(
      execute(outsideAllowlist.github_create_pull_request, {
        repository: "owner/other",
        head: "feat/ai",
        base: "main",
        title: "Add feature",
        draft: false,
      }),
    ).resolves.toEqual({
      error: "Repository is not in the administrator-managed GitHub allowlist",
    });
    registry.destroy();
  });

  it("rejects fork-style head syntax before making a request", async () => {
    const fetchMock = vi.fn();
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock,
    });

    await expect(
      execute(tools.github_create_pull_request, {
        repository: "owner/repo",
        head: "fork-owner:feat/ai",
        base: "main",
        title: "No forks",
        draft: false,
      }),
    ).resolves.toEqual({ error: "Invalid GitHub branch" });
    expect(fetchMock).not.toHaveBeenCalled();
    registry.destroy();
  });

  it("binds PR confirmation to refs and sends the exact payload only after confirmation", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const body = "Exact PR body";
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.includes("/git/ref/heads/feat/ai")) return branchResponse("feat/ai", headSha);
      if (url.includes("/git/ref/heads/main")) return branchResponse("main", baseSha);
      if (url.includes("/pulls?") && method === "GET") {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/pulls") && method === "POST") {
        return new Response(
          JSON.stringify(pullResponse({ headSha, baseSha, title: "Add feature", draft: true })),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const api = createApi();
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api,
      pendingActions: registry,
      fetch: fetchMock as typeof fetch,
    });

    const proposal = (await execute(tools.github_create_pull_request, {
      repository: "owner/repo",
      head: "feat/ai",
      base: "main",
      title: "Add feature",
      body,
      draft: true,
    })) as { action_id: string; description: string };

    expect(proposal.description).toContain("feat/ai -> main");
    expect(proposal.description).toContain(headSha);
    expect(proposal.description).toContain(baseSha);
    expect(proposal.description).toContain("正文 SHA-256：");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);

    const result = await registry.take(proposal.action_id)!.execute();
    expect(result).toEqual({
      summary: "已创建 owner/repo#42：Add feature",
      url: "https://github.com/owner/repo/pull/42",
    });
    const post = requests.find((request) => request.method === "POST");
    expect(post?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
    expect(JSON.parse(post!.body!)).toEqual({
      title: "Add feature",
      head: "feat/ai",
      base: "main",
      body,
      draft: true,
    });
    registry.destroy();
  });

  it("rejects PR confirmation if the remote head changed", async () => {
    let headReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/feat/ai")) {
        headReads++;
        return branchResponse("feat/ai", (headReads === 1 ? "a" : "c").repeat(40));
      }
      if (url.includes("/git/ref/heads/main")) return branchResponse("main", "b".repeat(40));
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock as typeof fetch,
    });
    const proposal = (await execute(tools.github_create_pull_request, {
      repository: "owner/repo",
      head: "feat/ai",
      base: "main",
      title: "Add feature",
      draft: false,
    })) as { action_id: string };

    await expect(registry.take(proposal.action_id)!.execute()).rejects.toThrow(
      "source changed after confirmation preview",
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    registry.destroy();
  });

  it("returns an existing same-repository PR without posting a duplicate", async () => {
    const headSha = "a".repeat(40);
    const existing = pullResponse({ headSha, number: 17, title: "Existing" });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/feat/ai")) return branchResponse("feat/ai", headSha);
      if (url.includes("/git/ref/heads/main")) return branchResponse("main", "b".repeat(40));
      if (url.includes("/pulls?") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([existing]), { status: 200 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock as typeof fetch,
    });
    const proposal = (await execute(tools.github_create_pull_request, {
      repository: "owner/repo",
      head: "feat/ai",
      base: "main",
      title: "Add feature",
      draft: false,
    })) as { action_id: string };

    await expect(registry.take(proposal.action_id)!.execute()).resolves.toEqual({
      summary: "已存在 owner/repo#17：Existing",
      url: "https://github.com/owner/repo/pull/17",
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    registry.destroy();
  });

  it.each([
    [403, "GitHub denied the request; verify the token and repository permissions"],
    [422, "GitHub rejected the pull request details"],
  ])("does not expose GitHub %i response bodies", async (status, expected) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: "secret upstream detail token=abc" }), { status }),
      );
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock,
    });

    const result = await execute(tools.github_create_pull_request, {
      repository: "owner/repo",
      head: "feat/ai",
      base: "main",
      title: "Add feature",
      draft: false,
    });
    expect(result).toEqual({ error: expected });
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
    registry.destroy();
  });

  it("sanitizes an unverified 422 returned by the create POST", async () => {
    const headSha = "a".repeat(40);
    let pullReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/git/ref/heads/feat/ai")) return branchResponse("feat/ai", headSha);
      if (url.includes("/git/ref/heads/main")) return branchResponse("main", "b".repeat(40));
      if (url.includes("/pulls?") && method === "GET") {
        pullReads++;
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/pulls") && method === "POST") {
        return new Response(JSON.stringify({ message: "token=secret body=private" }), {
          status: 422,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: adminConfig(),
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      fetch: fetchMock as typeof fetch,
    });
    const proposal = (await execute(tools.github_create_pull_request, {
      repository: "owner/repo",
      head: "feat/ai",
      base: "main",
      title: "Add feature",
      draft: false,
    })) as { action_id: string };

    await expect(registry.take(proposal.action_id)!.execute()).rejects.toThrow(
      "GitHub rejected the pull request details. No pull request URL was verified",
    );
    expect(pullReads).toBe(2);
    registry.destroy();
  });

  it("runs local coding automatically but queues the exact push for confirmation", async () => {
    const api = createApi();
    const registry = new PendingGitHubActionRegistry();
    const runTask = vi.fn().mockResolvedValue({
      repository: "owner/repo",
      branch: "feat/ai",
      commitSha: "a".repeat(40),
      changedFiles: ["README.md"],
      summary: "updated",
      status: "committed",
    });
    const previewPush = vi.fn().mockResolvedValue({
      repository: "owner/repo",
      branch: "feat/ai",
      commitSha: "a".repeat(40),
    });
    const pushBranch = vi.fn().mockResolvedValue({ summary: "pushed" });
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: true,
        token: "token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/repo"],
      },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api,
      pendingActions: registry,
      codeCallbacks: { runTask, previewPush, pushBranch },
      codingModel: {
        apiKey: "model-secret",
        baseURL: "https://models.example/v1",
        id: "selected-model",
        providerFormat: "openai",
        capabilities: ["tool_calling", "code"],
      },
    });

    await execute(tools.github_code_task, {
      repository: "owner/repo",
      task: "Update docs",
      branch: "feat/ai",
      commit_message: "docs: update",
    });
    expect(runTask).toHaveBeenCalledOnce();
    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "owner/repo", branch: "feat/ai" }),
      expect.objectContaining({ id: "selected-model", apiKey: "model-secret" }),
      undefined,
    );

    const proposal = (await execute(tools.github_push_branch, {
      repository: "owner/repo",
      branch: "feat/ai",
    })) as { action_id: string };
    expect(previewPush).toHaveBeenCalledOnce();
    expect(pushBranch).not.toHaveBeenCalled();
    await registry.take(proposal.action_id)!.execute();
    expect(pushBranch).toHaveBeenCalledWith("owner/repo", "feat/ai", "a".repeat(40));
    registry.destroy();
  });

  it("propagates an aborted tool signal and does not turn cancellation into a tool result", async () => {
    const registry = new PendingGitHubActionRegistry();
    const controller = new AbortController();
    const aborted = new Error("stopped");
    const runTask = vi.fn(async (_input, _model, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
        codingAgentEnabled: true,
        token: "token",
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/repo"],
      },
      isAdmin: true,
      userId: 7,
      chatId: -100,
      api: createApi(),
      pendingActions: registry,
      codeCallbacks: { runTask, previewPush: vi.fn(), pushBranch: vi.fn() },
      codingModel: {
        apiKey: "model-secret",
        baseURL: "https://models.example/v1",
        id: "selected-model",
        providerFormat: "openai",
        capabilities: ["tool_calling", "code"],
      },
    });

    const result = execute(
      tools.github_code_task,
      { repository: "owner/repo", task: "Update docs", branch: "feat/ai" },
      controller.signal,
    );
    controller.abort(aborted);

    await expect(result).rejects.toBe(aborted);
    expect(runTask).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), controller.signal);
    registry.destroy();
  });
});
