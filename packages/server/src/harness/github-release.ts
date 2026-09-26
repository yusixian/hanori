const MAX_TAG_PAGES = 5;
const RELEASE_SCAN = 30;
const RUN_SCAN = 30;
const MAX_COMPARE_COMMITS = 1_000;
const COMPARE_PAGE_SIZE = 100;

export interface TagInfo {
  name: string;
  /** The commit the tag points to. */
  sha: string;
}

export interface ReleaseInfo {
  tag: string;
  url: string;
  draft: boolean;
  prerelease: boolean;
}

export interface CompareResult {
  status: "ahead" | "behind" | "identical" | "diverged";
  totalCommits: number;
  /** Oldest first; a bounded, complete comparison (partial results are rejected). */
  commits: Array<{ sha: string; message: string }>;
}

export interface CommitPullRequest {
  number: number;
  title: string;
  url: string;
  mergedAt: string | null;
  baseRef: string;
}

export interface WorkflowRunInfo {
  id: number;
  name: string | null;
  path: string | null;
  headBranch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  updatedAt: string | null;
}

/** Tags, releases, and Actions reads behind `/release`; tags are only ever created. */
export interface ReleaseGitHub {
  /** In GitHub's order, at most `limit`. */
  listTags(repo: string, limit: number): Promise<TagInfo[]>;
  /** The target commit SHA (peeling annotated tags), or null when the tag does not exist. */
  getTagRef(repo: string, tag: string): Promise<{ sha: string } | null>;
  /** Drafts included; null when there is none for the tag. */
  getReleaseByTag(repo: string, tag: string): Promise<ReleaseInfo | null>;
  compare(repo: string, base: string, head: string): Promise<CompareResult>;
  listCommitPullRequests(repo: string, sha: string): Promise<CommitPullRequest[]>;
  /** An annotated tag object plus `refs/tags/<tag>`; fails when the ref already exists. */
  createTag(
    repo: string,
    input: { tag: string; sha: string; message: string },
  ): Promise<{ sha: string }>;
  /** Push-event runs for the commit; null when the App cannot read Actions. */
  listWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRunInfo[] | null>;
}

export type RepoRequest = <T>(repo: string, path: string, init?: RequestInit) => Promise<T>;

export function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

const refPath = (tag: string) => tag.split("/").map(encodeURIComponent).join("/");

async function orNull<T>(read: Promise<T>, statuses: readonly number[] = [404]) {
  try {
    return await read;
  } catch (error) {
    if (statuses.includes(httpStatus(error) ?? 0)) return null;
    throw error;
  }
}

interface RawRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const toRelease = (raw: RawRelease): ReleaseInfo => ({
  tag: raw.tag_name,
  url: raw.html_url,
  draft: raw.draft,
  prerelease: raw.prerelease,
});

export function createReleaseGitHub(request: RepoRequest): ReleaseGitHub {
  return {
    async listTags(repo, limit) {
      const tags: TagInfo[] = [];
      for (let page = 1; page <= MAX_TAG_PAGES && tags.length < limit; page++) {
        const batch = await request<Array<{ name: string; commit: { sha: string } }>>(
          repo,
          `/tags?per_page=100&page=${page}`,
        );
        tags.push(...batch.map((tag) => ({ name: tag.name, sha: tag.commit.sha })));
        if (batch.length < 100) break;
      }
      return tags.slice(0, limit);
    },

    async getTagRef(repo, tag) {
      type Ref = { object: { type: string; sha: string } };
      const ref = await orNull(request<Ref>(repo, `/git/ref/tags/${refPath(tag)}`));
      if (!ref) return null;
      let object = ref.object;
      for (let depth = 0; depth < 5 && object.type === "tag"; depth++) {
        ({ object } = await request<Ref>(repo, `/git/tags/${encodeURIComponent(object.sha)}`));
      }
      if (object.type !== "commit") throw new Error("无法确认 tag 指向的提交");
      return { sha: object.sha };
    },

    async getReleaseByTag(repo, tag) {
      const published = await orNull(
        request<RawRelease>(repo, `/releases/tags/${encodeURIComponent(tag)}`),
      );
      if (published) return toRelease(published);
      const recent = await request<RawRelease[]>(repo, `/releases?per_page=${RELEASE_SCAN}`);
      const draft = recent.find((release) => release.tag_name === tag);
      return draft ? toRelease(draft) : null;
    },

    async compare(repo, base, head) {
      const commits: CompareResult["commits"] = [];
      for (let page = 1; page <= MAX_COMPARE_COMMITS / COMPARE_PAGE_SIZE; page++) {
        const result = await request<{
          status: CompareResult["status"];
          total_commits: number;
          commits: Array<{ sha: string; commit: { message: string } }>;
        }>(
          repo,
          `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
        );
        if (result.total_commits > MAX_COMPARE_COMMITS) {
          throw new Error(`发版范围超过 ${MAX_COMPARE_COMMITS} 个提交，请先手动核对发版范围`);
        }
        commits.push(
          ...result.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message,
          })),
        );
        if (commits.length === result.total_commits) {
          return { status: result.status, totalCommits: result.total_commits, commits };
        }
        if (result.commits.length !== COMPARE_PAGE_SIZE) break;
      }
      throw new Error("未能读取完整提交范围，请稍后重试");
    },

    async listCommitPullRequests(repo, sha) {
      const pulls = await request<
        Array<{
          number: number;
          title: string;
          html_url: string;
          merged_at: string | null;
          base: { ref: string };
        }>
      >(repo, `/commits/${encodeURIComponent(sha)}/pulls`);
      return pulls.map((pull) => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        mergedAt: pull.merged_at,
        baseRef: pull.base.ref,
      }));
    },

    async createTag(repo, input) {
      const tag = await request<{ sha: string }>(repo, "/git/tags", {
        method: "POST",
        body: JSON.stringify({
          tag: input.tag,
          message: input.message,
          object: input.sha,
          type: "commit",
        }),
      });
      await request<unknown>(repo, "/git/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/tags/${input.tag}`, sha: tag.sha }),
      });
      return { sha: tag.sha };
    },

    async listWorkflowRuns(repo, headSha) {
      const params = new URLSearchParams({
        head_sha: headSha,
        event: "push",
        per_page: String(RUN_SCAN),
      });
      const result = await orNull(
        request<{
          workflow_runs: Array<{
            id: number;
            name?: string | null;
            path?: string | null;
            head_branch?: string | null;
            event: string;
            status: string;
            conclusion: string | null;
            html_url: string;
            updated_at?: string | null;
          }>;
        }>(repo, `/actions/runs?${params}`),
        [403, 404],
      );
      if (!result) return null;
      return result.workflow_runs.map((run) => ({
        id: run.id,
        name: run.name ?? null,
        path: run.path ?? null,
        headBranch: run.head_branch ?? null,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        updatedAt: run.updated_at ?? null,
      }));
    },
  };
}
