import { describe, expect, it } from "vitest";
import { GitHubAppHarnessClient } from "./github.js";

const REPO = "example-org/MoePeek";

function client(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace(`https://api.github.com/repos/${REPO}`, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  const github = new GitHubAppHarnessClient(
    {
      available: true,
      createAppJwt: () => "app-jwt",
      getInstallationToken: async () => "installation-token",
    },
    fetchImpl,
  );
  github.rememberInstallation(REPO, 1);
  return { releases: github.releases, calls };
}

describe("GitHub release endpoints", () => {
  it("resolves annotated tags to the actual commit for ambiguous creation recovery", async () => {
    const { releases } = client({
      "GET /git/ref/tags/v1.2.0": { body: { object: { type: "tag", sha: "tag-object" } } },
      "GET /git/tags/tag-object": { body: { object: { type: "commit", sha: "commit-sha" } } },
    });
    expect(await releases.getTagRef(REPO, "v1.2.0")).toEqual({ sha: "commit-sha" });
  });

  it("reads all compare pages so recent breaking changes are included", async () => {
    const commits = Array.from({ length: 251 }, (_, i) => ({
      sha: String(i),
      commit: { message: i === 250 ? "feat!: new contract" : "fix: update" },
    }));
    const routes = Object.fromEntries(
      [1, 2, 3].map((page) => [
        `GET /compare/v1.0.0...abc?per_page=100&page=${page}`,
        {
          body: {
            status: "ahead",
            total_commits: 251,
            commits: commits.slice((page - 1) * 100, page * 100),
          },
        },
      ]),
    );
    const { releases } = client(routes);
    const compared = await releases.compare(REPO, "v1.0.0", "abc");
    expect(compared.commits).toHaveLength(251);
    expect(compared.commits.at(-1)?.message).toBe("feat!: new contract");
  });

  it("refuses an oversized or incomplete comparison instead of using partial history", async () => {
    const path = "GET /compare/v1.0.0...abc?per_page=100&page=1";
    for (const total_commits of [1001, 10]) {
      const { releases } = client({
        [path]: {
          body: { status: "ahead", total_commits, commits: [] },
        },
      });
      await expect(releases.compare(REPO, "v1.0.0", "abc")).rejects.toThrow(/提交/);
    }
  });

  it("creates an annotated tag object and then its ref", async () => {
    const { releases, calls } = client({
      "POST /git/tags": { status: 201, body: { sha: "t".repeat(40) } },
      "POST /git/refs": { status: 201, body: { ref: "refs/tags/v1.2.0" } },
    });
    const sha = "a".repeat(40);
    await expect(
      releases.createTag(REPO, { tag: "v1.2.0", sha, message: "Release v1.2.0" }),
    ).resolves.toEqual({ sha: "t".repeat(40) });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/git/tags",
        body: { tag: "v1.2.0", message: "Release v1.2.0", object: sha, type: "commit" },
      },
      { method: "POST", path: "/git/refs", body: { ref: "refs/tags/v1.2.0", sha: "t".repeat(40) } },
    ]);
  });

  it("treats a missing tag, release, or Actions permission as absent", async () => {
    const { releases, calls } = client({
      "GET /releases?per_page=30": {
        body: [{ tag_name: "v1.2.0", html_url: "u", draft: true, prerelease: false }],
      },
      "GET /actions/runs?head_sha=abc&event=push&per_page=30": {
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
    });
    await expect(releases.getTagRef(REPO, "v1.2.0")).resolves.toBeNull();
    await expect(releases.getReleaseByTag(REPO, "v1.2.0")).resolves.toEqual({
      tag: "v1.2.0",
      url: "u",
      draft: true,
      prerelease: false,
    });
    await expect(releases.listWorkflowRuns(REPO, "abc")).resolves.toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      "/git/ref/tags/v1.2.0",
      "/releases/tags/v1.2.0",
      "/releases?per_page=30",
      "/actions/runs?head_sha=abc&event=push&per_page=30",
    ]);
  });
});
