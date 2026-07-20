import type { Tool } from "ai";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import { createGitHubTools } from "./github.js";

type ExecutableTool = { execute: (input: unknown) => Promise<unknown> };

async function execute(tool: Tool | undefined, input: unknown) {
  if (!tool) throw new Error("tool missing");
  return (tool as unknown as ExecutableTool).execute(input);
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

describe("GitHub tools permissions", () => {
  it("gives non-admins anonymous public-read tools only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(repoResponse());
    const registry = new PendingGitHubActionRegistry();
    const tools = createGitHubTools({
      config: {
        enabled: true,
        publicReadEnabled: true,
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
    });

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
});
