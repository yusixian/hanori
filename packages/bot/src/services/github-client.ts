export interface GitHubRepository {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  description: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  pull_request?: unknown;
  user?: { login: string };
  labels?: Array<{ name?: string } | string>;
}

export interface GitHubBranchRef {
  ref: string;
  sha: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  draft: boolean;
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string };
  };
  base: {
    ref: string;
    sha: string;
    repo: { full_name: string };
  };
}

interface GitHubRefResponse {
  ref: string;
  object: {
    type: string;
    sha: string;
  };
}

interface GitHubContentResponse {
  type: string;
  name: string;
  path: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
  download_url?: string | null;
}

interface GitHubTreeResponse {
  truncated: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
  }>;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubClientOptions {
  token?: string;
  tokenProvider?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

const API_ROOT = "https://api.github.com";
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

function encodePath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new GitHubApiError("Invalid GitHub path", 400);
  }
  return segments.map(encodeURIComponent).join("/");
}

function assertBranchName(branch: string): void {
  if (
    !branch ||
    branch.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  ) {
    throw new GitHubApiError("Invalid GitHub branch", 400);
  }
  encodePath(branch);
}

function validatePullRequest(
  value: unknown,
  repository: string,
  head: string,
  base: string,
  expectedHeadSha?: string,
): GitHubPullRequest {
  if (!value || typeof value !== "object") {
    throw new GitHubApiError("GitHub returned an unexpected pull request", 502);
  }
  const pull = value as GitHubPullRequest;
  const sameRepository = (name: string | undefined) =>
    name?.toLowerCase() === repository.toLowerCase();
  const expectedUrl = `https://github.com/${repository}/pull/${pull.number}`.toLowerCase();
  if (
    !Number.isInteger(pull.number) ||
    pull.number <= 0 ||
    typeof pull.title !== "string" ||
    pull.state !== "open" ||
    typeof pull.draft !== "boolean" ||
    pull.html_url?.toLowerCase() !== expectedUrl ||
    pull.head?.ref !== head ||
    pull.base?.ref !== base ||
    !sameRepository(pull.head?.repo?.full_name) ||
    !sameRepository(pull.base?.repo?.full_name) ||
    !COMMIT_SHA_RE.test(pull.head?.sha ?? "") ||
    !COMMIT_SHA_RE.test(pull.base?.sha ?? "") ||
    (expectedHeadSha !== undefined && pull.head.sha !== expectedHeadSha)
  ) {
    throw new GitHubApiError("GitHub returned an unexpected pull request", 502);
  }
  return pull;
}

function safeApiError(status: number): string {
  if (status === 401 || status === 403) {
    return "GitHub denied the request; verify the token and repository permissions";
  }
  if (status === 404) return "GitHub repository or ref was not found";
  if (status === 422) return "GitHub rejected the pull request details";
  if (status === 429) return "GitHub rate-limited the request; try again later";
  return `GitHub API request failed (${status})`;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getRepository(repository: string, signal?: AbortSignal): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${encodePath(repository)}`, { signal });
  }

  async readFile(
    repository: string,
    filePath: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    sha: string;
    size: number;
    content: string;
  }> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const result = await this.request<GitHubContentResponse>(
      `/repos/${encodePath(repository)}/contents/${encodePath(filePath)}${query}`,
      { signal },
    );
    if (result.type !== "file") throw new GitHubApiError("The requested path is not a file", 400);
    if (result.encoding !== "base64" || !result.content) {
      throw new GitHubApiError("GitHub did not return inline text content for this file", 413);
    }
    return {
      path: result.path,
      sha: result.sha,
      size: result.size,
      content: Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8"),
    };
  }

  async listTree(
    repository: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<GitHubTreeResponse> {
    const resolvedRef = ref ?? (await this.getRepository(repository, signal)).default_branch;
    return this.request<GitHubTreeResponse>(
      `/repos/${encodePath(repository)}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
      { signal },
    );
  }

  async listIssues(
    repository: string,
    state: "open" | "closed" | "all",
    limit: number,
    signal?: AbortSignal,
  ) {
    const result = await this.request<GitHubIssue[]>(
      `/repos/${encodePath(repository)}/issues?state=${state}&per_page=${limit}`,
      { signal },
    );
    return result.filter((issue) => !issue.pull_request);
  }

  async createIssue(
    repository: string,
    input: { title: string; body?: string },
    signal?: AbortSignal,
  ) {
    return this.request<GitHubIssue>(`/repos/${encodePath(repository)}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    });
  }

  async updateIssue(
    repository: string,
    issueNumber: number,
    input: { title?: string; body?: string; state?: "open" | "closed" },
    signal?: AbortSignal,
  ) {
    return this.request<GitHubIssue>(`/repos/${encodePath(repository)}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal,
    });
  }

  async resolveBranch(
    repository: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubBranchRef> {
    assertBranchName(branch);
    const result = await this.request<unknown>(
      `/repos/${encodePath(repository)}/git/ref/heads/${encodePath(branch)}`,
      { signal },
    );
    const branchRef = result as GitHubRefResponse | null;
    if (
      !branchRef ||
      branchRef.ref !== `refs/heads/${branch}` ||
      branchRef.object?.type !== "commit" ||
      !COMMIT_SHA_RE.test(branchRef.object?.sha ?? "")
    ) {
      throw new GitHubApiError("GitHub returned an unexpected branch ref", 502);
    }
    return { ref: branch, sha: branchRef.object.sha };
  }

  async findOpenPullRequest(
    repository: string,
    head: string,
    base: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest | undefined> {
    assertBranchName(head);
    assertBranchName(base);
    const [owner] = repository.split("/");
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${head}`,
      base,
      per_page: "100",
    });
    const pulls = await this.request<unknown>(`/repos/${encodePath(repository)}/pulls?${query}`, {
      signal,
    });
    if (!Array.isArray(pulls)) {
      throw new GitHubApiError("GitHub returned an unexpected pull request list", 502);
    }
    const match = pulls.find((value) => {
      if (!value || typeof value !== "object") return false;
      const pull = value as GitHubPullRequest;
      return (
        pull.head?.ref === head &&
        pull.base?.ref === base &&
        pull.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        pull.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
      );
    });
    return match ? validatePullRequest(match, repository, head, base) : undefined;
  }

  async createPullRequest(
    repository: string,
    input: {
      title: string;
      head: string;
      base: string;
      body?: string;
      draft: boolean;
      expectedHeadSha: string;
    },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    assertBranchName(input.head);
    assertBranchName(input.base);
    const result = await this.request<unknown>(`/repos/${encodePath(repository)}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body === undefined ? {} : { body: input.body }),
        draft: input.draft,
      }),
      signal,
    });
    return validatePullRequest(result, repository, input.head, input.base, input.expectedHeadSha);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("User-Agent", "cos-tool-bot");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const token = this.options.tokenProvider
      ? await this.options.tokenProvider()
      : this.options.token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");

    const timeoutSignal = AbortSignal.timeout(30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubApiError(safeApiError(response.status), response.status);
    }
    return (await response.json()) as T;
  }
}
