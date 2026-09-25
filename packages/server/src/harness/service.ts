import type { HarnessBotPort, HarnessTelegram } from "@cos-tool-bot/bot";
import { KeyedAsyncLock } from "../services/keyed-async-lock.js";
import { type HarnessAttachments, createAttachments } from "./attachments.js";
import { handleHarnessCallback } from "./callbacks.js";
import { handleHarnessCommand } from "./commands.js";
import { type ConfigIssue, type ConfigLayer, formatIssues } from "./config/layers.js";
import {
  type ConfigValidation,
  type LoadedHarnessConfig,
  loadHarnessConfigFile,
} from "./config/loader.js";
import { type ExecutionSetting, executionLayerData } from "./config/execution.js";
import { composePanelProjects, parseExecutionSetting } from "./config/panel.js";
import {
  type HarnessOverride,
  type ProjectLayerInput,
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
import { type ExecFileLike, LodyCli } from "./lody.js";
import { createBridgeExec } from "./lody-bridge.js";
import { HarnessPrActions } from "./pr-actions.js";
import { HarnessPrFlow } from "./pr-flow.js";
import { fetchRepoPolicy } from "./policy-refresh.js";
import { handleOwnerReply } from "./protocol.js";
import { renderUsageHint } from "./render.js";
import {
  emptyProjectRecord,
  type HarnessEventInput,
  type HarnessProjectPatch,
  type HarnessProjectRecord,
  type HarnessStore,
} from "./store.js";
import type { PrSummarizer } from "./summary.js";
import type { GitHubWebhookRequest, GitHubWebhookResponse } from "./webhook.js";
import { dispatchGitHubWebhook } from "./webhook-dispatch.js";
import { HarnessWork } from "./work.js";

export { REPO_POLICY_PATH } from "./policy-refresh.js";

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
  /** Web panel origin; the Telegram "管理项目" button links to `<panelUrl>/harness`. */
  panelUrl?: string;
  /** Signs `/bug` screenshot links served under `panelUrl`; unset keeps file ids only. */
  attachmentSecret?: string;
  loadConfig?: (path: string) => Promise<ConfigValidation>;
  createLody?: (command: string[], timeoutMs: number, exec?: ExecFileLike) => LodyCli;
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
  /** Where owners manage projects; the Telegram "管理项目" button links here. */
  readonly adminUrl: string | null;
  readonly attachments: HarnessAttachments;
  private readonly configPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly loadConfig: (path: string) => Promise<ConfigValidation>;
  private readonly createLody: (
    command: string[],
    timeoutMs: number,
    exec?: ExecFileLike,
  ) => LodyCli;
  private readonly applyLock = new KeyedAsyncLock();
  private yaml: LoadedHarnessConfig | null = null;
  /** harness.yaml composed with the panel projects that took effect. */
  private loaded: LoadedHarnessConfig | null = null;
  private panelKeys = new Set<string>();
  private panelExecution: ExecutionSetting | null = null;
  /** Stored panel projects that did not take effect, with the reason. */
  shadowedPanelProjects: ReadonlyMap<string, string> = new Map();
  private reloadError: { at: Date; issues: ConfigIssue[] } | null = null;
  private overrides: HarnessOverride[] = [];
  private projectRecords = new Map<string, HarnessProjectRecord>();
  private telegramClient: HarnessTelegram | null = null;
  private boundBot: { id: string; name: string; miniApp: boolean } | null = null;
  private lodyClient: { key: string; cli: LodyCli } | null = null;

  constructor(options: HarnessServiceOptions) {
    this.configPath = options.configPath;
    this.store = options.store;
    this.github = options.github;
    this.logger = options.logger;
    this.summarizer = options.summarizer;
    this.env = options.env ?? process.env;
    this.clock = options.now ?? (() => new Date());
    this.adminUrl = URL.canParse("/harness", options.panelUrl)
      ? new URL("/harness", options.panelUrl).toString()
      : null;
    const { attachmentSecret, panelUrl } = options;
    this.attachments = createAttachments(attachmentSecret, panelUrl, () => this.telegramClient);
    this.loadConfig = options.loadConfig ?? ((path) => loadHarnessConfigFile(path, this.clock()));
    this.createLody =
      options.createLody ?? ((command, timeoutMs, exec) => new LodyCli(command, timeoutMs, exec));
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

  get botHasMiniApp(): boolean {
    return this.boundBot?.miniApp ?? false;
  }

  get configFilePath(): string {
    return this.configPath;
  }

  isPanelProject(key: string): boolean {
    return this.panelKeys.has(key);
  }

  allProjectRecords(): HarnessProjectRecord[] {
    return [...this.projectRecords.values()];
  }

  readEnv(name: string): string | undefined {
    return this.env[name] || undefined;
  }

  async init(): Promise<boolean> {
    this.overrides = await this.store.listOverrides();
    this.panelExecution = parseExecutionSetting(await this.store.getSetting("execution"));
    this.projectRecords = new Map((await this.store.listProjects()).map((row) => [row.key, row]));
    const result = await this.loadConfig(this.configPath);
    if (!result.ok) {
      this.reloadError = { at: this.now(), issues: result.issues };
      this.logger.error(`Dev Harness disabled: invalid config\n${formatIssues(result.issues)}`);
      return false;
    }
    this.yaml = result.config;
    this.recompose();
    return true;
  }

  private recompose() {
    if (!this.yaml) return;
    const panel = [...this.projectRecords.values()].flatMap((record) =>
      record.binding ? [{ key: record.key, binding: record.binding }] : [],
    );
    const composed = composePanelProjects(this.yaml, panel, this.now());
    this.loaded = composed.config;
    this.panelKeys = composed.panelKeys;
    this.shadowedPanelProjects = composed.shadowed;
  }

  /** Binds the harness to the Bot named by `telegram.bot` (id or name); one Bot at most. */
  claimBot(bot: { id: string; name: string; miniApp?: boolean }): HarnessBotPort | undefined {
    const ref = this.loaded?.file.telegram.bot;
    if (!ref || (bot.id !== ref && bot.name !== ref)) return undefined;
    if (this.boundBot && this.boundBot.id !== bot.id) {
      this.logger.warn(`Dev Harness already bound to Bot ${this.boundBot.id}; ignoring ${bot.id}`);
      return undefined;
    }
    this.boundBot = { id: bot.id, name: bot.name, miniApp: bot.miniApp ?? false };
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

  get panelExecutionSetting(): ExecutionSetting | null {
    return this.panelExecution;
  }

  async setPanelExecution(value: ExecutionSetting | null, actorId: number | null) {
    await this.store.putSetting("execution", value ? { ...value } : null, actorId);
    this.panelExecution = value;
  }

  globalView(): ScopedView<HarnessFileConfig> {
    const { raw, file } = this.requireConfig();
    const panel = executionLayerData(this.panelExecution);
    const resolved = resolveGlobalConfig(raw, this.overrides, this.now(), panel);
    if (resolved.ok) return { config: resolved.value, layers: resolved.layers };
    const fallback = resolveGlobalConfig(raw, [], this.now(), panel);
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

  projectInput(
    key: string,
    overrides: readonly HarnessOverride[] = this.overrides,
  ): ProjectLayerInput {
    const record = this.projectRecords.get(key);
    return {
      raw: this.requireConfig().raw,
      projectKey: key,
      policy: record?.policy ?? null,
      inferred: record?.inferredPolicy ?? null,
      panel: {
        binding: this.panelKeys.has(key),
        // A YAML project may share its row with a shadowed panel entry; only panel projects take its patch.
        policyPatch: this.panelKeys.has(key) ? (record?.policyPatch ?? null) : null,
        execution: executionLayerData(parseExecutionSetting(record?.execution)),
      },
      panelGlobal: executionLayerData(this.panelExecution),
      overrides,
      now: this.now(),
    };
  }

  projectView(
    key: string,
    overrides: readonly HarnessOverride[] = this.overrides,
  ): ScopedView<ProjectEffectiveConfig> | null {
    if (!this.requireConfig().file.projects[key]) return null;
    const input = this.projectInput(key, overrides);
    const resolved = resolveProjectConfig(input);
    if (resolved.ok) return { config: resolved.value, layers: resolved.layers };
    const bindingOnly = { binding: input.panel?.binding ?? false, policyPatch: null };
    for (const fallback of [
      { ...input, overrides: [] },
      { ...input, overrides: [], policy: null, inferred: null },
      { ...input, overrides: [], policy: null, inferred: null, panel: bindingOnly },
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

  /** Uses the lody-bridge sidecar when its URL is set in the environment, else the local CLI. */
  lody(): LodyCli {
    const lody = this.globalView().config.executors.lody;
    const command = typeof lody.cli === "string" ? [lody.cli] : lody.cli;
    const bridgeUrl = this.readEnv(lody.bridge.urlEnv);
    const bridgeSecret = this.readEnv(lody.bridge.secretEnv);
    const key = JSON.stringify([command, lody.timeout, bridgeUrl ?? null, Boolean(bridgeSecret)]);
    if (this.lodyClient?.key !== key) {
      const exec = bridgeUrl ? createBridgeExec(bridgeUrl, bridgeSecret) : undefined;
      this.lodyClient = { key, cli: this.createLody(command, durationMs(lody.timeout), exec) };
    }
    return this.lodyClient.cli;
  }

  lodyTransport(): "bridge" | "local" {
    return this.readEnv(this.globalView().config.executors.lody.bridge.urlEnv) ? "bridge" : "local";
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

  handleGitHubWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse> {
    return dispatchGitHubWebhook(this, request);
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
    this.yaml = result.config;
    this.recompose();
    this.reloadError = null;
    this.overrides = await this.store.listOverrides();
    this.panelExecution = parseExecutionSetting(await this.store.getSetting("execution"));
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

  private async saveProject(key: string, patch: HarnessProjectPatch) {
    await this.writeProject(key, this.file.projects[key]!.repo, patch);
  }

  private async writeProject(key: string, repo: string, patch: HarnessProjectPatch) {
    await this.store.upsertProject(key, repo, patch);
    const now = this.now();
    const current = this.projectRecords.get(key);
    this.projectRecords.set(key, {
      ...emptyProjectRecord(key, repo, now),
      ...current,
      ...patch,
      repo,
      updatedAt: now,
    });
  }

  /**
   * Stores a panel project's fields and applies them live: the project set is recomposed, and a
   * project that took effect gets its topic and policy right away.
   */
  updatePanelProject(key: string, repo: string, patch: HarnessProjectPatch): Promise<void> {
    return this.applyLock.run("apply", async () => {
      await this.writeProject(key, repo, patch);
      this.recompose();
      if (!this.panelKeys.has(key)) return;
      await this.ensureTopic(key, this.file.telegram.chatId);
      await this.refreshPolicy(key);
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

  async refreshPolicy(key: string): Promise<void> {
    if (!this.github?.available || !this.file.projects[key]) return;
    const patch = await fetchRepoPolicy({
      github: this.github,
      repo: this.file.projects[key]!.repo,
      now: this.now(),
      validate: (policy, inferred) => {
        const input = this.projectInput(key, []);
        const result = resolveProjectConfig({
          ...input,
          policy,
          inferred,
          panel: { binding: input.panel?.binding ?? false, policyPatch: null },
        });
        return result.ok ? [] : result.issues;
      },
    });
    await this.saveProject(key, patch);
  }
}
