import type { HarnessBotPort, HarnessTelegram } from "@cos-tool-bot/bot";
import { KeyedAsyncLock } from "../services/keyed-async-lock.js";
import { handleIssueEvent } from "./bug.js";
import { handleHarnessCallback } from "./callbacks.js";
import { handleHarnessCommand } from "./commands.js";
import { type ConfigIssue, type ConfigLayer, formatIssues } from "./config/layers.js";
import {
  type ConfigValidation,
  type LoadedHarnessConfig,
  loadHarnessConfigFile,
  parseRepoPolicy,
} from "./config/loader.js";
import {
  type HarnessOverride,
  resolveGlobalConfig,
  resolveProjectConfig,
} from "./config/resolve.js";
import {
  type HarnessFileConfig,
  type ProjectEffectiveConfig,
  resolveThreadSetting,
} from "./config/schema.js";
import { durationMs } from "./config/units.js";
import type { HarnessGitHub } from "./github.js";
import { LodyCli } from "./lody.js";
import { HarnessPrActions } from "./pr-actions.js";
import { HarnessPrFlow } from "./pr-flow.js";
import { handleIssueComment, handleOwnerReply } from "./protocol.js";
import { renderUsageHint } from "./render.js";
import type { HarnessEventInput, HarnessProjectRecord, HarnessStore } from "./store.js";
import type { PrSummarizer } from "./summary.js";
import {
  type GitHubWebhookRequest,
  type GitHubWebhookResponse,
  handleGitHubWebhook,
} from "./webhook.js";
import { HarnessWork } from "./work.js";

export const REPO_POLICY_PATH = ".cos/harness.yml";

/** Satisfied by DbLogger, so harness diagnostics also land in the panel's system log. */
export interface HarnessLogger {
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface HarnessServiceOptions {
  configPath: string;
  store: HarnessStore;
  github: HarnessGitHub | null;
  logger: HarnessLogger;
  summarizer?: PrSummarizer;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  loadConfig?: (path: string) => Promise<ConfigValidation>;
  createLody?: (command: string[], timeoutMs: number) => LodyCli;
}

export interface ScopedView<T> {
  config: T;
  layers: ConfigLayer[];
  /** Set when stored overrides no longer validate and were ignored. */
  overrideIssues?: ConfigIssue[];
}

export class HarnessService {
  readonly store: HarnessStore;
  readonly github: HarnessGitHub | null;
  readonly logger: HarnessServiceOptions["logger"];
  readonly summarizer?: PrSummarizer;
  readonly prFlow: HarnessPrFlow;
  readonly prActions: HarnessPrActions;
  readonly work: HarnessWork;
  private readonly configPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly loadConfig: (path: string) => Promise<ConfigValidation>;
  private readonly createLody: (command: string[], timeoutMs: number) => LodyCli;
  private readonly applyLock = new KeyedAsyncLock();
  private loaded: LoadedHarnessConfig | null = null;
  private reloadError: { at: Date; issues: ConfigIssue[] } | null = null;
  private overrides: HarnessOverride[] = [];
  private projectRecords = new Map<string, HarnessProjectRecord>();
  private telegramClient: HarnessTelegram | null = null;
  private boundBot: { id: string; name: string } | null = null;
  private lodyClient: { key: string; cli: LodyCli } | null = null;

  constructor(options: HarnessServiceOptions) {
    this.configPath = options.configPath;
    this.store = options.store;
    this.github = options.github;
    this.logger = options.logger;
    this.summarizer = options.summarizer;
    this.env = options.env ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.loadConfig = options.loadConfig ?? ((path) => loadHarnessConfigFile(path, this.clock()));
    this.createLody =
      options.createLody ?? ((command, timeoutMs) => new LodyCli(command, timeoutMs));
    this.prFlow = new HarnessPrFlow(this);
    this.prActions = new HarnessPrActions(this, this.prFlow);
    this.work = new HarnessWork(this);
  }

  now(): Date {
    return this.clock();
  }

