import type { HarnessTopicSuggestion } from "@cos-tool-bot/database";
import { type JSONValue, type Tool, jsonSchema, tool } from "ai";
import { z } from "zod";
import { SUGGESTION_ARGS_LIMIT } from "./assistant-render.js";
import type { HarnessGitHub } from "./github.js";
import { errorText } from "./pr-actions.js";
import type { HarnessService } from "./service.js";
import type { HarnessRequestRecord } from "./store.js";

export const FILE_CHAR_LIMIT = 40_000;
const MAX_SUGGESTIONS = 3;
const SUGGESTABLE = ["bug", "status", "quota"] as const;

export interface AssistantToolContext {
  service: HarnessService;
  /** The topic's project; undefined in General or a topic without a project. */
  fixedProject?: string;
  /** Filled by `propose_command`; becomes the reply's buttons. */
  suggestions: HarnessTopicSuggestion[];
}

class ToolRefusal extends Error {}

const clip = (text: string | null | undefined, max: number) =>
  !text ? (text ?? null) : text.length > max ? `${text.slice(0, max)}…（已截断）` : text;

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

/** Zod validates at runtime; the JSON Schema is what the provider sees. */
function readTool<S extends z.ZodType>(
  description: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): Tool {
  return tool({
    description,
    inputSchema: jsonSchema<z.infer<S>>(
      z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as JSONValue,
      {
        validate: (value) => {
          const parsed = schema.safeParse(value);
          return parsed.success
            ? { success: true, value: parsed.data }
            : { success: false, error: parsed.error };
        },
      },
    ),
    execute: async (input: z.infer<S>) => {
      try {
        return await run(input);
      } catch (error) {
        return { error: error instanceof ToolRefusal ? error.message : errorText(error) };
      }
    },
  });
}

/** `.env`, `.env.local`, `config/.env.prod`, `.envrc`… are never read. */
export function isSecretPath(path: string): boolean {
  return path.split("/").some((segment) => /^\.env/i.test(segment));
}

export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  const replaced = text.match(/\uFFFD/g)?.length ?? 0;
  return replaced > Math.max(8, text.length / 100);
}

const projectField = z.string().max(100).optional().describe("项目 key；项目话题中可省略");
const limitField = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`最多返回条数（≤ ${max}）`);

