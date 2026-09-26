import { GitHubApiError } from "./github.js";
import type {
  CommitPullRequest,
  CompareResult,
  ReleaseGitHub,
  ReleaseInfo,
  TagInfo,
  WorkflowRunInfo,
} from "./github-release.js";

/** Tags and releases in memory; `createTag` refuses an existing ref like GitHub does. */
export class FakeReleaseGitHub implements ReleaseGitHub {
  tags: TagInfo[] = [];
  releases: ReleaseInfo[] = [];
  commits: Array<{ sha: string; message: string }> = [];
  pullsByCommit: Record<string, CommitPullRequest[]> = {};
  /** Null simulates an App without `actions: read`. */
  runs: WorkflowRunInfo[] | null = [];
  readonly created: Array<{ tag: string; sha: string; message: string }> = [];
  readonly compares: string[] = [];
  createError: Error | null = null;

  async listTags(_repo: string, limit: number) {
    return this.tags.slice(0, limit);
  }

  async getTagRef(_repo: string, tag: string) {
    const found = this.tags.find((candidate) => candidate.name === tag);
    return found ? { sha: found.sha } : null;
  }

  async getReleaseByTag(_repo: string, tag: string) {
    return this.releases.find((release) => release.tag === tag) ?? null;
  }

  async compare(_repo: string, base: string, head: string): Promise<CompareResult> {
    this.compares.push(`${base}...${head}`);
    return {
      status: this.commits.length > 0 ? "ahead" : "identical",
      totalCommits: this.commits.length,
      commits: this.commits,
    };
  }

  async listCommitPullRequests(_repo: string, sha: string) {
    return this.pullsByCommit[sha] ?? [];
  }

  async createTag(_repo: string, input: { tag: string; sha: string; message: string }) {
    if (this.createError) throw this.createError;
    if (this.tags.some((tag) => tag.name === input.tag)) {
      throw new GitHubApiError(422, "Reference already exists");
    }
    this.created.push(input);
    this.tags.unshift({ name: input.tag, sha: input.sha });
    return { sha: "f".repeat(40) };
  }

  async listWorkflowRuns() {
    return this.runs;
  }
}

export function mergedPull(number: number, title: string): CommitPullRequest[] {
  return [
    {
      number,
      title,
      url: `https://github.com/example/pull/${number}`,
      mergedAt: "2026-09-20T00:00:00Z",
      baseRef: "main",
    },
  ];
}