  get active(): boolean {
    return this.loaded !== null;
  }

  get loadedConfig(): LoadedHarnessConfig | null {
    return this.loaded;
  }

  get lastReloadError() {
    return this.reloadError;
  }

  get telegram(): HarnessTelegram | null {
    return this.telegramClient;
  }

  get botId(): string | null {
    return this.boundBot?.id ?? null;
  }

  get botName(): string | null {
    return this.boundBot?.name ?? null;
  }

  get configFilePath(): string {
    return this.configPath;
  }

  readEnv(name: string): string | undefined {
    return this.env[name] || undefined;
  }

  async init(): Promise<boolean> {
    this.overrides = await this.store.listOverrides();
    this.projectRecords = new Map((await this.store.listProjects()).map((row) => [row.key, row]));
    const result = await this.loadConfig(this.configPath);
    if (!result.ok) {
      this.reloadError = { at: this.now(), issues: result.issues };
      this.logger.error(`Dev Harness disabled: invalid config\n${formatIssues(result.issues)}`);
      return false;
    }
    this.loaded = result.config;
    return true;
  }

  /** Binds the harness to the Bot named by `telegram.bot` (id or name); one Bot at most. */
  claimBot(bot: { id: string; name: string }): HarnessBotPort | undefined {
    const ref = this.loaded?.file.telegram.bot;
    if (!ref || (bot.id !== ref && bot.name !== ref)) return undefined;
    if (this.boundBot && this.boundBot.id !== bot.id) {
      this.logger.warn(`Dev Harness already bound to Bot ${this.boundBot.id}; ignoring ${bot.id}`);
      return undefined;
    }
    this.boundBot = { id: bot.id, name: bot.name };
    return this.port;
  }

  readonly port: HarnessBotPort = {
    isHarnessChat: (chatId) => this.loaded?.file.telegram.chatId === chatId,
    isOwner: (userId) => this.loaded?.file.telegram.owners.includes(userId) ?? false,
    allowsCasualReplies: () =>
      this.loaded ? this.globalView().config.telegram.chat.casualReplies : false,
    usageHint: (threadId) => renderUsageHint(this.projectKeyForThread(threadId)),
    onBotReady: (telegram) => {
      this.telegramClient = telegram;
      void this.apply()
        .then(() => this.work.scheduler.start())
        .catch((error) =>
          this.logger.error(`Dev Harness apply failed: ${(error as Error).message}`),
        );
    },
    handleCommand: (request) => handleHarnessCommand(this, request),
    handleCallback: (request) => handleHarnessCallback(this, request),
    handleReply: (request) => handleOwnerReply(this.work, request),
  };

  stop(): void {
    this.work.scheduler.stop();
  }

  private requireConfig(): LoadedHarnessConfig {
    if (!this.loaded) throw new Error("Dev Harness config is not loaded");
    return this.loaded;
  }

  get file(): HarnessFileConfig {
    return this.requireConfig().file;
  }

  get overrideList(): readonly HarnessOverride[] {
    return this.overrides;
  }

  globalView(): ScopedView<HarnessFileConfig> {
    const { raw, file } = this.requireConfig();
    const resolved = resolveGlobalConfig(raw, this.overrides, this.now());
    if (resolved.ok) return { config: resolved.value, layers: resolved.layers };
    const fallback = resolveGlobalConfig(raw, [], this.now());
    return {
      config: file,
      layers: fallback.layers,
      overrideIssues: resolved.issues,
    };
  }

  projectKeys(): string[] {
    return this.loaded ? Object.keys(this.loaded.file.projects) : [];
  }

  projectRecord(key: string): HarnessProjectRecord | undefined {
    return this.projectRecords.get(key);
  }

