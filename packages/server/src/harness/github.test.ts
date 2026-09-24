import { describe, expect, it } from "vitest";
import { GitHubAppHarnessClient } from "./github.js";

function repos(owner: string, count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    full_name: `${owner}/repo-${offset + index}`,
    private: index % 2 === 0,
    default_branch: "main",
  }));
}

describe("GitHubAppHarnessClient repository listing", () => {
  it("walks every installation and page with the right token", async () => {
    const calls: Array<{ path: string; token: string | null }> = [];
    const pages: Record<string, unknown> = {
      "/app/installations?per_page=100&page=1": [{ id: 11 }, { id: 22 }],
      "/installation/repositories?per_page=100&page=1#11": { repositories: repos("example-owner", 100) },
      "/installation/repositories?per_page=100&page=2#11": {
        repositories: repos("example-owner", 20, 100),
      },
      "/installation/repositories?per_page=100&page=1#22": { repositories: repos("example-org", 1) },
      "/repos/example-org/repo-0": { default_branch: "main" },
      "/repos/example-org/repo-0/branches/main": { commit: { sha: "abc" } },
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const path = String(input).replace("https://api.github.com", "");
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? null;
      calls.push({ path, token });
      const installation = token?.startsWith("installation-") ? `#${token.slice(13)}` : "";
      const body = pages[`${path}${path.startsWith("/installation/") ? installation : ""}`];
      if (body === undefined)
        return new Response(JSON.stringify({ message: "nope" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = new GitHubAppHarnessClient(
      {
        available: true,
        slug: "cos-harness",
        createAppJwt: () => "app-jwt",
        getInstallationToken: async (id) => `installation-${id}`,
      },
      fetchImpl,
    );

    const listed = await client.listAccessibleRepositories();
    expect(listed).toHaveLength(121);
    expect(listed.at(-1)).toEqual({
      fullName: "example-org/repo-0",
      private: true,
      defaultBranch: "main",
      installationId: 22,
    });
    expect(calls.map((call) => [call.path, call.token])).toEqual([
      ["/app/installations?per_page=100&page=1", "app-jwt"],
      ["/installation/repositories?per_page=100&page=1", "installation-11"],
      ["/installation/repositories?per_page=100&page=2", "installation-11"],
      ["/installation/repositories?per_page=100&page=1", "installation-22"],
    ]);
    // Installation ids are remembered, so repo calls skip the /installation lookup.
    await client.getDefaultBranch("example-org/repo-0");
    expect(calls.slice(4).map((call) => [call.path, call.token])).toEqual([
      ["/repos/example-org/repo-0", "installation-22"],
      ["/repos/example-org/repo-0/branches/main", "installation-22"],
    ]);
    expect(client.installUrl).toBe("https://github.com/apps/cos-harness/installations/new");
  });

  it("has no install link without an app slug", () => {
    const client = new GitHubAppHarnessClient({
      available: false,
      createAppJwt: () => "",
      getInstallationToken: async () => "",
    });
    expect(client.installUrl).toBeNull();
  });
});
