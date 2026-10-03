import type {
  PluginConfigPublic,
  PluginConfigUpdate,
  PluginConfiguration,
  PluginManifest,
} from "./plugins.js";
import type { SearchProvider } from "./search.js";
import type { PluginLoginAttempt } from "./plugin-login.js";

/** A trusted plugin executes with host-process privileges. This is an integration contract, not a sandbox. */
export interface PluginActor {
  botId: string;
  chatId: number;
  threadId?: number;
  userId?: number;
  isAdmin: boolean;
  isPrivate: boolean;
  readOnly: boolean;
}

export interface PluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: "read_only" | "mutating";
  access: "all" | "admin";
  /** Validate arguments before use. Never return credentials or private provider URLs. */
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface PluginSession {
  tools?: readonly PluginTool[];
  searchProviders?: readonly SearchProvider[];
  dispose?(): void | Promise<void>;
}

export interface PluginContext {
  actor: Readonly<PluginActor>;
  configuration: Readonly<PluginConfiguration>;
  /** Aborted when this session closes, its configuration changes, or the plugin stops. */
  signal: AbortSignal;
}

/** Default export of a prebuilt index.mjs; its metadata lives in hanori.plugin.json. */
export interface PluginDefinition {
  apiVersion: 1;
  createSession(context: PluginContext): PluginSession | Promise<PluginSession>;
  check?(context: PluginContext): Promise<{ success: boolean }>;
  /** Optional QR login declared by manifest.login; credentials stay in the host. */
  startLogin?(signal: AbortSignal): Promise<PluginLoginAttempt>;
}

export interface PluginTurnSession {
  tools: readonly PluginTool[];
  searchProviders: readonly SearchProvider[];
  dispose(): Promise<void>;
}

export interface PluginRuntimePort {
  createSession(actor: PluginActor, signal?: AbortSignal): Promise<PluginTurnSession>;
}

export interface PluginCatalogEntry {
  manifest: PluginManifest;
  source: "builtin" | "git";
  installed: boolean;
  repository: string | null;
  commit: string | null;
  previousCommit: string | null;
  revision: number;
}

export interface PluginBotState {
  configuration: PluginConfigPublic;
  revision: number;
  manifestHash: string;
  configuredVersion: string | null;
  enabled: boolean;
  needsReview: boolean;
  updatedAt: string | null;
  runtime: { status: "disabled" | "ready" | "needs_review" | "error"; error: string | null };
}

export interface PluginBotUpdate {
  expectedRevision: number;
  manifestHash: string;
  configuration?: PluginConfigUpdate;
  enabled?: boolean;
}

export type PluginInstallRequest =
  | { builtinId: string; trustHostAccess: true }
  | { repository: string; commit: string; trustHostAccess: true };
