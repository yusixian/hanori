import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../services/github-api.js";
import { GitHubAppHarnessClient } from "./github.js";

const silent = { warn: () => undefined };

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
      "/installation/repositories?per_page=100&page=1#11": {
        repositories: repos("example-owner", 100),
      },
      "/installation/repositories?per_page=100&page=2#11": {
        repositories: repos("example-owner", 20, 100),
      },
      "/installation/repositories?per_page=100&page=1#22": {
        repositories: repos("example-org", 1),
      },
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
      silent,
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
    const client = new GitHubAppHarnessClient(
      { available: false, createAppJwt: () => "", getInstallationToken: async () => "" },
      silent,
    );
    expect(client.installUrl).toBeNull();
  });
});

const REPO = "example-org/MoePeek";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function repoClient(
  answer: () => Response,
  getInstallationToken: () => Promise<string> = async () => "installation-token",
) {
  const warnings: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async () => answer());
  const client = new GitHubAppHarnessClient(
    { available: true, createAppJwt: () => "app-jwt", getInstallationToken },
    { warn: (message) => void warnings.push(message) },
    fetchImpl,
  );
  client.rememberInstallation(REPO, 1);
  return { client, warnings, fetchImpl };
}

describe("GitHubAppHarnessClient required checks", () => {
  it("merges the branch's required contexts and checks", async () => {
    const { client, fetchImpl } = repoClient(() =>
      json(200, { contexts: ["ci", "lint"], checks: [{ context: "ci" }, { context: "e2e" }] }),
    );
    await expect(client.getRequiredChecks(REPO, "main")).resolves.toEqual(["ci", "lint", "e2e"]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/${REPO}/branches/main/protection/required_status_checks`,
    );
  });

  it("reads an unprotected branch as having no required checks", async () => {
    const { client, warnings } = repoClient(() => json(404, { message: "Branch not protected" }));
    await expect(client.getRequiredChecks(REPO, "main")).resolves.toBeNull();
    expect(warnings).toEqual([]);
  });

  it("falls back when the App may not read branch protection, warning once per branch", async () => {
    const { client, warnings } = repoClient(() =>
      json(403, { message: "Resource not accessible by integration" }),
    );
    await expect(client.getRequiredChecks(REPO, "main")).resolves.toBeNull();
    await expect(client.getRequiredChecks(REPO, "main")).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${REPO}@main`);
    await client.getRequiredChecks(REPO, "release");
    expect(warnings).toHaveLength(2);
  });

  it("throws a rate-limited read instead of relaxing the gate", async () => {
    const primary = repoClient(() =>
      json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
    );
    await expect(primary.client.getRequiredChecks(REPO, "main")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    const tooMany = repoClient(() => json(429, { message: "slow down" }, { "retry-after": "5" }));
    await expect(tooMany.client.getRequiredChecks(REPO, "main")).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 5_000,
    });
    expect([...primary.warnings, ...tooMany.warnings]).toEqual([]);
  });

  it("never reads a credential failure as an absent resource", async () => {
    const revoked = new GitHubApiError(404, "GitHub installation token 获取失败 (404)");
    const { client, fetchImpl } = repoClient(
      () => json(200, {}),
      async () => {
        throw revoked;
      },
    );
    await expect(client.getRequiredChecks(REPO, "main")).rejects.toBe(revoked);
    await expect(client.getFile(REPO, ".cos/harness.yml", "main")).rejects.toBe(revoked);
    await expect(client.releases.getTagRef(REPO, "v1.0.0")).rejects.toBe(revoked);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the App is not installed on the repository instead of reading it as absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith(`/repos/${REPO}/installation`)
        ? json(404, { message: "Not Found" })
        : json(200, {}),
    );
    const client = new GitHubAppHarnessClient(
      {
        available: true,
        createAppJwt: () => "app-jwt",
        getInstallationToken: async () => "installation-token",
      },
      silent,
      fetchImpl,
    );
    for (const read of [
      () => client.getFile(REPO, ".cos/harness.yml", "main"),
      () => client.releases.getTagRef(REPO, "v1.0.0"),
      () => client.getRequiredChecks(REPO, "main"),
    ]) {
      const error = await read().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ status: 404, kind: "not_found" });
    }
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual(
      Array(3).fill(`https://api.github.com/repos/${REPO}/installation`),
    );
  });
});
