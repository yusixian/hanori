import type { HarnessBotPort, TelegramObservationCallbacks } from "@cos-tool-bot/bot";
import type {
  EngagementSample,
  GitHubCodingModelConfig,
  ImageGenerationPort,
  MediaTranscriptionPort,
  UsageGovernancePort,
} from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { HarnessService } from "../../harness/service.js";
import type { ChatSummaryService } from "../chat-summary-service.js";
import type { DbLogger } from "../db-logger.js";
import type { EngagementSampleService } from "../engagement-sample-service.js";
import type { GitHubIssueProposalService } from "../github-issue-proposals.js";
import type { GitWorkspaceService } from "../git-workspace-service.js";
import type { RssFeedService } from "../rss-feed-service.js";
import type { SummaryConfigService } from "../summary-config-service.js";
import { assembleBotRuntime, type BotRuntimeServices } from "./index.js";
import {
  BOT_ID,
  aiConfig,
  githubToolsConfig,
  runtimeHost,
  runtimeInput,
  runtimeServices,
} from "./test-fakes.js";

const CODING_MODEL = {
  apiKey: "chat-key",
  baseURL: "https://chat.example/v1",
  id: "chat-model",
  providerFormat: "openai",
  capabilities: [],
} satisfies GitHubCodingModelConfig;

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function dbLogger(): DbLogger {
  return {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
  } as unknown as DbLogger;
}

/** The test keeps mutating the record it assembled with, as BotPool's setters do. */
function assemble(services: BotRuntimeServices, options: Parameters<typeof runtimeInput>[1] = {}) {
  return assembleBotRuntime(
    runtimeInput(dbLogger(), { aiConfig: aiConfig(), ...options }),
    services,
    runtimeHost(),
  );
}

function usageGovernor() {
  return {
    reserve: vi.fn(),
    settle: vi.fn(),
    refund: vi.fn(),
    getSnapshot: vi.fn(async () => ({ timezone: "UTC", resources: [] })),
    tightenGroupPolicy: vi.fn(async () => {}),
  };
}

function summaryService() {
  return { triggerManual: vi.fn(async () => ({ ok: true })) };
}

function summaryConfigService(accessMode: "all" | "admin") {
  return { getByChat: vi.fn(async () => ({ accessMode })) };
}

function gitWorkspace() {
  return { runCodeTask: vi.fn(async () => ({})), inspectWorkspace: vi.fn(async () => ({})) };
}

