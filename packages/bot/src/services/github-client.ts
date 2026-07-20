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
  fetch?: typeof fetch;
}

const API_ROOT = "https://api.github.com";
const MAX_ERROR_LENGTH = 500;

function encodePath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new GitHubApiError("Invalid GitHub path", 400);
  }
  return segments.map(encodeURIComponent).join("/");
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getRepository(repository: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${encodePath(repository)}`);
  }

  async readFile(
    repository: string,
    filePath: string,
    ref?: string,
  ): Promise<{
    path: string;
    sha: string;
    size: number;
    content: string;
  }> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const result = await this.request<GitHubContentResponse>(
      `/repos/${encodePath(repository)}/contents/${encodePath(filePath)}${query}`,
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

  async listTree(repository: string, ref?: string): Promise<GitHubTreeResponse> {
    const resolvedRef = ref ?? (await this.getRepository(repository)).default_branch;
    return this.request<GitHubTreeResponse>(
      `/repos/${encodePath(repository)}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
    );
  }

  async listIssues(repository: string, state: "open" | "closed" | "all", limit: number) {
    const result = await this.request<GitHubIssue[]>(
      `/repos/${encodePath(repository)}/issues?state=${state}&per_page=${limit}`,
    );
    return result.filter((issue) => !issue.pull_request);
  }

  async createIssue(repository: string, input: { title: string; body?: string }) {
    return this.request<GitHubIssue>(`/repos/${encodePath(repository)}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateIssue(
    repository: string,
    issueNumber: number,
    input: { title?: string; body?: string; state?: "open" | "closed" },
  ) {
    return this.request<GitHubIssue>(`/repos/${encodePath(repository)}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("User-Agent", "cos-tool-bot");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (this.options.token) headers.set("Authorization", `Bearer ${this.options.token}`);
    if (init.body) headers.set("Content-Type", "application/json");

    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const raw = await response.text();
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as { message?: string };
        detail = parsed.message ?? raw;
      } catch {
        // Use the response text when GitHub did not return JSON.
      }
      throw new GitHubApiError(
        `GitHub API ${response.status}: ${detail.slice(0, MAX_ERROR_LENGTH)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}
