import { authFetch } from "@/lib/client";
import type {
  HarnessAdminError,
  HarnessAdminErrorCode,
  HarnessAdminExecution,
  HarnessAdminExecutionView,
  HarnessAdminOverview,
  HarnessAdminPreview,
  HarnessAdminProject,
  HarnessAdminProjectInput,
  HarnessAdminProjectPatch,
  HarnessAdminRepoList,
} from "@cos-tool-bot/shared";

export type HarnessAdminFetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type HarnessAdminIssue = NonNullable<HarnessAdminError["issues"]>[number];
/** `unavailable` covers network failures and responses outside the contract. */
export type HarnessAdminFailureCode = HarnessAdminErrorCode | "unavailable";

export const HARNESS_PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const ERROR_CODES: readonly HarnessAdminErrorCode[] = [
  "not_enabled",
  "forbidden",
  "not_found",
  "conflict",
  "read_only",
  "invalid",
  "github_unavailable",
];

export class HarnessAdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: HarnessAdminFailureCode,
    readonly issues: readonly HarnessAdminIssue[] = [],
  ) {
    super(message);
    this.name = "HarnessAdminApiError";
  }
}

export interface HarnessAdminApi {
  overview(): Promise<HarnessAdminOverview>;
  repos(): Promise<HarnessAdminRepoList>;
  preview(repo: string): Promise<HarnessAdminPreview>;
  createProject(input: HarnessAdminProjectInput): Promise<HarnessAdminProject>;
  updateProject(key: string, patch: HarnessAdminProjectPatch): Promise<HarnessAdminProject>;
  deleteProject(key: string): Promise<void>;
  updateExecution(execution: HarnessAdminExecution): Promise<HarnessAdminExecutionView>;
}

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Body | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function parseIssues(value: unknown): HarnessAdminIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) =>
    isRecord(issue) && typeof issue["path"] === "string" && typeof issue["message"] === "string"
      ? [{ path: issue["path"], message: issue["message"] }]
      : [],
  );
}

function failureFor(response: Response, body: Body | null): HarnessAdminApiError {
  const code = body?.["code"];
  const message = typeof body?.["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
  if (body?.["ok"] === false && ERROR_CODES.includes(code as HarnessAdminErrorCode)) {
    return new HarnessAdminApiError(
      message,
      response.status,
      code as HarnessAdminErrorCode,
      parseIssues(body["issues"]),
    );
  }
  const fallback: HarnessAdminFailureCode =
    response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "unavailable";
  return new HarnessAdminApiError(message, response.status, fallback);
}

const EMPTY_EXECUTION: HarnessAdminExecutionView = {
  effective: { agentConfig: null, model: null, effort: null },
  panel: null,
  agents: null,
};

function parseExecution(value: unknown): HarnessAdminExecutionView | null {
  return isRecord(value) && isRecord(value["effective"])
    ? (value as unknown as HarnessAdminExecutionView)
    : null;
}

function parseOverview(body: Body): HarnessAdminOverview | null {
  if (
    typeof body["enabled"] !== "boolean" ||
    !Array.isArray(body["projects"]) ||
    !Array.isArray(body["machines"])
  ) {
    return null;
  }
  return {
    enabled: body["enabled"],
    configError: typeof body["configError"] === "string" ? body["configError"] : null,
    chatId: typeof body["chatId"] === "number" ? body["chatId"] : null,
    projects: body["projects"] as HarnessAdminProject[],
    machines: body["machines"] as HarnessAdminOverview["machines"],
    execution: parseExecution(body["execution"]) ?? EMPTY_EXECUTION,
    warnings: Array.isArray(body["warnings"])
      ? body["warnings"].filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

function parseRepos(body: Body): HarnessAdminRepoList | null {
  if (!Array.isArray(body["repos"])) return null;
  return {
    repos: body["repos"] as HarnessAdminRepoList["repos"],
    installUrl: typeof body["installUrl"] === "string" ? body["installUrl"] : null,
  };
}

function parsePreview(body: Body): HarnessAdminPreview | null {
  if (
    typeof body["repo"] !== "string" ||
    typeof body["suggestedKey"] !== "string" ||
    typeof body["suggestedLocalProject"] !== "string" ||
    !isRecord(body["policy"])
  ) {
    return null;
  }
  return body as unknown as HarnessAdminPreview;
}

function parseProject(body: Body): HarnessAdminProject | null {
  const project = body["project"];
  return isRecord(project) && typeof project["key"] === "string"
    ? (project as unknown as HarnessAdminProject)
    : null;
}

export function createHarnessAdminApi({
  baseUrl,
  fetcher,
}: {
  baseUrl: string;
  fetcher: HarnessAdminFetcher;
}): HarnessAdminApi {
  async function call<T>(
    path: string,
    parse: (body: Body) => T | null,
    method = "GET",
    payload?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        ...(payload === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
      });
    } catch (error) {
      throw new HarnessAdminApiError(
        error instanceof Error ? error.message : "Network error",
        0,
        "unavailable",
      );
    }
    const body = await readJson(response);
    if (!response.ok || body?.["ok"] !== true) throw failureFor(response, body);
    const parsed = parse(body);
    if (parsed === null) {
      throw new HarnessAdminApiError("Invalid response", response.status, "unavailable");
    }
    return parsed;
  }

  const projectPath = (key: string) => `/projects/${encodeURIComponent(key)}`;
  return {
    overview: () => call("/overview", parseOverview),
    repos: () => call("/repos", parseRepos),
    preview: (repo) => call("/preview", parsePreview, "POST", { repo }),
    createProject: (input) => call("/projects", parseProject, "POST", input),
    updateProject: (key, patch) => call(projectPath(key), parseProject, "PATCH", patch),
    deleteProject: (key) => call(projectPath(key), () => undefined, "DELETE"),
    updateExecution: (execution) =>
      call("/execution", (body) => parseExecution(body["execution"]), "PUT", execution),
  };
}

export function createPanelHarnessAdminApi(fetcher: typeof fetch = authFetch): HarnessAdminApi {
  return createHarnessAdminApi({ baseUrl: "/api/harness/admin", fetcher });
}

export function createMiniAppHarnessAdminApi(
  botId: string,
  csrfToken: string,
  fetcher: typeof fetch = fetch,
): HarnessAdminApi {
  return createHarnessAdminApi({
    baseUrl: `/api/mini-app/${encodeURIComponent(botId)}/harness`,
    fetcher: (input, init) => {
      const headers = new Headers(init?.headers);
      if ((init?.method ?? "GET") !== "GET") headers.set("x-mini-app-csrf", csrfToken);
      return fetcher(input, { ...init, headers, credentials: "same-origin" });
    },
  });
}