describe("Bot runtime service binding", () => {
  it("keeps persistent media confirmation callbacks wired when AI replies are disabled", async () => {
    const port: MediaTranscriptionPort = {
      create: vi.fn(),
      confirm: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
    };
    const services = runtimeServices({}, logger(), { mediaTranscriptionPort: port });
    const disabled = await assemble(services, { aiConfig: aiConfig({ enabled: false }) });
    expect(disabled.config.aiReply).toBeUndefined();
    expect(disabled.config.mediaTranscriptionPort).toBe(port);
    const enabled = await assemble(services);
    expect(enabled.config.mediaTranscriptionPort).toBe(port);
    expect(enabled.config.aiReply?.mediaTranscriptionPort).toBe(port);
  });

  it("quota calls the usage governor attached now", async () => {
    const assembled = usageGovernor();
    const services = runtimeServices({}, logger(), {
      usageGovernance: assembled as unknown as UsageGovernancePort,
    });
    const runtime = await assemble(services, { bot: { adminChatIds: [7] } });
    const replacement = usageGovernor();
    services.usageGovernance = replacement as unknown as UsageGovernancePort;
    const quota = runtime.config.quota;
    if (!quota?.tighten) throw new Error("Quota was not wired");

    await quota.getUsage({ chatId: -1001, userId: 42, chatType: "supergroup" });
    await expect(
      quota.tighten({
        chatId: -1001,
        actorUserId: 7,
        resource: "ai_reply",
        hourly: 5,
        daily: 20,
      }),
    ).resolves.toEqual({ ok: true });

    expect(replacement.getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID, chatId: -1001, userId: 42 }),
    );
    expect(replacement.tightenGroupPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID, chatId: -1001, actorUserId: 7 }),
    );
    expect(assembled.getSnapshot).not.toHaveBeenCalled();
    expect(assembled.tightenGroupPolicy).not.toHaveBeenCalled();
  });

  it("summary calls the summary services attached now", async () => {
    const assembled = summaryService();
    const services = runtimeServices({}, logger(), {
      summaryService: assembled as unknown as ChatSummaryService,
      summaryConfigService: summaryConfigService("admin") as unknown as SummaryConfigService,
    });
    const runtime = await assemble(services);
    const replacement = summaryService();
    services.summaryService = replacement as unknown as ChatSummaryService;
    services.summaryConfigService = summaryConfigService("all") as unknown as SummaryConfigService;
    const summary = runtime.config.summary;
    if (!summary) throw new Error("Summary was not wired");
    const request = {
      botId: BOT_ID,
      chatId: -1001,
      userId: 42,
      mode: { kind: "default" as const },
    };

    await summary.triggerManual(request);

    expect(replacement.triggerManual).toHaveBeenCalledWith(request);
    expect(assembled.triggerManual).not.toHaveBeenCalled();
    await expect(summary.getAccessMode(-1001)).resolves.toBe("all");
  });

  it("engagement samples reach a sample service attached after assembly", async () => {
    const services = runtimeServices({}, logger());
    const runtime = await assemble(services);
    const onEngagementSample = runtime.config.aiReply?.onEngagementSample;
    if (!onEngagementSample) throw new Error("Engagement samples were not wired");
    const sample = { chatId: -1001, messageId: 9, context: [] } as unknown as EngagementSample;

    await expect(onEngagementSample(sample)).resolves.toBeUndefined();
    const persist = vi.fn<EngagementSampleService["persist"]>(async () => {});
    services.engagementSampleService = { persist };
    await onEngagementSample(sample);

    expect(persist).toHaveBeenCalledExactlyOnceWith(BOT_ID, { ...sample, context: [] }, [
      "chat-key",
    ]);
  });

  it("binds durable Issue proposals to the bot and keeps callback access when AI replies are disabled", async () => {
    const port = { propose: vi.fn(), list: vi.fn(), decide: vi.fn() };
    const forBot = vi.fn(() => port);
    const services = runtimeServices({}, logger(), {
      githubIssueProposalService: { forBot } as unknown as GitHubIssueProposalService,
    });
    const enabled = await assemble(services, {
      aiConfig: aiConfig({ githubToolsConfig: githubToolsConfig() }),
    });
    expect(enabled.config.githubIssueProposals).toBe(port);
    expect(enabled.config.aiReply?.githubIssueProposals).toBe(port);
    expect(forBot).toHaveBeenCalledWith(BOT_ID);
    const disabled = await assemble(services, { aiConfig: aiConfig({ enabled: false }) });
    expect(disabled.config.aiReply).toBeUndefined();
    expect(disabled.config.githubIssueProposals).toBe(port);
  });

  it.each(["selected", "all"] as const)(
    "uses all synced repositories for a %s GitHub App installation",
    async (repositorySelection) => {
      const config = githubToolsConfig();
      config.githubAppInstallation = {
        installationId: 17,
        accountLogin: "owner",
        accountType: "User",
        repositorySelection,
        repositories: ["owner/new", "owner/private"],
        permissions: {},
        connectedAt: "now",
      };
      const runtime = await assemble(runtimeServices({}, logger()), {
        aiConfig: aiConfig({ githubToolsConfig: config }),
      });
      const resolved = runtime.config.aiReply?.githubToolsConfig;
      expect(resolved?.repositories).toEqual(["owner/new", "owner/private"]);
      expect(resolved?.tokenProvider).toBeUndefined();
    },
  );

  it("GitHub code callbacks call the workspace service attached now", async () => {
    const assembled = gitWorkspace();
    const services = runtimeServices({}, logger(), {
      gitWorkspaceService: assembled as unknown as GitWorkspaceService,
    });
    const runtime = await assemble(services, {
      aiConfig: aiConfig({ githubToolsConfig: githubToolsConfig() }),
    });
    const replacement = gitWorkspace();
    services.gitWorkspaceService = replacement as unknown as GitWorkspaceService;
    const callbacks = runtime.config.aiReply?.githubCodeCallbacks;
    if (!callbacks?.inspectWorkspace) throw new Error("GitHub code callbacks were not wired");
    const signal = new AbortController().signal;
    const task = { repository: "owner/repo", task: "Fix the tea timer", branch: "fix/tea" };

    await callbacks.runTask(task, CODING_MODEL, signal);
    await callbacks.inspectWorkspace("owner/repo", signal);

    expect(replacement.runCodeTask).toHaveBeenCalledWith(
      {
        ...task,
        botId: BOT_ID,
        token: "github-token",
        authorName: "Runtime Bot",
        authorEmail: "runtime-bot@example.test",
        model: CODING_MODEL,
      },
      signal,
    );
    expect(replacement.inspectWorkspace).toHaveBeenCalledWith(
      { botId: BOT_ID, repository: "owner/repo" },
      signal,
    );
    expect(assembled.runCodeTask).not.toHaveBeenCalled();
    expect(assembled.inspectWorkspace).not.toHaveBeenCalled();
  });

  it("leaves features off when their service arrives after assembly", async () => {
    const services = runtimeServices({}, logger(), {
      summaryService: summaryService() as unknown as ChatSummaryService,
    });
    const runtime = await assemble(services);

    services.rssFeedService = {} as RssFeedService;
    services.usageGovernance = usageGovernor() as unknown as UsageGovernancePort;
    services.summaryConfigService = summaryConfigService("all") as unknown as SummaryConfigService;

    expect(runtime.config.aiReply).toBeDefined();
    expect(runtime.config.aiReply?.rssCallbacks).toBeUndefined();
    expect(runtime.config.quota).toBeUndefined();
    expect(runtime.config.summary).toBeUndefined();
  });

  it("RSS callbacks keep the RSS service they were assembled with", async () => {
    const assembled = { listCollections: vi.fn(async () => []) };
    const services = runtimeServices({}, logger(), {
      rssFeedService: assembled as unknown as RssFeedService,
    });
    const runtime = await assemble(services);
    const replacement = { listCollections: vi.fn(async () => []) };
    services.rssFeedService = replacement as unknown as RssFeedService;

    await runtime.config.aiReply?.rssCallbacks?.onListCollections();

    expect(assembled.listCollections).toHaveBeenCalledWith(BOT_ID);
    expect(replacement.listCollections).not.toHaveBeenCalled();
  });

  it("keeps the image port and Telegram observation it was assembled with", async () => {
    const imageGenerationPort = {} as ImageGenerationPort;
    const telegramObservation = {} as TelegramObservationCallbacks;
    const services = runtimeServices({}, logger(), { imageGenerationPort, telegramObservation });
    const runtime = await assemble(services);

    services.imageGenerationPort = {} as ImageGenerationPort;
    services.telegramObservation = {} as TelegramObservationCallbacks;

    expect(runtime.config.aiReply?.imageGenerationPort).toBe(imageGenerationPort);
    expect(runtime.config.telegramObservation).toBe(telegramObservation);
  });

  it("claims the Harness once, at assembly", async () => {
    const port = {} as HarnessBotPort;
    const claimBot = vi.fn(() => port);
    const services = runtimeServices({}, logger(), {
      harnessService: { claimBot } as unknown as HarnessService,
    });
    const runtime = await assemble(services);
    expect(claimBot).toHaveBeenCalledOnce();

    const lateClaim = vi.fn();
    services.harnessService = { claimBot: lateClaim } as unknown as HarnessService;

    expect(runtime.config.harness).toBe(port);
    expect(claimBot).toHaveBeenCalledOnce();
    expect(lateClaim).not.toHaveBeenCalled();
  });
});
