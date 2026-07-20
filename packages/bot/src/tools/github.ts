import type {
  GitHubCodeTaskInput,
  GitHubCodeTaskResult,
  GitHubCodingModelConfig,
  GitHubPushPreview,
  GitHubPushResult,
  GitHubToolsRuntimeConfig,
} from "@cos-tool-bot/shared";
import type { Tool, ToolExecutionOptions } from "ai";
import { tool } from "ai";
import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { createHash } from "node:crypto";
import { z } from "zod";
import { GitHubApiError, GitHubClient, type GitHubPullRequest } from "../services/github-client.js";
import type { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import { zodToAiSchema } from "./utils.js";

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .describe("GitHub 仓库，格式 owner/repository");
const MAX_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 2_000;
const CONFIRMATION_BODY_PREVIEW_CHARS = 600;

export interface GitHubToolsOptions {
  config: GitHubToolsRuntimeConfig;
  isAdmin: boolean;
  userId: number;
  chatId: number;
  api: Api;
  pendingActions: PendingGitHubActionRegistry;
  fetch?: typeof fetch;
  codeCallbacks?: GitHubCodeCallbacks;
  codingModel?: GitHubCodingModelConfig;
}

export interface GitHubCodeCallbacks {
  runTask: (
    input: GitHubCodeTaskInput,
    model: GitHubCodingModelConfig,
    signal?: AbortSignal,
  ) => Promise<GitHubCodeTaskResult>;
  previewPush: (repository: string, branch: string) => Promise<GitHubPushPreview>;
  pushBranch: (
    repository: string,
    branch: string,
    expectedCommitSha: string,
  ) => Promise<GitHubPushResult>;
}

function normalizedRepositories(config: GitHubToolsRuntimeConfig): Set<string> {
  return new Set(config.repositories.map((repository) => repository.toLowerCase()));
}

function formatError(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function describeBody(body: string | undefined): string {
  if (body === undefined) return "";
  const preview = body.slice(0, CONFIRMATION_BODY_PREVIEW_CHARS);
  if (body.length <= CONFIRMATION_BODY_PREVIEW_CHARS) return `\n正文：${preview || "（清空）"}`;
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return `\n正文前 ${CONFIRMATION_BODY_PREVIEW_CHARS} 字：${preview}\n（完整正文 ${body.length} 字，SHA-256 ${digest}…）`;
}

function describePullRequestBody(body: string | undefined): string {
  const exactBody = body ?? "";
  const preview = exactBody.slice(0, CONFIRMATION_BODY_PREVIEW_CHARS);
  const digest = createHash("sha256").update(exactBody).digest("hex");
  const suffix = exactBody.length > CONFIRMATION_BODY_PREVIEW_CHARS ? "…" : "";
  const label = body === undefined ? "（未提供）" : preview || "（空）";
  return `正文预览：${label}${suffix}\n正文 SHA-256：${digest}`;
}

function pullRequestResult(
  repository: string,
  pull: GitHubPullRequest,
  existing: boolean,
): { summary: string; url: string } {
  return {
    summary: `${existing ? "已存在" : "已创建"} ${repository}#${pull.number}：${pull.title}`,
    url: pull.html_url,
  };
}

export function createGitHubTools(options: GitHubToolsOptions): Record<string, Tool> {
  const allowedRepositories = normalizedRepositories(options.config);
  const anonymousClient = new GitHubClient({ fetch: options.fetch });
  const authenticatedClient = options.config.token
    ? new GitHubClient({ token: options.config.token, fetch: options.fetch })
    : undefined;

  function readClient(repository: string): GitHubClient {
    const allowed = allowedRepositories.has(repository.toLowerCase());
    if (options.isAdmin && allowed && authenticatedClient) return authenticatedClient;
    if (options.config.publicReadEnabled) return anonymousClient;
    throw new Error("GitHub public repository reading is disabled");
  }

  function writeClient(repository: string): GitHubClient {
    if (!options.isAdmin) throw new Error("Only bot administrators can change GitHub");
    if (!allowedRepositories.has(repository.toLowerCase())) {
      throw new Error("Repository is not in the administrator-managed GitHub allowlist");
    }
    if (!authenticatedClient) throw new Error("Ai-chan's GitHub token is not configured");
    return authenticatedClient;
  }

  async function proposeAction(
    description: string,
    execute: () => Promise<{ summary: string; url?: string }>,
  ) {
    const pending = options.pendingActions.register({
      chatId: options.chatId,
      userId: options.userId,
      description,
      execute,
    });
    const keyboard = new InlineKeyboard()
      .text("确认执行", `cos:gh:${pending.id}:yes`)
      .text("取消", `cos:gh:${pending.id}:no`);
    try {
      await options.api.sendMessage(
        options.chatId,
        `🔐 GitHub 管理员确认\n\n${description}\n\n此请求 10 分钟后过期。`,
        { reply_markup: keyboard },
      );
    } catch (error) {
      options.pendingActions.remove(pending.id);
      throw error;
    }
    return { pending_confirmation: true, action_id: pending.id, description };
  }

  const tools: Record<string, Tool> = {
    github_repository: tool({
      description:
        "读取 GitHub 仓库基本信息。普通成员只能匿名读取公开仓库；管理员仅在白名单仓库可使用助手身份读取私有信息。",
      inputSchema: zodToAiSchema(z.object({ repository: repositorySchema })),
      execute: async ({ repository }) => {
        try {
          const repo = await readClient(repository).getRepository(repository);
          return {
            repository: repo.full_name,
            private: repo.private,
            default_branch: repo.default_branch,
            description: repo.description,
            url: repo.html_url,
          };
        } catch (error) {
          return formatError(error);
        }
      },
    }),
    github_read_file: tool({
      description:
        "读取 GitHub 仓库中的文本文件。普通成员只会使用未认证请求，因此无法读取私有仓库。",
      inputSchema: zodToAiSchema(
        z.object({
          repository: repositorySchema,
          path: z.string().min(1).max(500).describe("仓库内文件路径"),
          ref: z.string().max(200).optional().describe("分支、tag 或 commit SHA"),
        }),
      ),
      execute: async ({ repository, path, ref }) => {
        try {
          const file = await readClient(repository).readFile(repository, path, ref);
          return {
            ...file,
            content: file.content.slice(0, MAX_FILE_CHARS),
            truncated: file.content.length > MAX_FILE_CHARS,
          };
        } catch (error) {
          return formatError(error);
        }
      },
    }),
    github_list_tree: tool({
      description: "列出 GitHub 仓库文件树，用于了解代码结构。普通成员只能匿名读取公开仓库。",
      inputSchema: zodToAiSchema(
        z.object({
          repository: repositorySchema,
          ref: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("分支、tag 或 commit SHA；默认仓库主分支"),
        }),
      ),
      execute: async ({ repository, ref }) => {
        try {
          const result = await readClient(repository).listTree(repository, ref);
          return {
            entries: result.tree.slice(0, MAX_TREE_ENTRIES),
            truncated: result.truncated || result.tree.length > MAX_TREE_ENTRIES,
          };
        } catch (error) {
          return formatError(error);
        }
      },
    }),
    github_list_issues: tool({
      description: "列出 GitHub Issue。普通成员只能匿名读取公开仓库。",
      inputSchema: zodToAiSchema(
        z.object({
          repository: repositorySchema,
          state: z.enum(["open", "closed", "all"]).default("open"),
          limit: z.number().int().min(1).max(50).default(20),
        }),
      ),
      execute: async ({ repository, state, limit }) => {
        try {
          const issues = await readClient(repository).listIssues(repository, state, limit);
          return issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.user?.login,
            labels: issue.labels?.map((label) => (typeof label === "string" ? label : label.name)),
            url: issue.html_url,
          }));
        } catch (error) {
          return formatError(error);
        }
      },
    }),
  };

  if (options.isAdmin) {
    if (options.config.codingAgentEnabled && options.codeCallbacks && options.codingModel) {
      tools.github_code_task = tool({
        description:
          "让隔离的 Pi coding agent 在白名单仓库创建或继续本地分支，修改代码、运行测试并创建本地 commit。只对管理员开放；不会推送到 GitHub。",
        inputSchema: zodToAiSchema(
          z.object({
            repository: repositorySchema,
            task: z.string().min(1).max(20_000).describe("清晰、完整的编码任务"),
            branch: z.string().min(1).max(200).describe("要创建或继续的本地分支"),
            base_ref: z.string().min(1).max(200).optional().describe("新分支的远端基础分支"),
            commit_message: z.string().min(1).max(200).optional().describe("本地提交信息"),
          }),
        ),
        execute: async (
          { repository, task, branch, base_ref, commit_message },
          execution: ToolExecutionOptions,
        ) => {
          try {
            writeClient(repository);
            return await options.codeCallbacks!.runTask(
              {
                repository,
                task,
                branch,
                baseRef: base_ref,
                commitMessage: commit_message,
              },
              options.codingModel!,
              execution.abortSignal,
            );
          } catch (error) {
            if (execution.abortSignal?.aborted) throw error;
            return formatError(error);
          }
        },
      });

      tools.github_push_branch = tool({
        description:
          "提议把 Pi 已创建的本地分支推送到 GitHub。只对管理员开放，实际 push 前必须由发起管理员点击 Telegram 确认按钮。",
        inputSchema: zodToAiSchema(
          z.object({
            repository: repositorySchema,
            branch: z.string().min(1).max(200),
          }),
        ),
        execute: async ({ repository, branch }) => {
          try {
            writeClient(repository);
            const preview = await options.codeCallbacks!.previewPush(repository, branch);
            return await proposeAction(
              `推送 ${repository}:${branch}\n本地 commit：${preview.commitSha}`,
              () => options.codeCallbacks!.pushBranch(repository, branch, preview.commitSha),
            );
          } catch (error) {
            return formatError(error);
          }
        },
      });
    }

    tools.github_create_pull_request = tool({
      description:
        "提议在同一 GitHub 仓库的两个分支间创建 Pull Request。只对管理员开放；创建前会绑定远端 head commit，并要求 Telegram 确认。",
      inputSchema: zodToAiSchema(
        z.object({
          repository: repositorySchema,
          head: z.string().min(1).max(200).describe("同一仓库内的来源分支"),
          base: z.string().min(1).max(200).describe("同一仓库内的目标分支"),
          title: z.string().min(1).max(256),
          body: z.string().max(65_536).optional(),
          draft: z.boolean().default(false),
        }),
      ),
      execute: async ({ repository, head, base, title, body, draft }) => {
        try {
          const isDraft = draft === true;
          const client = writeClient(repository);
          const headRef = await client.resolveBranch(repository, head);
          const baseRef = await client.resolveBranch(repository, base);
          const description = [
            `在 ${repository} 创建 Pull Request`,
            `${head} -> ${base}`,
            `标题：${title}`,
            `草稿：${isDraft ? "是" : "否"}`,
            `Head SHA：${headRef.sha}`,
            `Base SHA（仅校验分支存在）：${baseRef.sha}`,
            describePullRequestBody(body),
          ].join("\n");

          return await proposeAction(description, async () => {
            const currentHead = await client.resolveBranch(repository, head);
            if (currentHead.sha !== headRef.sha) {
              throw new Error(
                `Pull request source changed after confirmation preview (${headRef.sha} -> ${currentHead.sha}); request a new preview`,
              );
            }

            const existing = await client.findOpenPullRequest(repository, head, base);
            if (existing) {
              if (existing.head.sha !== headRef.sha) {
                throw new Error(
                  `Pull request source changed while checking existing requests (${headRef.sha} -> ${existing.head.sha}); request a new preview`,
                );
              }
              return pullRequestResult(repository, existing, true);
            }

            try {
              const created = await client.createPullRequest(repository, {
                title,
                head,
                base,
                body,
                draft: isDraft,
                expectedHeadSha: headRef.sha,
              });
              return pullRequestResult(repository, created, false);
            } catch (error) {
              // GitHub cannot atomically combine duplicate lookup, head-SHA binding, and creation.
              // Re-read first so a concurrent creator or a timed-out successful POST is idempotent.
              const raced = await client
                .findOpenPullRequest(repository, head, base)
                .catch(() => undefined);
              if (raced?.head.sha === headRef.sha) {
                return pullRequestResult(repository, raced, true);
              }
              if (error instanceof GitHubApiError && error.status === 403) throw error;
              const safeMessage =
                error instanceof GitHubApiError ? error.message : "GitHub request failed";
              throw new Error(
                `${safeMessage}. No pull request URL was verified; GitHub creation is non-atomic, so check the repository before retrying`,
              );
            }
          });
        } catch (error) {
          return formatError(error);
        }
      },
    });

    tools.github_create_issue = tool({
      description:
        "提议创建 GitHub Issue。只对管理员开放，实际创建前必须由发起管理员点击 Telegram 确认按钮。",
      inputSchema: zodToAiSchema(
        z.object({
          repository: repositorySchema,
          title: z.string().min(1).max(256),
          body: z.string().max(65_536).optional(),
        }),
      ),
      execute: async ({ repository, title, body }) => {
        try {
          const client = writeClient(repository);
          return await proposeAction(
            `在 ${repository} 创建 Issue\n标题：${title}${describeBody(body)}`,
            async () => {
              const issue = await client.createIssue(repository, { title, body });
              return {
                summary: `已创建 ${repository}#${issue.number}：${issue.title}`,
                url: issue.html_url,
              };
            },
          );
        } catch (error) {
          return formatError(error);
        }
      },
    });

    tools.github_update_issue = tool({
      description:
        "提议更新或关闭 GitHub Issue。只对管理员开放，实际变更前必须由发起管理员点击 Telegram 确认按钮。",
      inputSchema: zodToAiSchema(
        z
          .object({
            repository: repositorySchema,
            issue_number: z.number().int().positive(),
            title: z.string().min(1).max(256).optional(),
            body: z.string().max(65_536).optional(),
            state: z.enum(["open", "closed"]).optional(),
          })
          .refine((value) => value.title || value.body !== undefined || value.state, {
            message: "At least one Issue field must be changed",
          }),
      ),
      execute: async ({ repository, issue_number, title, body, state }) => {
        try {
          const client = writeClient(repository);
          const changes = [
            title ? `\n新标题：${title}` : "",
            state ? `\n新状态：${state}` : "",
            describeBody(body),
          ].join("");
          return await proposeAction(`更新 ${repository}#${issue_number}${changes}`, async () => {
            const issue = await client.updateIssue(repository, issue_number, {
              title,
              body,
              state,
            });
            return {
              summary: `已更新 ${repository}#${issue.number}：${issue.title}`,
              url: issue.html_url,
            };
          });
        } catch (error) {
          return formatError(error);
        }
      },
    });
  }

  return tools;
}
