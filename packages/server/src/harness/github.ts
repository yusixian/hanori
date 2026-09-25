import type { GitHubAppCredentialService } from "../services/github-app-credentials.js";
import type { CheckRunInput, CommitStatusInput } from "./contract.js";
import {
  type CommitSummary,
  type IssueDetail,
  type IssueSummary,
  type PullRequestSummary,
  type RawCommit,
  type RawIssue,
  type RawIssueComment,
  type RawPullRequestListItem,
  toCommitSummary,
  toIssueDetail,
  toIssueSummary,
  toPullRequestSummary,
} from "./github-issues.js";
import type { ChangedFile } from "./risk.js";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_FILE_PAGES = 30;
const MAX_CHECK_PAGES = 5;
const MAX_INSTALLATIONS = 20;
const MAX_INSTALLATION_PAGES = 3;
const MAX_REPOSITORY_PAGES = 10;

export type {
  CommitSummary,
  IssueComment,
  IssueDetail,
  IssueSummary,
  PullRequestSummary,
} from "./github-issues.js";

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  htmlUrl: string;
  author: string | null;
  headSha: string;
  headRef: string;
  headRepo: string | null;
  labels: string[];
  baseRef: string;
  mergeable: boolean | null;
  createdAt: Date;
}

export interface AccessibleRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  installationId: number;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "dir" | "other";
}

/** The subset of GitHub the harness needs; tests substitute a fake. */
export interface HarnessGitHub {
  readonly available: boolean;
  /** Where the owner grants the App access to more accounts or repositories. */
  readonly installUrl: string | null;
  rememberInstallation(repo: string, installationId: number): void;
  /** Every repository the App can reach, across all of its installations (bounded). */
  listAccessibleRepositories(): Promise<AccessibleRepository[]>;
  getDefaultBranch(repo: string): Promise<{ branch: string; sha: string }>;
  getFile(repo: string, path: string, ref: string): Promise<string | null>;
  /** Null when the path does not exist or is not a directory. */
  listDirectory(repo: string, path: string, ref: string): Promise<DirectoryEntry[] | null>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  /** The open PR whose head is `branch` on the repository itself, if any. */
  findOpenPullRequest(repo: string, branch: string): Promise<number | null>;
  listPullRequestFiles(repo: string, number: number): Promise<ChangedFile[]>;
  listChecks(
    repo: string,
    sha: string,
  ): Promise<{ runs: CheckRunInput[]; statuses: CommitStatusInput[] }>;
  getRequiredChecks(repo: string, branch: string): Promise<string[] | null>;
  mergePullRequest(
    repo: string,
    number: number,
    input: { sha: string; method: "squash" | "merge" | "rebase" },
  ): Promise<{ merged: boolean; sha: string | null; message: string }>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  createIssue(
    repo: string,
    input: { title: string; body: string; labels: string[] },
  ): Promise<{ number: number; url: string }>;
  /** Works for issues and pull requests alike. */
  createComment(repo: string, number: number, body: string): Promise<{ id: number }>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  /** Issues only (pull requests excluded), most recently updated first. */
  listIssues(
    repo: string,
    input: { state: "open" | "closed" | "all"; labels?: string; limit: number },
  ): Promise<IssueSummary[]>;
  /** Most recently updated first. */
  listPullRequests(
    repo: string,
    input: { state: "open" | "closed" | "all"; limit: number },
  ): Promise<PullRequestSummary[]>;
  /** GitHub issue search scoped to the repository; `query` uses GitHub search syntax. */
  searchIssues(repo: string, query: string, limit: number): Promise<IssueSummary[]>;
  getIssue(repo: string, number: number, commentLimit: number): Promise<IssueDetail>;
  /** Default branch history, newest first. */
  listCommits(repo: string, limit: number): Promise<CommitSummary[]>;
}

type Credentials = Pick<
  GitHubAppCredentialService,
  "available" | "createAppJwt" | "getInstallationToken"
> & { readonly slug?: string | null };

interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  html_url: string;
  user?: { login?: string } | null;
  head: { sha: string; ref: string; repo?: { full_name?: string } | null };
  labels?: Array<{ name?: string }>;
  base: { ref: string };
  mergeable?: boolean | null;
  created_at: string;
}

export class GitHubAppHarnessClient implements HarnessGitHub {
  private readonly installations = new Map<string, number>();