  projectView(
    key: string,
    overrides: readonly HarnessOverride[] = this.overrides,
  ): ScopedView<ProjectEffectiveConfig> | null {
    const loaded = this.requireConfig();
    if (!loaded.file.projects[key]) return null;
    const input = {
      raw: loaded.raw,
      projectKey: key,
      policy: this.projectRecords.get(key)?.policy ?? null,
      overrides,
      now: this.now(),
    };
    const resolved = resolveProjectConfig(input);
    if (resolved.ok) return { config: resolved.value, layers: resolved.layers };
    for (const fallback of [
      { ...input, overrides: [] },
      { ...input, overrides: [], policy: null },
    ]) {
      const retry = resolveProjectConfig(fallback);
      if (retry.ok) {
        return { config: retry.value, layers: retry.layers, overrideIssues: resolved.issues };
      }
    }
    return null;
  }

  projectKeyForThread(threadId: number | undefined): string | undefined {
    if (threadId === undefined || !this.loaded) return undefined;
    const chatId = this.loaded.file.telegram.chatId;
    return this.projectKeys().find((key) => {
      const record = this.projectRecords.get(key);
      return record?.chatId === chatId && record.threadId === threadId;
    });
  }

  projectKeyForRepo(repo: string): string | undefined {
    if (!this.loaded) return undefined;
    const wanted = repo.toLowerCase();
    return this.projectKeys().find(
      (key) => this.loaded!.file.projects[key]!.repo.toLowerCase() === wanted,
    );
  }

  projectThread(key: string): number | undefined {
    const record = this.projectRecords.get(key);
    return record && record.chatId === this.loaded?.file.telegram.chatId
      ? (record.threadId ?? undefined)
      : undefined;
  }

  lody(): LodyCli {
    const lody = this.globalView().config.executors.lody;
    const command = typeof lody.cli === "string" ? [lody.cli] : lody.cli;
    const key = JSON.stringify([command, lody.timeout]);
    if (this.lodyClient?.key !== key) {
      this.lodyClient = { key, cli: this.createLody(command, durationMs(lody.timeout)) };
    }
    return this.lodyClient.cli;
  }

  async recordEvent(event: HarnessEventInput): Promise<void> {
    try {
      await this.store.recordEvent(event);
    } catch (error) {
      this.logger.warn(`Dev Harness event ${event.type} not recorded: ${(error as Error).message}`);
    }
  }

  setOverrides(next: HarnessOverride[]): void {
    this.overrides = next;
  }

  async handleGitHubWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse> {
    if (!this.loaded) return { status: 503, body: { ok: false, error: "harness not loaded" } };
    return handleGitHubWebhook(
      {
        secret: this.readEnv(this.globalView().config.github.webhookSecretEnv),
        store: this.store,
        projectForRepo: (repo) => this.projectKeyForRepo(repo),
        rememberInstallation: (repo, id) => this.github?.rememberInstallation(repo, id),
        dispatch: (event, payload, key) => this.dispatchWebhook(event, payload, key),
        onDispatchError: (error, event, key) =>
          this.logger.error(`Dev Harness ${event} for ${key} failed: ${(error as Error).message}`),
      },
      request,
    );
  }

  private dispatchWebhook(event: string, payload: Record<string, unknown>, projectKey: string) {
    if (event === "issues") return handleIssueEvent(this.work, payload, projectKey);
    if (event === "issue_comment") return handleIssueComment(this.work, payload, projectKey);
    return this.prFlow.handleWebhookEvent(event, payload, projectKey);
  }

  async reload(actorId?: number): Promise<{ ok: true } | { ok: false; issues: ConfigIssue[] }> {
    const result = await this.loadConfig(this.configPath);
    if (!result.ok) {
      this.reloadError = { at: this.now(), issues: result.issues };
      await this.recordEvent({
        type: "config.reload_failed",
        actorId,
        payload: { issues: result.issues.slice(0, 20) },
      });
      return { ok: false, issues: result.issues };
    }
    const previousBot = this.loaded?.file.telegram.bot;
    this.loaded = result.config;
    this.reloadError = null;
    this.overrides = await this.store.listOverrides();
    await this.recordEvent({
      type: "config.reloaded",
      actorId,
      payload: { botChanged: previousBot !== result.config.file.telegram.bot },
    });
    await this.apply();
    return { ok: true };
  }