export function createAssistantTools(ctx: AssistantToolContext): Record<string, Tool> {
  const { service } = ctx;

  const project = (requested: string | undefined) => {
    const keys = service.projectKeys();
    if (ctx.fixedProject && requested && requested !== ctx.fixedProject) {
      throw new ToolRefusal(`本话题只能查询项目 ${ctx.fixedProject}`);
    }
    const key = ctx.fixedProject ?? requested;
    if (!key) throw new ToolRefusal(`请传 project，可选：${keys.join("、")}`);
    const repo = service.file.projects[key]?.repo;
    if (!repo) throw new ToolRefusal(`没有项目 ${key}，可选：${keys.join("、")}`);
    return { key, repo };
  };

  const github = (): HarnessGitHub => {
    if (!service.github?.available) throw new ToolRefusal("GitHub App 未配置，无法查询 GitHub");
    return service.github;
  };

  const describeRequest = async (request: HarnessRequestRecord) => {
    const job = await service.store.latestJob(request.id);
    return {
      id: request.id.slice(0, 8),
      type: request.type,
      state: request.state,
      title: request.title,
      issue: request.issueNumber,
      pr: request.prNumber,
      risk: request.riskTier,
      reason: clip(request.stateReason, 200),
      updatedAt: iso(request.updatedAt),
      job: job
        ? {
            attempt: job.attempt,
            state: job.state,
            machine: job.machineKey,
            agent: job.agent,
            error: clip(job.error, 200),
          }
        : null,
    };
  };

  return {
    harness_requests: readTool(
      "列出 Dev Harness 为该项目处理的请求（/bug 与 PR），含状态、issue/PR 编号和最近一次执行任务。",
      z.object({ project: projectField, limit: limitField(20, 10) }),
      async (input) => {
        const { key } = project(input.project);
        const requests = await service.store.listProjectRequests(key, input.limit);
        return { project: key, requests: await Promise.all(requests.map(describeRequest)) };
      },
    ),

    harness_request: readTool(
      "按 issue 或 PR 编号查看 Dev Harness 请求的详情、执行任务和最近事件。",
      z.object({
        project: projectField,
        issue: z.number().int().positive().optional(),
        pr: z.number().int().positive().optional(),
      }),
      async (input) => {
        const { key, repo } = project(input.project);
        if (!input.issue && !input.pr) throw new ToolRefusal("请传 issue 或 pr 编号");
        const request = input.pr
          ? await service.store.findRequestByPr(repo, input.pr)
          : await service.store.findRequestByIssue(repo, input.issue!);
        if (!request) return { project: key, found: false };
        const events = await service.store.listRequestEvents(request.id, 10);
        return {
          project: key,
          found: true,
          request: {
            ...(await describeRequest(request)),
            ownerText: clip(request.ownerText, 1000),
            summary: request.summary,
            createdAt: iso(request.createdAt),
          },
          events: events.map((event) => ({
            type: event.type,
            at: iso(event.createdAt),
            payload: event.payload ? clip(JSON.stringify(event.payload), 300) : null,
          })),
        };
      },
    ),

    github_issues: readTool(
      "列出仓库的 issue（不含 PR），按更新时间倒序。",
      z.object({
        project: projectField,
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.string().max(200).optional().describe("逗号分隔的标签"),
        limit: limitField(30, 15),
      }),
      async (input) => {
        const { key, repo } = project(input.project);
        const issues = await github().listIssues(repo, input);
        return { project: key, issues };
      },
    ),

    github_pulls: readTool(
      "列出仓库的 PR，按更新时间倒序；state=merged 只返回已合并的。",
      z.object({
        project: projectField,
        state: z.enum(["open", "merged", "closed", "all"]).default("open"),
        limit: limitField(20, 10),
      }),
      async (input) => {
        const { key, repo } = project(input.project);
        const merged = input.state === "merged";
        const pulls = await github().listPullRequests(repo, {
          state: input.state === "merged" ? "closed" : input.state,
          limit: merged ? Math.min(100, input.limit * 3) : input.limit,
        });
        return {
          project: key,
          pulls: (merged ? pulls.filter((pr) => pr.merged) : pulls).slice(0, input.limit),
        };
      },
    ),

    github_search: readTool(
      "在仓库内搜索 issue 和 PR（GitHub 搜索语法，如 `登录 is:open`、`is:pr label:bug`）。",
      z.object({
        project: projectField,
        query: z.string().min(1).max(200),
        limit: limitField(20, 10),
      }),
      async (input) => {
        const { key, repo } = project(input.project);
        return { project: key, items: await github().searchIssues(repo, input.query, input.limit) };
      },
    ),

    github_item: readTool(
      "查看一个 issue 或 PR：标题、状态、标签、正文和最近的评论。",
      z.object({ project: projectField, number: z.number().int().positive() }),
      async (input) => {
        const { key, repo } = project(input.project);
        const item = await github().getIssue(repo, input.number, 8);
        return {
          project: key,
          item: {
            ...item,
            body: clip(item.body, 3000),
            recentComments: item.recentComments.map((comment) => ({
              ...comment,
              body: clip(comment.body, 800),
            })),
          },
        };
      },
    ),

    github_commits: readTool(
      "列出默认分支最近的提交（只含首行说明）。",
      z.object({ project: projectField, limit: limitField(20, 15) }),
      async (input) => {
        const { key, repo } = project(input.project);
        return { project: key, commits: await github().listCommits(repo, input.limit) };
      },
    ),

    repo_list_dir: readTool(
      "列出默认分支上某个目录的文件和子目录；path 为空表示仓库根目录。",
      z.object({ project: projectField, path: z.string().max(300).default("") }),
      async (input) => {
        const { key, repo } = project(input.project);
        const path = input.path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
        const branch = await defaultBranch(key, repo);
        const entries = await github().listDirectory(repo, path, branch);
        if (!entries) return { project: key, error: `目录不存在：${path || "/"}` };
        return {
          project: key,
          path: path || "/",
          ref: branch,
          entries: entries
            .filter((entry) => !isSecretPath(entry.name))
            .slice(0, 200)
            .map((entry) => `${entry.name}${entry.type === "dir" ? "/" : ""}`),
        };
      },
    ),

    repo_read_file: readTool(
      `读取默认分支上的一个文本文件，最多返回 ${FILE_CHAR_LIMIT} 个字符；不能读取 .env 类文件和二进制文件。`,
      z.object({ project: projectField, path: z.string().min(1).max(300) }),
      async (input) => {
        const { key, repo } = project(input.project);
        const path = input.path.replace(/^\.?\/+/, "");
        if (isSecretPath(path)) throw new ToolRefusal(".env 类文件可能含密钥，不能读取");
        const branch = await defaultBranch(key, repo);
        const content = await github().getFile(repo, path, branch);
        if (content === null) throw new ToolRefusal(`文件不存在或不是普通文件：${path}`);
        if (looksBinary(content)) throw new ToolRefusal(`${path} 是二进制文件，无法读取`);
        const truncated = content.length > FILE_CHAR_LIMIT;
        return {
          project: key,
          path,
          ref: branch,
          totalChars: content.length,
          truncated,
          content: truncated ? content.slice(0, FILE_CHAR_LIMIT) : content,
          ...(truncated ? { note: `只返回了前 ${FILE_CHAR_LIMIT} 个字符` } : {}),
        };
      },
    ),

    propose_command: readTool(
      "给 owner 提一个可一键执行的命令建议（生成按钮，owner 点击才执行，你自己不会执行任何东西）。每次回复最多 3 个。",
      z.object({
        command: z.enum(SUGGESTABLE),
        args: z
          .string()
          .max(SUGGESTION_ARGS_LIMIT)
          .default("")
          .describe("命令参数；/bug 的描述第一行是标题"),
        project: projectField.describe("目标项目 key；项目话题中省略，General 中 /bug 必须传"),
      }),
      async (input) => {
        if (ctx.suggestions.length >= MAX_SUGGESTIONS) {
          throw new ToolRefusal(`每次回复最多 ${MAX_SUGGESTIONS} 个建议`);
        }
        const args = input.args.trim();
        if (input.command === "bug" && !args) throw new ToolRefusal("/bug 需要问题描述");
        const target =
          input.project || (input.command === "bug" && !ctx.fixedProject)
            ? project(input.project).key
            : null;
        ctx.suggestions.push({
          command: input.command,
          args,
          project: target && target !== ctx.fixedProject ? target : null,
        });
        return { ok: true, button: ctx.suggestions.length, note: "按钮已生成，点击前不会执行" };
      },
    ),
  };

  async function defaultBranch(key: string, repo: string): Promise<string> {
    return (
      service.projectRecord(key)?.defaultBranch ?? (await github().getDefaultBranch(repo)).branch
    );
  }
}