  constructor(
    private readonly credentials: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available() {
    return this.credentials.available;
  }

  get installUrl() {
    const slug = this.credentials.slug;
    return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
  }

  rememberInstallation(repo: string, installationId: number) {
    this.installations.set(repo.toLowerCase(), installationId);
  }

  async listAccessibleRepositories(): Promise<AccessibleRepository[]> {
    const installations: number[] = [];
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
      const batch = await this.send<Array<{ id: number }>>(
        `/app/installations?per_page=100&page=${page}`,
        this.credentials.createAppJwt(),
      );
      installations.push(...batch.map((installation) => installation.id));
      if (batch.length < 100) break;
    }
    const repos: AccessibleRepository[] = [];
    for (const installationId of installations.slice(0, MAX_INSTALLATIONS)) {
      const token = await this.credentials.getInstallationToken(installationId);
      for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
        const batch = await this.send<{
          repositories: Array<{ full_name: string; private: boolean; default_branch?: string }>;
        }>(`/installation/repositories?per_page=100&page=${page}`, token);
        for (const repo of batch.repositories) {
          this.rememberInstallation(repo.full_name, installationId);
          repos.push({
            fullName: repo.full_name,
            private: repo.private,
            defaultBranch: repo.default_branch ?? null,
            installationId,
          });
        }
        if (batch.repositories.length < 100) break;
      }
    }
    return repos;
  }

  private async installationFor(repo: string): Promise<number> {
    const cached = this.installations.get(repo.toLowerCase());
    if (cached) return cached;
    const response = await this.send<{ id: number }>(
      `/repos/${repo}/installation`,
      this.credentials.createAppJwt(),
    );
    this.rememberInstallation(repo, response.id);
    return response.id;
  }

  private async send<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "cos-tool-bot-harness",
        "X-GitHub-Api-Version": API_VERSION,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const message =
        (json as { message?: string } | undefined)?.message ?? `GitHub ${response.status}`;
      throw new GitHubApiError(response.status, message.slice(0, 300));
    }
    return json as T;
  }

  private async repoToken(repo: string): Promise<string> {
    return this.credentials.getInstallationToken(await this.installationFor(repo));
  }

  private async repoRequest<T>(repo: string, path: string, init?: RequestInit): Promise<T> {
    return this.send<T>(`/repos/${repo}${path}`, await this.repoToken(repo), init);
  }

  async getDefaultBranch(repo: string) {
    const info = await this.repoRequest<{ default_branch: string }>(repo, "");
    const branch = await this.repoRequest<{ commit: { sha: string } }>(
      repo,
      `/branches/${encodeURIComponent(info.default_branch)}`,
    );
    return { branch: info.default_branch, sha: branch.commit.sha };
  }

  async getFile(repo: string, path: string, ref: string) {
    try {
      const file = await this.repoRequest<{ content?: string; encoding?: string; type?: string }>(
        repo,
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
      if (file.type !== "file" || file.encoding !== "base64" || !file.content) return null;
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listDirectory(repo: string, path: string, ref: string): Promise<DirectoryEntry[] | null> {
    const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
    try {
      const entries = await this.repoRequest<unknown>(
        repo,
        `/contents${suffix}?ref=${encodeURIComponent(ref)}`,
      );
      if (!Array.isArray(entries)) return null;
      return entries.map((entry: { name: string; type: string }) => ({
        name: entry.name,
        type: entry.type === "file" || entry.type === "dir" ? entry.type : "other",
      }));
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const pr = await this.repoRequest<RawPullRequest>(repo, `/pulls/${number}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged ?? Boolean(pr.merged_at),
      draft: pr.draft ?? false,
      htmlUrl: pr.html_url,
      author: pr.user?.login ?? null,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      headRepo: pr.head.repo?.full_name ?? null,
      labels: (pr.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
      baseRef: pr.base.ref,
      mergeable: pr.mergeable ?? null,
      createdAt: new Date(pr.created_at),
    };
  }

  async findOpenPullRequest(repo: string, branch: string): Promise<number | null> {
    const owner = repo.split("/")[0]!;
    const head = encodeURIComponent(`${owner}:${branch}`);
    const pulls = await this.repoRequest<Array<{ number: number }>>(
      repo,
      `/pulls?state=open&head=${head}&per_page=1`,
    );
    return pulls[0]?.number ?? null;
  }

  async listPullRequestFiles(repo: string, number: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.repoRequest<
        Array<{
          filename: string;
          status: string;
          previous_filename?: string;
          patch?: string;
          additions?: number;
          deletions?: number;
        }>
      >(repo, `/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(
        ...batch.map((file) => ({
          filename: file.filename,
          status: file.status,
          previousFilename: file.previous_filename,
          patch: file.patch,
          additions: file.additions,
          deletions: file.deletions,
        })),
      );
      if (batch.length < 100) break;
    }
    return files;
  }

  async listChecks(repo: string, sha: string) {
    const runs: CheckRunInput[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const batch = await this.repoRequest<{
        check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
      }>(repo, `/commits/${sha}/check-runs?per_page=100&page=${page}`);
      runs.push(
        ...batch.check_runs.map(({ id, name, status, conclusion }) => ({
          id,
          name,
          status,
          conclusion,
        })),
      );
      if (batch.check_runs.length < 100) break;
    }
    const combined = await this.repoRequest<{
      statuses: Array<{ context: string; state: string }>;
    }>(repo, `/commits/${sha}/status?per_page=100`);
    return {
      runs,
      statuses: combined.statuses.map(({ context, state }) => ({ context, state })),
    };
  }

  async getRequiredChecks(repo: string, branch: string) {
    try {
      const protection = await this.repoRequest<{
        contexts?: string[];
        checks?: Array<{ context: string }>;
      }>(repo, `/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
      const names = new Set([
        ...(protection.contexts ?? []),
        ...(protection.checks ?? []).map((check) => check.context),
      ]);
      return [...names];
    } catch (error) {
      if (error instanceof GitHubApiError && [403, 404].includes(error.status)) return null;
      throw error;
    }
  }

  async mergePullRequest(
    repo: string,
    number: number,
    input: { sha: string; method: "squash" | "merge" | "rebase" },
  ) {
    const result = await this.repoRequest<{ merged: boolean; sha?: string; message: string }>(
      repo,
      `/pulls/${number}/merge`,
      { method: "PUT", body: JSON.stringify({ sha: input.sha, merge_method: input.method }) },
    );
    return { merged: result.merged, sha: result.sha ?? null, message: result.message };
  }

  async deleteBranch(repo: string, branch: string) {
    await this.repoRequest<void>(
      repo,
      `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      { method: "DELETE" },
    );
  }

  async createIssue(repo: string, input: { title: string; body: string; labels: string[] }) {
    const issue = await this.repoRequest<{ number: number; html_url: string }>(repo, "/issues", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { number: issue.number, url: issue.html_url };
  }

  async createComment(repo: string, number: number, body: string) {
    const comment = await this.repoRequest<{ id: number }>(repo, `/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return { id: comment.id };
  }

  async addLabels(repo: string, number: number, labels: string[]) {
    await this.repoRequest<unknown>(repo, `/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  async listIssues(
    repo: string,
    input: { state: "open" | "closed" | "all"; labels?: string; limit: number },
  ) {
    const params = new URLSearchParams({
      state: input.state,
      sort: "updated",
      per_page: String(Math.min(100, input.limit * 3)),
    });
    if (input.labels) params.set("labels", input.labels);
    const issues = await this.repoRequest<RawIssue[]>(repo, `/issues?${params}`);
    return issues
      .filter((issue) => !issue.pull_request)
      .slice(0, input.limit)
      .map(toIssueSummary);
  }

  async listPullRequests(repo: string, input: { state: "open" | "closed" | "all"; limit: number }) {
    const params = new URLSearchParams({
      state: input.state,
      sort: "updated",
      direction: "desc",
      per_page: String(Math.min(100, input.limit)),
    });
    const pulls = await this.repoRequest<RawPullRequestListItem[]>(repo, `/pulls?${params}`);
    return pulls.map(toPullRequestSummary);
  }

  async searchIssues(repo: string, query: string, limit: number) {
    const params = new URLSearchParams({
      q: `repo:${repo} ${query}`,
      sort: "updated",
      per_page: String(Math.min(100, limit)),
    });
    const result = await this.send<{ items: RawIssue[] }>(
      `/search/issues?${params}`,
      await this.repoToken(repo),
    );
    return result.items.map(toIssueSummary);
  }

  async getIssue(repo: string, number: number, commentLimit: number) {
    const issue = await this.repoRequest<RawIssue>(repo, `/issues/${number}`);
    const comments =
      commentLimit > 0 && (issue.comments ?? 0) > 0
        ? await this.repoRequest<RawIssueComment[]>(repo, `/issues/${number}/comments?per_page=100`)
        : [];
    return toIssueDetail(issue, comments.slice(-commentLimit));
  }

  async listCommits(repo: string, limit: number) {
    const commits = await this.repoRequest<RawCommit[]>(
      repo,
      `/commits?per_page=${Math.min(100, limit)}`,
    );
    return commits.map(toCommitSummary);
  }
}