  /** Idempotent: creates missing topics once, pins fixed topics, and refreshes repo policies. */
  apply(): Promise<void> {
    return this.applyLock.run("apply", async () => {
      if (!this.loaded) return;
      const now = this.now();
      if ((await this.store.deleteExpiredOverrides(now)) > 0) {
        this.overrides = await this.store.listOverrides();
      }
      const chatId = this.loaded.file.telegram.chatId;
      await this.telegramClient?.setChatCommands(chatId).catch((error: Error) => {
        this.logger.warn(`Dev Harness chat commands not set: ${error.message}`);
      });
      for (const key of this.projectKeys()) {
        await this.ensureTopic(key, chatId);
        await this.refreshPolicy(key);
      }
    });
  }

  private async saveProject(key: string, patch: Partial<HarnessProjectRecord>) {
    const repo = this.file.projects[key]!.repo;
    await this.store.upsertProject(key, repo, patch);
    const now = this.now();
    const current = this.projectRecords.get(key);
    this.projectRecords.set(key, {
      key,
      repo,
      chatId: null,
      threadId: null,
      topicError: null,
      installationId: null,
      defaultBranch: null,
      kind: null,
      policy: null,
      policySha: null,
      policyError: null,
      policyFetchedAt: null,
      createdAt: now,
      ...current,
      ...patch,
      updatedAt: now,
    });
  }

  private async ensureTopic(key: string, chatId: number) {
    const setting = resolveThreadSetting(this.file.projects[key]!.topic);
    const record = this.projectRecords.get(key);
    if (setting.mode === "fixed") {
      if (record?.chatId !== chatId || record.threadId !== setting.threadId) {
        await this.saveProject(key, { chatId, threadId: setting.threadId, topicError: null });
      }
      return;
    }
    if (record?.chatId === chatId && record.threadId) return;
    if (!this.telegramClient) return;
    try {
      const threadId = await this.telegramClient.createForumTopic(chatId, key);
      await this.saveProject(key, { chatId, threadId, topicError: null });
      await this.recordEvent({ type: "topic.created", projectKey: key, payload: { threadId } });
    } catch (error) {
      const message = (error as Error).message.slice(0, 300);
      await this.saveProject(key, { topicError: message });
      await this.recordEvent({ type: "topic.failed", projectKey: key, payload: { message } });
      this.logger.warn(`Dev Harness topic for ${key} not created: ${message}`);
    }
  }

  /** Repo policy is read from the default branch only; a failed read keeps the last good one. */
  async refreshPolicy(key: string): Promise<void> {
    if (!this.github?.available) return;
    const repo = this.file.projects[key]!.repo;
    try {
      const head = await this.github.getDefaultBranch(repo);
      const text = await this.github.getFile(repo, REPO_POLICY_PATH, head.sha);
      const base = { defaultBranch: head.branch, policyFetchedAt: this.now() };
      if (text === null) {
        await this.saveProject(key, {
          ...base,
          policy: null,
          policySha: head.sha,
          kind: null,
          policyError: null,
        });
        return;
      }
      const parsed = parseRepoPolicy(text);
      const merged = parsed.ok
        ? resolveProjectConfig({
            raw: this.requireConfig().raw,
            projectKey: key,
            policy: parsed.raw,
            overrides: [],
            now: this.now(),
          })
        : parsed;
      if (!parsed.ok || !merged.ok) {
        const issues = merged.ok ? [] : merged.issues;
        await this.saveProject(key, { ...base, policyError: formatIssues(issues, 5) });
        return;
      }
      await this.saveProject(key, {
        ...base,
        policy: parsed.raw,
        policySha: head.sha,
        kind: parsed.policy.kind,
        policyError: null,
      });
    } catch (error) {
      await this.saveProject(key, {
        policyError: `读取失败：${(error as Error).message.slice(0, 200)}`,
      });
    }
  }
}
