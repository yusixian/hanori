import type { ModelCapability, ModelEntry } from "./ai-providers.js";

/** Runtime model configuration passed to the isolated coding worker for one tool call. */
export interface GitHubCodingModelConfig {
  apiKey: string;
  baseURL: string;
  id: string;
  providerFormat: "openai" | "gemini";
  maxTokens?: number;
  capabilities: ModelCapability[];
  thinking?: ModelEntry["thinking"];
}

/** GitHub access persisted with a bot. The token is encrypted before this reaches storage. */
export interface GitHubToolsConfigStored {
  enabled: boolean;
  publicReadEnabled: boolean;
  codingAgentEnabled: boolean;
  /** Only Issue creation: omitted/null never expires; a positive integer is minutes. */
  createIssueConfirmationTtlMinutes?: number | null;
  /** Optional dedicated provider for coding tasks. Omitted to follow the active chat provider. */
  codingProviderId?: string;
  /** Optional dedicated model within codingProviderId. Omitted to use that provider's default. */
  codingModelId?: string;
  encryptedToken?: string;
  /** GitHub App installation metadata. Installation access tokens are never persisted. */
  githubAppInstallation?: GitHubAppInstallationStored;
  login?: string;
  authorName: string;
  authorEmail: string;
  /** owner/repository entries that administrators may access with the configured identity. */
  repositories: string[];
}

export interface GitHubAppInstallationStored {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  permissions: Record<string, string>;
  connectedAt: string;
}

/** GitHub access returned to the general AI settings panel. Installation details use admin routes. */
export interface GitHubToolsConfigPublic extends Omit<
  GitHubToolsConfigStored,
  "encryptedToken" | "githubAppInstallation"
> {
  hasToken: boolean;
}

/** Decrypted, in-memory-only configuration used by the bot runtime. */
export interface GitHubToolsRuntimeConfig extends Omit<GitHubToolsConfigStored, "encryptedToken"> {
  token?: string;
  /** Resolves a short-lived GitHub App installation token immediately before an operation. */
  tokenProvider?: () => Promise<string | undefined>;
}

export interface GitHubCodeTaskInput {
  repository: string;
  task: string;
  branch: string;
  baseRef?: string;
  commitMessage?: string;
}

export interface GitHubCodeTaskResult {
  repository: string;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  summary: string;
  status: "committed" | "no_changes";
}

export interface GitHubPushPreview {
  repository: string;
  branch: string;
  commitSha: string;
  remoteCommitSha?: string;
}

export interface GitHubPushResult {
  summary: string;
  url?: string;
}

export interface GitHubWorkspaceInspection {
  repository: string;
  branch: string;
  headSha: string;
  clean: boolean;
  changedFiles: string[];
  fingerprint: string;
}

export interface GitHubWorkspaceResumeInput {
  repository: string;
  task: string;
  commitMessage?: string;
}

export interface GitHubWorkspaceDiscardResult {
  repository: string;
  branch: string;
  headSha: string;
  clean: boolean;
  remainingFiles: string[];
  summary: string;
}

export type GitHubIssueProposalStatus =
  | "pending"
  | "executing"
  | "completed"
  | "cancelled"
  | "expired"
  | "superseded"
  | "result_unknown"
  | "not_executed";

export interface GitHubIssueProposal {
  id: string;
  botId: string;
  chatId: number;
  threadId: number | null;
  initiator: number;
  repository: string;
  title: string;
  body: string;
  hash: string;
  createdAt: number;
  expiresAt: number | null;
  status: GitHubIssueProposalStatus;
  result?: { summary: string; url: string };
}

export interface GitHubIssueProposalActor {
  chatId: number;
  threadId?: number;
  userId: number;
}

/** Tenant-bound server port. No credential or executable closure is persisted. */
export interface GitHubIssueProposalPort {
  propose(
    input: GitHubIssueProposalActor & {
      repository: string;
      title: string;
      body?: string;
    },
  ): Promise<GitHubIssueProposal>;
  list(actor: GitHubIssueProposalActor): Promise<GitHubIssueProposal[]>;
  decide(
    id: string,
    actor: GitHubIssueProposalActor,
    decision: "confirm" | "cancel" | "verify",
  ): Promise<GitHubIssueProposal>;
}
