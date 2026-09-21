import { EngagementSection } from "./sections/engagement-section";
import { Button } from "@/components/ui/button";
import { useBeforeLogout, type LogoutAction } from "@/components/layout/before-logout";
import { authFetch, client } from "@/lib/client";
import type {
  AgentToolsConfig,
  AiConfigPublic,
  AiGroupOverride,
  AiTriggerConfig,
  ArtworkToolsConfig,
  BotMemoryConfig,
  ConversationConfig,
  ImageGenerationReceiptConfig,
  ImageOcrConfig,
  MemoryConfig,
  MessageConfig,
  BotWithStatus,
  SummaryConfigStored,
  TimeoutConfig,
  WebToolsConfigPublic,
  GitHubToolsConfigPublic,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_ARTWORK_TOOLS_CONFIG,
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  resolveImageGenerationReceiptConfig,
} from "@cos-tool-bot/shared";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Clock3,
  Eye,
  KeyRound,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Server,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildAiConfigSaveBody } from "./ai-config-save-body";
import { PromptPreviewDialog } from "./prompt-preview-dialog";
import { Link, useBlocker, useParams, useSearchParams } from "react-router";
import {
  AiSettingsNavigation,
  type AiSettingsNavItem,
  type AiSettingsSectionId,
} from "./components/ai-settings-navigation";
import { SettingsDisclosureRow } from "./components/settings-disclosure-row";
import { AiSettingsSearch, type AiSettingsSearchItem } from "./components/ai-settings-search";
import { UnsavedChangesDialog } from "./components/unsaved-changes-dialog";
import { OverviewSection } from "./sections/overview-section";
import { AgentToolsSection } from "./sections/agent-tools-section";
import { GitHubToolsSection } from "./sections/github-tools-section";
import { ArtworkToolsSection } from "./sections/artwork-tools-section";
import { BotMemorySection } from "./sections/bot-memory-section";
import type { EmbeddingFormConfig } from "./sections/embedding-section";
import { EmbeddingSection } from "./sections/embedding-section";
import { ConversationSection } from "./sections/conversation-section";
import { GlobalSettingsSection } from "./sections/global-settings-section";
import { GroupOverridesSection } from "./sections/group-overrides-section";
import { MemorySystemSection } from "./sections/memory-system-section";
import { MessageSplittingSection } from "./sections/message-splitting-section";
import { TimeoutSection } from "./sections/timeout-section";
import { ModelsSection } from "./sections/models-section";
import { PrivateChatWhitelistSection } from "./sections/private-whitelist-section";
import { ProvidersSection } from "./sections/providers-section";
import {
  GlobalAiSelectionSection,
  type GlobalAiSelectionDraft,
} from "./sections/global-ai-selection-section";
import { StickerPacksSection } from "./sections/sticker-packs-section";
import { TriggerSettingsSection } from "./sections/trigger-settings-section";
import { McpServersSection } from "./sections/mcp-servers-section";
import { SummaryConfigSection } from "./sections/summary-config-section";
import { ImageOcrConfigSection } from "./sections/image-ocr-config-section";
import { ImageGenerationReceiptSection } from "./sections/image-generation-receipt-section";
import { WebToolsSection } from "./sections/web-tools-section";
import { ExecutionConfigSection } from "./sections/execution-config-section";
import {
  createExecutionConfigDraft,
  type AiExecutionConfigDraft,
  toExecutionConfigUpdate,
} from "./execution-config";
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_CONFIG,
  DEFAULT_GITHUB_TOOLS,
  DEFAULT_WEB_TOOLS,
} from "./types";
import type { GlobalAiSelection, StatusMessage } from "./types";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  recoverAiConfigAfterApplyFailure,
  renameProviderModelReferences,
  resolveManagedProviderIdAfterSave,
} from "./utils";
import {
  AI_SETTING_DEFINITIONS,
  findAiSettingDefinition,
  settingElementId,
  type AiSettingId,
} from "./settings-index";

const DEFAULT_SUMMARY_CONFIG: SummaryConfigStored = {
  enabled: false,
  defaultWindowHours: 24,
  defaultMaxMessages: 2000,
  defaultCooldownSeconds: 300,
};

const DEFAULT_IMAGE_OCR_CONFIG: ImageOcrConfig = { enabled: false };

function serializeDraft(
  config: AiConfigPublic,
  triggerWordsText: string,
  stickerPacksText: string,
  summaryConfig: SummaryConfigStored,
  imageOcrConfig: ImageOcrConfig,
  executionConfig: AiExecutionConfigDraft,
) {
  return JSON.stringify({
    config,
    triggerWordsText,
    stickerPacksText,
    summaryConfig,
    imageOcrConfig,
    executionConfig,
  });
}

export function BotAiSettingsPage() {
  const { botId } = useParams<{ botId: string }>();
  const { t, i18n } = useTranslation("aiSettings");
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState<AiConfigPublic>(DEFAULT_CONFIG);
  const [managedProviderId, setManagedProviderId] = useState<string>();
  const savedDraftRef = useRef("");
  const revisionRef = useRef("");
  const previousBotIdRef = useRef<string | undefined>(undefined);
  // Draft per-provider api keys: keyed by provider id (or temp "__new_..." id until saved).
  // Cleared on save. Preserve-when-empty: empty string ⇒ keep existing encrypted key.
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configApplyRetryPending, setConfigApplyRetryPending] = useState(false);
  const [pendingLogoutAction, setPendingLogoutAction] = useState<LogoutAction | null>(null);
  const [logoutConfirming, setLogoutConfirming] = useState(false);
  const confirmedLogoutRef = useRef(false);
  const logoutInFlightRef = useRef(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [triggerWordsText, setTriggerWordsText] = useState("");
  const [stickerPacksText, setStickerPacksText] = useState("");
  const [engagementApiKey, setEngagementApiKey] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [webSearchApiKey, setWebSearchApiKey] = useState("");
  const [webImageApiKey, setWebImageApiKey] = useState("");
  const [canManageGitHubCredentials, setCanManageGitHubCredentials] = useState(false);
  const [globalSelection, setGlobalSelection] = useState<GlobalAiSelection | null>(null);
  const [globalSelectionDraft, setGlobalSelectionDraft] = useState<GlobalAiSelectionDraft | null>(
    null,
  );
  const [canManageAiSelection, setCanManageAiSelection] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [retryingSelection, setRetryingSelection] = useState(false);
  const [openGitHubAfterCallback, setOpenGitHubAfterCallback] = useState(
    () =>
      searchParams.get("githubApp") === "connected" || searchParams.get("githubApp") === "error",
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingFocusSettingId, setPendingFocusSettingId] = useState<AiSettingId | null>(null);
  const settingsHeaderRef = useRef<HTMLDivElement>(null);
  const [summaryConfig, setSummaryConfig] = useState<SummaryConfigStored>(DEFAULT_SUMMARY_CONFIG);
  const [imageOcrConfig, setImageOcrConfig] = useState<ImageOcrConfig>(DEFAULT_IMAGE_OCR_CONFIG);
  const [executionConfig, setExecutionConfig] = useState<AiExecutionConfigDraft>(() =>
    createExecutionConfigDraft(DEFAULT_CONFIG.executionConfig),
  );
  const [loadedBot, setLoadedBot] = useState<{
    id: string;
    platform: BotWithStatus["platform"];
  } | null>(null);

  const sectionItems: AiSettingsNavItem[] = useMemo(
    () => [
      {
        id: "overview",
        label: t("navigation.overview"),
        description: t("navigation.overviewDescription"),
        icon: LayoutDashboard,
      },
      {
        id: "providers",
        label: t("navigation.providers"),
        description: t("navigation.providersDescription"),
        icon: Server,
      },
      {
        id: "replies",
        label: t("navigation.replies"),
        description: t("navigation.repliesDescription"),
        icon: MessageSquare,
      },
      {
        id: "memory",
        label: t("navigation.memory"),
        description: t("navigation.memoryDescription"),
        icon: Brain,
      },
      {
        id: "tools",
        label: t("navigation.tools"),
        description: t("navigation.toolsDescription"),
        icon: Wrench,
      },
      {
        id: "access",
        label: t("navigation.access"),
        description: t("navigation.accessDescription"),
        icon: KeyRound,
      },
    ],
    [t],
  );
  const settingItems: AiSettingsSearchItem[] = useMemo(
    () =>
      AI_SETTING_DEFINITIONS.map((setting) => ({
        id: setting.id,
        label: t(setting.titleKey),
        description: t(setting.descriptionKey),
        sectionLabel:
          sectionItems.find((section) => section.id === setting.section)?.label ?? setting.section,
      })),
    [sectionItems, t],
  );
  const requestedSection = searchParams.get("section") as AiSettingsSectionId | null;
  const requestedSetting = findAiSettingDefinition(searchParams.get("setting"));
  const activeSection =
    requestedSetting?.section ??
    (sectionItems.some((item) => item.id === requestedSection) ? requestedSection! : "overview");
  const setActiveSection = (section: AiSettingsSectionId) => {
    const next = new URLSearchParams(searchParams);
    if (section === "overview") next.delete("section");
    else next.set("section", section);
    next.delete("setting");
    setSearchParams(next);
  };
  const setActiveSetting = (settingId: AiSettingId, replace = false) => {
    const setting = findAiSettingDefinition(settingId);
    if (!setting) return;
    const next = new URLSearchParams(searchParams);
    next.set("section", setting.section);
    next.set("setting", setting.id);
    setSearchParams(next, { replace });
  };
  const handleSettingOpenChange = (settingId: AiSettingId, open: boolean) => {
    if (open) {
      setActiveSetting(settingId, true);
      return;
    }
    if (searchParams.get("setting") !== settingId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("setting");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (!requestedSetting || requestedSection === requestedSetting.section) return;
    const next = new URLSearchParams(searchParams);
    next.set("section", requestedSetting.section);
    setSearchParams(next, { replace: true });
  }, [requestedSection, requestedSetting, searchParams, setSearchParams]);

  useEffect(() => {
    if (loading || !requestedSetting) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(settingElementId(requestedSetting.id));
      if (!target) return;
      target.style.scrollMarginTop = `${(settingsHeaderRef.current?.offsetHeight ?? 0) + 16}px`;
      target.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, loading, requestedSetting]);

  useEffect(() => {
    if (loading || !pendingFocusSettingId || requestedSetting?.id !== pendingFocusSettingId) return;
    const frame = window.requestAnimationFrame(() => {
      const settingId = settingElementId(pendingFocusSettingId);
      const trigger = document.getElementById(`${settingId}-trigger`);
      if (!trigger) return;
      trigger.focus({ preventScroll: true });
      setPendingFocusSettingId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, loading, pendingFocusSettingId, requestedSetting]);

  useEffect(() => {
    const callbackResult = searchParams.get("githubApp");
    if (callbackResult !== "connected" && callbackResult !== "error") return;

    setOpenGitHubAfterCallback(true);
    setMessage({
      type: callbackResult === "connected" ? "success" : "error",
      text:
        callbackResult === "connected"
          ? t("githubTools.callbackSuccess")
          : searchParams.get("message") || t("githubTools.callbackError"),
    });
    const next = new URLSearchParams(searchParams);
    next.delete("githubApp");
    next.delete("message");
    next.set("section", "tools");
    next.set("setting", "github-tools");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, t]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await authFetch("/api/authz/me");
        if (!response.ok) return;
        const body = (await response.json()) as { data?: { member?: { role?: string } } };
        const role = body.data?.member?.role;
        if (active) setCanManageGitHubCredentials(role === "owner" || role === "admin");
      } catch {
        // Credential operations remain hidden if the role cannot be verified.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadConfig = useCallback(
    async (reportError = true): Promise<boolean> => {
      if (!botId) return false;
      try {
        const res = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
        const json = await res.json();
        if (json.ok) {
          setConfigApplyRetryPending(false);
          revisionRef.current = json.revision;
          const triggerText = json.data.triggerConfig.triggerWords.join(", ");
          const stickersText = json.data.stickerPacks?.join(", ") ?? "";
          const nextSummary = json.data.summaryConfig ?? DEFAULT_SUMMARY_CONFIG;
          const nextOcr = json.data.imageOcrConfig ?? DEFAULT_IMAGE_OCR_CONFIG;
          const nextExecution = createExecutionConfigDraft(json.data.executionConfig);
          setConfig(json.data);
          setManagedProviderId((current) =>
            json.data.providers.some((provider) => provider.id === current)
              ? current
              : (json.data.activeProviderId ?? json.data.providers[0]?.id),
          );
          setEmbeddingApiKey("");
          setEngagementApiKey("");
          setWebSearchApiKey("");
          setWebImageApiKey("");
          setProviderApiKeys({});
          setTriggerWordsText(triggerText);
          setStickerPacksText(stickersText);
          setSummaryConfig(nextSummary);
          setImageOcrConfig(nextOcr);
          setExecutionConfig(nextExecution);
          savedDraftRef.current = serializeDraft(
            json.data,
            triggerText,
            stickersText,
            nextSummary,
            nextOcr,
            nextExecution,
          );
          return true;
        }
        if (reportError) {
          setMessage({ type: "error", text: i18n.t("page.loadError", { ns: "aiSettings" }) });
        }
        return false;
      } catch {
        if (reportError) {
          setMessage({ type: "error", text: i18n.t("page.loadError", { ns: "aiSettings" }) });
        }
        return false;
      } finally {
        setLoading(false);
      }
    },
    [botId, i18n],
  );

  useEffect(() => {
    if (previousBotIdRef.current && previousBotIdRef.current !== botId) setMessage(null);
    previousBotIdRef.current = botId;
    setConfigApplyRetryPending(false);
    void loadConfig();
  }, [botId, loadConfig]);

  const loadGlobalSelection = useCallback(async () => {
    if (!botId) return;
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/ai-selection`);
      const body = (await response.json()) as {
        ok?: boolean;
        data?: GlobalAiSelection;
        canManage?: boolean;
      };
      if (!response.ok || !body.ok || !body.data) return;
      setGlobalSelection(body.data);
      setGlobalSelectionDraft({
        providerId: body.data.selection.providerId,
        modelId: body.data.selection.modelId,
        displayDefault: body.data.displayDefault,
      });
      setCanManageAiSelection(body.canManage === true);
    } catch {
      // Catalog configuration remains available when runtime selection is not ready yet.
    }
  }, [botId]);

  useEffect(() => {
    void loadGlobalSelection();
  }, [loadGlobalSelection]);

  useEffect(() => {
    let active = true;
    setLoadedBot(null);
    if (!botId) return () => undefined;

    void (async () => {
      try {
        const response = await client.api.bots[":botId"].$get({ param: { botId } });
        const json = await response.json();
        if (active && json.ok) setLoadedBot({ id: botId, platform: json.data.platform });
      } catch {
        // Keep the platform unknown so Telegram-only settings stay hidden.
      }
    })();

    return () => {
      active = false;
    };
  }, [botId]);

  useEffect(() => {
    if (!message) return;
    if (message.type === "success") toast.success(message.text);
    else toast.error(message.text);
  }, [message]);

  const isConfigDirty =
    savedDraftRef.current !== "" &&
    (savedDraftRef.current !==
      serializeDraft(
        config,
        triggerWordsText,
        stickerPacksText,
        summaryConfig,
        imageOcrConfig,
        executionConfig,
      ) ||
      engagementApiKey !== "" ||
      embeddingApiKey !== "" ||
      webSearchApiKey !== "" ||
      webImageApiKey !== "" ||
      Object.keys(providerApiKeys).length > 0);
  const isSelectionDirty = Boolean(
    globalSelection &&
    globalSelectionDraft &&
    (globalSelection.selection.providerId !== globalSelectionDraft.providerId ||
      globalSelection.selection.modelId !== globalSelectionDraft.modelId ||
      globalSelection.displayDefault !== globalSelectionDraft.displayDefault),
  );
  const isDirty = isConfigDirty || isSelectionDirty;
  const { registerBeforeLogout } = useBeforeLogout();
  const executionConfigUpdate = toExecutionConfigUpdate(executionConfig);
  const pageBusy = saving || savingSelection || retryingSelection;
  const saveDisabledReason = pageBusy
    ? t("page.saveInProgress")
    : revisionRef.current === ""
      ? t("page.saveUnavailable")
      : isSelectionDirty
        ? t("selection.applyBeforeCatalogSave")
        : executionConfigUpdate === null
          ? t("execution.validation.fixErrors")
          : !isConfigDirty && !configApplyRetryPending
            ? t("page.noChangesToSave")
            : null;
  const saveStatus: {
    icon: typeof CheckCircle2;
    label: string;
    detail?: string;
    className: string;
  } = pageBusy
    ? {
        icon: Clock3,
        label: t("page.statusSaving"),
        className: "bg-blue-50 text-blue-800 ring-blue-200",
      }
    : configApplyRetryPending && !isConfigDirty
      ? {
          icon: AlertCircle,
          label: t("page.statusApplyRetry"),
          detail: message?.text,
          className: "bg-amber-50 text-amber-900 ring-amber-200",
        }
      : message?.type === "error"
        ? {
            icon: AlertCircle,
            label: t("page.statusError"),
            detail: message.text,
            className: "bg-red-50 text-red-800 ring-red-200",
          }
        : isSelectionDirty
          ? {
              icon: AlertCircle,
              label: t("page.statusSelectionDraft"),
              className: "bg-amber-50 text-amber-900 ring-amber-200",
            }
          : isConfigDirty
            ? {
                icon: AlertCircle,
                label: t("page.statusUnsaved"),
                className: "bg-amber-50 text-amber-900 ring-amber-200",
              }
            : revisionRef.current === ""
              ? {
                  icon: AlertCircle,
                  label: t("page.statusUnavailable"),
                  className: "bg-red-50 text-red-800 ring-red-200",
                }
              : {
                  icon: CheckCircle2,
                  label: t("page.statusSaved"),
                  className: "bg-emerald-50 text-emerald-800 ring-emerald-200",
                };
  const navigationBlocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !confirmedLogoutRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const leaveDialogOpen = navigationBlocker.state === "blocked" || pendingLogoutAction !== null;
  const disclosureProps = (settingId: AiSettingId) => ({
    settingId,
    reveal: requestedSetting?.id === settingId,
    onOpenChange: (open: boolean) => handleSettingOpenChange(settingId, open),
  });

  useEffect(() => {
    if (!isDirty) return;
    return registerBeforeLogout((action) => setPendingLogoutAction(() => action));
  }, [isDirty, registerBeforeLogout]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty || confirmedLogoutRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isDirty]);

  const handleStayOnPage = () => {
    setPendingLogoutAction(null);
    if (navigationBlocker.state === "blocked") navigationBlocker.reset();
  };

  const handleLeavePage = () => {
    if (!pendingLogoutAction) {
      if (navigationBlocker.state === "blocked") navigationBlocker.proceed();
      return;
    }
    if (logoutInFlightRef.current) return;

    logoutInFlightRef.current = true;
    confirmedLogoutRef.current = true;
    setLogoutConfirming(true);
    void pendingLogoutAction().catch(() => {
      confirmedLogoutRef.current = false;
      logoutInFlightRef.current = false;
      setLogoutConfirming(false);
    });
  };

  const handleSave = async () => {
    if (!botId || pageBusy || (!isConfigDirty && !configApplyRetryPending) || isSelectionDirty)
      return;
    if (!executionConfigUpdate) {
      setMessage({ type: "error", text: t("execution.validation.fixErrors") });
      return;
    }
    setSaving(true);
    setMessage(null);
    const providerIdsBeforeSave = config.providers.map((provider) => provider.id);
    try {
      const res = await client.api.bots[":botId"]["ai-config"].$put({
        param: { botId },
        json: buildAiConfigSaveBody({
          revision: revisionRef.current,
          config,
          triggerWordsText,
          stickerPacksText,
          summaryConfig,
          imageOcrConfig,
          executionConfig: executionConfigUpdate,
          providerApiKeys,
          webSearchApiKey,
          webImageApiKey,
          embeddingApiKey,
          engagementApiKey,
        }),
      });
      if (!res.ok) {
        type SaveErrorResponse = {
          code?: string;
          error?: string | { issues?: Array<{ path: string[]; message: string }> };
        };
        const responseText = await res.text();
        let errorJson: SaveErrorResponse | undefined;
        try {
          const parsed: unknown = JSON.parse(responseText);
          if (parsed && typeof parsed === "object") errorJson = parsed as SaveErrorResponse;
        } catch {
          // The HTTP fallback below handles non-JSON responses.
        }
        const recovery = await recoverAiConfigAfterApplyFailure(
          { status: res.status, code: errorJson?.code },
          () => loadConfig(false),
        );
        if (recovery === "reloaded") {
          await loadGlobalSelection();
          setConfigApplyRetryPending(true);
          setMessage({ type: "error", text: t("page.saveApplyFailed") });
          return;
        }
        if (recovery === "reload-failed") {
          setMessage({ type: "error", text: t("page.saveApplyFailedRefreshError") });
          return;
        }
        if (res.status === 409) {
          setMessage({ type: "error", text: t("page.saveConflict") });
          return;
        }
        if (errorJson) {
          const issues = typeof errorJson.error === "object" ? errorJson.error.issues : undefined;
          const detail = issues
            ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
            : JSON.stringify(errorJson);
          setMessage({ type: "error", text: t("page.saveErrorDetail", { detail }) });
        } else {
          setMessage({ type: "error", text: t("page.saveErrorHttp", { status: res.status }) });
        }
        return;
      }
      const json = await res.json();
      if (json.ok) {
        setConfigApplyRetryPending(false);
        revisionRef.current = json.revision;
        const triggerText = json.data.triggerConfig.triggerWords.join(", ");
        const stickersText = json.data.stickerPacks?.join(", ") ?? "";
        const nextSummary = json.data.summaryConfig ?? summaryConfig;
        const nextOcr = json.data.imageOcrConfig ?? imageOcrConfig;
        const nextExecution = createExecutionConfigDraft(json.data.executionConfig);
        setConfig(json.data);
        setTriggerWordsText(triggerText);
        setStickerPacksText(stickersText);
        setEmbeddingApiKey("");
        setEngagementApiKey("");
        setWebSearchApiKey("");
        setWebImageApiKey("");
        setProviderApiKeys({});
        setExecutionConfig(nextExecution);
        setManagedProviderId((current) =>
          resolveManagedProviderIdAfterSave({
            currentProviderId: current,
            draftProviderIds: providerIdsBeforeSave,
            savedProviders: json.data.providers,
            activeProviderId: json.data.activeProviderId,
          }),
        );
        savedDraftRef.current = serializeDraft(
          json.data,
          triggerText,
          stickersText,
          nextSummary,
          nextOcr,
          nextExecution,
        );
        await loadGlobalSelection();
        setMessage({ type: "success", text: t("page.saveSuccess") });
      } else {
        setMessage({
          type: "error",
          text: "error" in json ? String(json.error) : t("page.saveError"),
        });
      }
    } catch {
      setMessage({ type: "error", text: t("page.saveConfigError") });
    } finally {
      setSaving(false);
    }
  };

  const handleSelectionSave = async () => {
    if (
      !botId ||
      !globalSelection ||
      !globalSelectionDraft ||
      saving ||
      savingSelection ||
      retryingSelection
    )
      return;
    setSavingSelection(true);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/ai-selection`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: globalSelection.revision,
          ...globalSelectionDraft,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        latest?: GlobalAiSelection;
        data?: { global?: GlobalAiSelection };
      };
      if (response.status === 409 && body.latest) {
        setGlobalSelection(body.latest);
        setGlobalSelectionDraft({
          providerId: body.latest.selection.providerId,
          modelId: body.latest.selection.modelId,
          displayDefault: body.latest.displayDefault,
        });
        setMessage({ type: "error", text: t("selection.stale") });
        return;
      }
      if (!response.ok || !body.ok || !body.data?.global) {
        setMessage({ type: "error", text: body.error || t("selection.saveError") });
        return;
      }
      const next = body.data.global;
      setGlobalSelection(next);
      setGlobalSelectionDraft({
        providerId: next.selection.providerId,
        modelId: next.selection.modelId,
        displayDefault: next.displayDefault,
      });
      setMessage({
        type: next.applyState === "applied" ? "success" : "error",
        text:
          next.applyState === "applied" ? t("selection.saveSuccess") : t("selection.savedPending"),
      });
    } catch {
      setMessage({ type: "error", text: t("selection.saveError") });
    } finally {
      setSavingSelection(false);
    }
  };

  const handleSelectionRetry = async () => {
    if (!botId || saving || savingSelection || retryingSelection) return;
    setRetryingSelection(true);
    try {
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/ai-selection/retry`,
        { method: "POST" },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: { global?: GlobalAiSelection };
      };
      if (!response.ok || !body.ok || !body.data?.global) {
        setMessage({ type: "error", text: body.error || t("selection.retryError") });
        return;
      }
      const next = body.data.global;
      setGlobalSelection(next);
      setGlobalSelectionDraft({
        providerId: next.selection.providerId,
        modelId: next.selection.modelId,
        displayDefault: next.displayDefault,
      });
      setMessage({
        type: next.applyState === "applied" ? "success" : "error",
        text:
          next.applyState === "applied" ? t("selection.retrySuccess") : t("selection.savedPending"),
      });
    } catch {
      setMessage({ type: "error", text: t("selection.retryError") });
    } finally {
      setRetryingSelection(false);
    }
  };

  const handleSelectionDiscard = () => {
    if (!globalSelection || pageBusy) return;
    setGlobalSelectionDraft({
      providerId: globalSelection.selection.providerId,
      modelId: globalSelection.selection.modelId,
      displayDefault: globalSelection.displayDefault,
    });
    setMessage(null);
  };

  // --- updater functions ---

  const updateTrigger = (
    key: keyof AiTriggerConfig,
    value: AiTriggerConfig[keyof AiTriggerConfig],
  ) => {
    setConfig((prev) => ({
      ...prev,
      triggerConfig: { ...prev.triggerConfig, [key]: value },
    }));
  };

  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const updateMemory = (updates: Partial<MemoryConfig>) => {
    setConfig((prev) => ({
      ...prev,
      memoryConfig: { ...memCfg, ...prev.memoryConfig, ...updates },
    }));
  };

  const convCfg = {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...config.conversationConfig,
  };
  const updateConv = (updates: Partial<ConversationConfig>) => {
    setConfig((prev) => ({
      ...prev,
      conversationConfig: { ...convCfg, ...prev.conversationConfig, ...updates },
    }));
  };

  const webCfg = config.webToolsConfig ?? DEFAULT_WEB_TOOLS;
  const updateWebTools = (updates: Partial<WebToolsConfigPublic>) => {
    setConfig((prev) => ({
      ...prev,
      webToolsConfig: { ...webCfg, ...prev.webToolsConfig, ...updates },
    }));
  };

  const imageGenerationReceiptConfig = resolveImageGenerationReceiptConfig(
    config.imageGenerationReceiptConfig,
  );
  const updateImageGenerationReceiptConfig = (updates: Partial<ImageGenerationReceiptConfig>) => {
    setConfig((prev) => ({
      ...prev,
      imageGenerationReceiptConfig: {
        ...resolveImageGenerationReceiptConfig(prev.imageGenerationReceiptConfig),
        ...updates,
      },
    }));
  };

  const agentCfg = config.agentToolsConfig ?? DEFAULT_AGENT_TOOLS;
  const updateAgentTools = (updates: Partial<AgentToolsConfig>) => {
    setConfig((prev) => ({
      ...prev,
      agentToolsConfig: { ...agentCfg, ...prev.agentToolsConfig, ...updates },
    }));
  };

  const githubCfg = config.githubToolsConfig ?? DEFAULT_GITHUB_TOOLS;
  const updateGitHubTools = (updates: Partial<GitHubToolsConfigPublic>) => {
    setConfig((prev) => ({
      ...prev,
      githubToolsConfig: { ...githubCfg, ...prev.githubToolsConfig, ...updates },
    }));
  };

  const artworkCfg = config.artworkToolsConfig ?? DEFAULT_ARTWORK_TOOLS_CONFIG;
  const updateArtworkTools = (updates: Partial<ArtworkToolsConfig>) => {
    setConfig((prev) => ({
      ...prev,
      artworkToolsConfig: { ...artworkCfg, ...prev.artworkToolsConfig, ...updates },
    }));
  };

  const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  const updateBotMemory = (updates: Partial<BotMemoryConfig>) => {
    setConfig((prev) => ({
      ...prev,
      botMemoryConfig: { ...botMemCfg, ...prev.botMemoryConfig, ...updates },
    }));
  };

  const embCfg: EmbeddingFormConfig = {
    enabled: config.embeddingConfig?.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
    hasApiKey: config.embeddingConfig?.hasApiKey ?? false,
    baseURL: config.embeddingConfig?.baseURL ?? DEFAULT_EMBEDDING_CONFIG.baseURL,
    model: config.embeddingConfig?.model ?? DEFAULT_EMBEDDING_CONFIG.model,
    dimensions: config.embeddingConfig?.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
    apiKey: embeddingApiKey,
  };
  const updateEmbedding = (updates: Partial<EmbeddingFormConfig>) => {
    if ("apiKey" in updates) {
      setEmbeddingApiKey(updates.apiKey ?? "");
    }
    const { apiKey: _, hasApiKey: __, ...configUpdates } = updates;
    if (Object.keys(configUpdates).length > 0) {
      setConfig((prev) => ({
        ...prev,
        embeddingConfig: {
          ...prev.embeddingConfig,
          enabled: prev.embeddingConfig?.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
          hasApiKey: prev.embeddingConfig?.hasApiKey ?? false,
          baseURL: prev.embeddingConfig?.baseURL ?? DEFAULT_EMBEDDING_CONFIG.baseURL,
          model: prev.embeddingConfig?.model ?? DEFAULT_EMBEDDING_CONFIG.model,
          dimensions: prev.embeddingConfig?.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
          ...configUpdates,
        },
      }));
    }
  };

  const timeoutCfg = config.timeoutConfig ?? {};
  const updateTimeoutConfig = (updates: Partial<TimeoutConfig>) => {
    setConfig((prev) => {
      const merged = { ...prev.timeoutConfig, ...updates };
      // If all values are undefined, remove the key entirely
      const hasValue = Object.values(merged).some((v) => v != null);
      return { ...prev, timeoutConfig: hasValue ? merged : undefined };
    });
  };

  const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
  const updateMessageConfig = (updates: Partial<MessageConfig>) => {
    setConfig((prev) => ({
      ...prev,
      messageConfig: { ...msgCfg, ...prev.messageConfig, ...updates },
    }));
  };

  const addWhitelistUser = (userId: number) => {
    setConfig((prev) => ({
      ...prev,
      privateChatWhitelist: [...(prev.privateChatWhitelist ?? []), userId],
    }));
  };

  const removeWhitelistUser = (userId: number) => {
    setConfig((prev) => ({
      ...prev,
      privateChatWhitelist: (prev.privateChatWhitelist ?? []).filter((id) => id !== userId),
    }));
  };

  const addGroupOverride = (chatId: number, chatTitle?: string) => {
    const key = String(chatId);
    const override: AiGroupOverride = {
      chatId,
      chatTitle,
      enabled: true,
      whitelisted: true,
    };
    setConfig((prev) => ({
      ...prev,
      groupOverrides: { ...prev.groupOverrides, [key]: override },
    }));
  };

  const updateOverride = (key: string, updates: Partial<AiGroupOverride>) => {
    setConfig((prev) => ({
      ...prev,
      groupOverrides: {
        ...prev.groupOverrides,
        [key]: { ...prev.groupOverrides[key]!, ...updates },
      },
    }));
  };

  const removeOverride = (key: string) => {
    setConfig((prev) => {
      const { [key]: _, ...rest } = prev.groupOverrides;
      return { ...prev, groupOverrides: rest };
    });
  };

  const managedProvider =
    config.providers?.find((provider) => provider.id === managedProviderId) ??
    config.providers?.find((provider) => provider.id === config.activeProviderId) ??
    config.providers?.[0];
  const updateManagedProvider = (updates: Partial<NonNullable<typeof managedProvider>>) => {
    if (!managedProvider) return;
    setConfig((prev) => ({
      ...prev,
      providers: prev.providers.map((provider) =>
        provider.id === managedProvider.id ? { ...provider, ...updates } : provider,
      ),
    }));
  };

  const renameManagedProviderModel = (currentId: string, nextId: string) => {
    if (!managedProvider) return;
    const renamed = renameProviderModelReferences({
      config,
      summaryConfig,
      imageOcrConfig,
      providerId: managedProvider.id,
      currentId,
      nextId,
    });
    setConfig(renamed.config);
    setSummaryConfig(renamed.summaryConfig);
    setImageOcrConfig(renamed.imageOcrConfig);
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">{t("common.loading")}</p>;
  }

  const SaveStatusIcon = saveStatus.icon;

  return (
    <>
      <div className="mx-auto max-w-[1180px] space-y-5" inert={leaveDialogOpen ? true : undefined}>
        <div
          ref={settingsHeaderRef}
          data-testid="ai-settings-sticky-header"
          className="sticky top-0 z-20 -mx-2 space-y-3 bg-slate-50/95 px-2 pt-1 pb-3 backdrop-blur-xl supports-[backdrop-filter]:bg-slate-50/85 md:rounded-b-2xl md:shadow-[0_12px_24px_-22px_rgb(15_23_42/0.55)]"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-balance">{t("page.title")}</h1>
              <p className="mt-1 hidden text-sm text-slate-500 sm:block">{t("page.description")}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setPreviewOpen(true)}>
                <Eye className="h-4 w-4" />
                <span className="hidden sm:inline">{t("page.previewPrompt")}</span>
                <span className="sm:hidden">{t("page.preview")}</span>
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveDisabledReason !== null}
                aria-describedby="ai-settings-save-help"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("common.saving")}
                  </>
                ) : configApplyRetryPending && !isConfigDirty ? (
                  t("page.retryApply")
                ) : (
                  t("common.save")
                )}
              </Button>
            </div>
          </div>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
            role="status"
            aria-live="polite"
          >
            <p
              className={`inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ring-1 ${saveStatus.className}`}
            >
              <SaveStatusIcon aria-hidden="true" className="size-3.5" />
              {saveStatus.label}
            </p>
            <p id="ai-settings-save-help" className="min-w-0 text-slate-600">
              {saveDisabledReason ??
                t(
                  configApplyRetryPending && !isConfigDirty
                    ? "page.readyToRetryApply"
                    : "page.readyToSave",
                )}
            </p>
          </div>
          <AiSettingsSearch
            items={settingItems}
            onSelect={(settingId) => {
              setPendingFocusSettingId(settingId);
              setActiveSetting(settingId);
            }}
            labels={{
              search: t("navigation.searchSettings"),
              clear: t("navigation.clearSearch"),
              noResults: t("navigation.noSearchResults"),
              resultCount: (count) => t("navigation.searchResultCount", { count }),
            }}
          />
          <AiSettingsNavigation
            items={sectionItems}
            activeId={activeSection}
            onChange={setActiveSection}
          />
        </div>

        {saveStatus.detail && (
          <p
            data-testid="ai-settings-error-detail"
            className="min-w-0 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm break-words text-red-800"
          >
            {saveStatus.detail}
          </p>
        )}

        <PromptPreviewDialog
          botId={botId!}
          config={{
            ...config,
            triggerConfig: {
              ...config.triggerConfig,
              triggerWords: triggerWordsText
                .split(",")
                .map((word) => word.trim())
                .filter(Boolean),
            },
          }}
          stickerPacks={stickerPacksText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)}
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
        />

        <fieldset
          disabled={saving}
          aria-busy={saving}
          className="min-w-0 space-y-5 disabled:opacity-70"
        >
          <div className="min-w-0">
            <header className="mb-5 flex items-end justify-between gap-4 px-1">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  {sectionItems.find((item) => item.id === activeSection)?.label}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {sectionItems.find((item) => item.id === activeSection)?.description}
                </p>
              </div>
            </header>

            {activeSection === "overview" && (
              <OverviewSection
                config={{ ...config, summaryConfig, imageOcrConfig }}
                onEnabledChange={(enabled) => setConfig((prev) => ({ ...prev, enabled }))}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === "providers" && (
              <div className="space-y-5">
                {globalSelection && globalSelectionDraft && (
                  <GlobalAiSelectionSection
                    selection={globalSelection}
                    draft={globalSelectionDraft}
                    canManage={canManageAiSelection}
                    saving={savingSelection}
                    retrying={retryingSelection}
                    onChange={setGlobalSelectionDraft}
                    onSave={() => void handleSelectionSave()}
                    onDiscard={handleSelectionDiscard}
                    onRetry={() => void handleSelectionRetry()}
                  />
                )}
                <ProvidersSection
                  providers={config.providers ?? []}
                  activeProviderId={globalSelectionDraft?.providerId ?? config.activeProviderId}
                  managedProviderId={managedProvider?.id}
                  draftApiKeys={providerApiKeys}
                  canChangeActiveProvider={canManageAiSelection && globalSelectionDraft !== null}
                  onProvidersChange={(providers) =>
                    setConfig((prev) => ({
                      ...prev,
                      providers,
                      conversationConfig:
                        prev.conversationConfig?.compressionProviderId &&
                        !providers.some(
                          (provider) =>
                            provider.id === prev.conversationConfig?.compressionProviderId,
                        )
                          ? { ...prev.conversationConfig, compressionProviderId: undefined }
                          : prev.conversationConfig,
                    }))
                  }
                  onActiveProviderChange={(providerId) => {
                    const provider = globalSelection?.options.find(
                      (option) => option.id === providerId,
                    );
                    if (!provider || !globalSelectionDraft) {
                      setMessage({ type: "error", text: t("selection.unavailable") });
                      return;
                    }
                    setGlobalSelectionDraft({
                      ...globalSelectionDraft,
                      providerId,
                      modelId: provider.defaultModelId,
                    });
                  }}
                  onManagedProviderChange={setManagedProviderId}
                  onDraftApiKeyChange={(id, key) =>
                    setProviderApiKeys((prev) => {
                      if (!key) {
                        const { [id]: _, ...rest } = prev;
                        return rest;
                      }
                      return { ...prev, [id]: key };
                    })
                  }
                />

                {managedProvider && (
                  <ModelsSection
                    botId={botId!}
                    models={managedProvider.models ?? []}
                    activeModel={managedProvider.defaultModel}
                    modelCommandAccess={config.modelCommandAccess ?? "admin"}
                    providerId={managedProvider.id}
                    providerLabel={managedProvider.label}
                    baseURL={managedProvider.baseURL}
                    apiKey={providerApiKeys[managedProvider.id] ?? ""}
                    modelDiscoveryPath={
                      managedProvider.modelDiscoveryPath ??
                      (managedProvider.providerFormat === "openai" ? "/models" : "")
                    }
                    onModelsChange={(models) => updateManagedProvider({ models })}
                    onActiveModelChange={(defaultModel) => updateManagedProvider({ defaultModel })}
                    onModelRename={renameManagedProviderModel}
                    onModelCommandAccessChange={(modelCommandAccess) =>
                      setConfig((prev) => ({ ...prev, modelCommandAccess }))
                    }
                    onError={(text) => setMessage({ type: "error", text })}
                  />
                )}
              </div>
            )}

            {activeSection === "replies" && (
              <div className="space-y-3">
                <SettingsDisclosureRow
                  {...disclosureProps("reply-prompts")}
                  title={t("disclosures.replyPrompts.title")}
                  description={t("disclosures.replyPrompts.description")}
                  defaultOpen
                  flattenCard={false}
                >
                  <GlobalSettingsSection
                    config={config}
                    onConfigChange={(updates) => setConfig((prev) => ({ ...prev, ...updates }))}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("engagement")}
                  title={t("engagement.title")}
                  description={t("engagement.description")}
                  summary={t(`engagement.modes.${config.engagement?.mode ?? "off"}`)}
                >
                  <EngagementSection
                    config={config.engagement}
                    apiKey={engagementApiKey}
                    onApiKeyChange={setEngagementApiKey}
                    onChange={(engagement) => setConfig((prev) => ({ ...prev, engagement }))}
                  />
                  {botId && (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5">
                      <p className="text-muted-foreground text-xs">
                        {t("engagement.reviewRecordsHelp")}
                      </p>
                      <Link
                        to={`/bots/${botId}/debugger?tab=engagement`}
                        className="focus-visible:ring-ring border-input inline-flex h-10 items-center justify-center rounded-lg border bg-white px-3.5 text-sm font-semibold transition-[background-color,border-color,color] hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {t("engagement.reviewRecords")}
                      </Link>
                    </div>
                  )}
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("triggers")}
                  title={t("disclosures.triggers.title")}
                  description={t("disclosures.triggers.description")}
                  summary={t("disclosures.triggers.summary", {
                    count: config.triggerConfig.triggerWords.length,
                  })}
                >
                  <TriggerSettingsSection
                    config={config.triggerConfig}
                    triggerWordsText={triggerWordsText}
                    onTriggerWordsTextChange={setTriggerWordsText}
                    onUpdate={updateTrigger}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("conversation-context")}
                  title={t("disclosures.conversationContext.title")}
                  description={t("disclosures.conversationContext.description")}
                >
                  <ConversationSection
                    config={convCfg}
                    providers={config.providers}
                    activeProviderId={globalSelectionDraft?.providerId ?? config.activeProviderId}
                    onUpdate={updateConv}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("execution")}
                  title={t("disclosures.execution.title")}
                  description={t("disclosures.execution.description")}
                  summary={t("disclosures.execution.summary", {
                    count: executionConfig.maxConcurrentReplies ?? "–",
                  })}
                >
                  <ExecutionConfigSection config={executionConfig} onUpdate={setExecutionConfig} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("message-delivery")}
                  title={t("disclosures.messageDelivery.title")}
                  description={t("disclosures.messageDelivery.description")}
                >
                  <MessageSplittingSection
                    config={msgCfg}
                    platform={loadedBot?.id === botId ? loadedBot?.platform : undefined}
                    onUpdate={updateMessageConfig}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("timeouts")}
                  title={t("disclosures.timeouts.title")}
                  description={t("disclosures.timeouts.description")}
                >
                  <TimeoutSection config={timeoutCfg} onUpdate={updateTimeoutConfig} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("sticker-packs")}
                  title={t("disclosures.stickerPacks.title")}
                  description={t("disclosures.stickerPacks.description")}
                >
                  <StickerPacksSection
                    stickerPacksText={stickerPacksText}
                    onStickerPacksTextChange={setStickerPacksText}
                  />
                </SettingsDisclosureRow>
              </div>
            )}

            {activeSection === "memory" && (
              <div className="space-y-3">
                <SettingsDisclosureRow
                  {...disclosureProps("conversation-memory")}
                  title={t("disclosures.conversationMemory.title")}
                  description={t("disclosures.conversationMemory.description")}
                  summary={memCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <MemorySystemSection config={memCfg} onUpdate={updateMemory} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("bot-memory")}
                  title={t("disclosures.botMemory.title")}
                  description={t("disclosures.botMemory.description")}
                  summary={botMemCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <BotMemorySection config={botMemCfg} onUpdate={updateBotMemory} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("embeddings")}
                  title={t("disclosures.embeddings.title")}
                  description={t("disclosures.embeddings.description")}
                  summary={embCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <EmbeddingSection config={embCfg} onUpdate={updateEmbedding} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("chat-summaries")}
                  title={t("disclosures.chatSummaries.title")}
                  description={t("disclosures.chatSummaries.description")}
                  summary={summaryConfig.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <SummaryConfigSection
                    botId={botId!}
                    config={summaryConfig}
                    onUpdate={(updates) => setSummaryConfig((prev) => ({ ...prev, ...updates }))}
                  />
                </SettingsDisclosureRow>
              </div>
            )}

            {activeSection === "tools" && (
              <div className="space-y-3">
                <SettingsDisclosureRow
                  {...disclosureProps("web-tools")}
                  title={t("disclosures.webTools.title")}
                  description={t("disclosures.webTools.description")}
                  summary={webCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <WebToolsSection
                    config={webCfg}
                    searchApiKey={webSearchApiKey}
                    imageApiKey={webImageApiKey}
                    onSearchApiKeyChange={setWebSearchApiKey}
                    onImageApiKeyChange={setWebImageApiKey}
                    onUpdate={updateWebTools}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("image-generation-receipt")}
                  title={t("disclosures.imageGenerationReceipt.title")}
                  description={t("disclosures.imageGenerationReceipt.description")}
                  summary={t("disclosures.imageGenerationReceipt.summary", {
                    count: imageGenerationReceiptConfig.promptPreviewLength,
                  })}
                >
                  <ImageGenerationReceiptSection
                    config={imageGenerationReceiptConfig}
                    onUpdate={updateImageGenerationReceiptConfig}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("github-tools")}
                  title={t("disclosures.githubTools.title")}
                  description={t("disclosures.githubTools.description")}
                  summary={githubCfg.enabled ? t("common.enabled") : t("common.disabled")}
                  defaultOpen={openGitHubAfterCallback}
                >
                  <GitHubToolsSection
                    botId={botId!}
                    canManageCredentials={canManageGitHubCredentials}
                    authorizationBlocked={isDirty || !config.githubToolsConfig}
                    providers={config.providers ?? []}
                    providerApiKeyDrafts={providerApiKeys}
                    config={githubCfg}
                    onUpdate={updateGitHubTools}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("agent-tools")}
                  title={t("disclosures.agentTools.title")}
                  description={t("disclosures.agentTools.description")}
                  summary={agentCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <AgentToolsSection config={agentCfg} onUpdate={updateAgentTools} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("artwork-tools")}
                  title={t("disclosures.artworkTools.title")}
                  description={t("disclosures.artworkTools.description")}
                  summary={artworkCfg.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <ArtworkToolsSection config={artworkCfg} onUpdate={updateArtworkTools} />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("mcp-servers")}
                  title={t("disclosures.mcpServers.title")}
                  description={t("disclosures.mcpServers.description")}
                  summary={t("disclosures.mcpServers.summary", {
                    count: config.mcpServerIds?.length ?? 0,
                  })}
                >
                  <McpServersSection
                    selectedIds={config.mcpServerIds ?? []}
                    onUpdate={(ids) => setConfig((prev) => ({ ...prev, mcpServerIds: ids }))}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("image-ocr")}
                  title={t("disclosures.imageOcr.title")}
                  description={t("disclosures.imageOcr.description")}
                  summary={imageOcrConfig.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <ImageOcrConfigSection
                    config={imageOcrConfig}
                    providers={config.providers}
                    activeProviderId={config.activeProviderId}
                    onUpdate={(updates) => setImageOcrConfig((prev) => ({ ...prev, ...updates }))}
                  />
                </SettingsDisclosureRow>
              </div>
            )}

            {activeSection === "access" && (
              <div className="space-y-3">
                <SettingsDisclosureRow
                  {...disclosureProps("private-whitelist")}
                  title={t("disclosures.privateWhitelist.title")}
                  description={t("disclosures.privateWhitelist.description")}
                  summary={t("disclosures.privateWhitelist.summary", {
                    mode: t(
                      `privateWhitelist.access${
                        config.privateChatAccess === "admin"
                          ? "Admin"
                          : config.privateChatAccess === "allowlist"
                            ? "Allowlist"
                            : "All"
                      }`,
                    ),
                  })}
                >
                  <PrivateChatWhitelistSection
                    whitelist={config.privateChatWhitelist ?? []}
                    accessMode={config.privateChatAccess ?? "all"}
                    onAccessModeChange={(privateChatAccess) =>
                      setConfig((prev) => ({ ...prev, privateChatAccess }))
                    }
                    onAdd={addWhitelistUser}
                    onRemove={removeWhitelistUser}
                  />
                </SettingsDisclosureRow>
                <SettingsDisclosureRow
                  {...disclosureProps("group-overrides")}
                  title={t("disclosures.groupOverrides.title")}
                  description={t("disclosures.groupOverrides.description")}
                  summary={t("disclosures.groupOverrides.summary", {
                    count: Object.keys(config.groupOverrides).length,
                  })}
                >
                  <GroupOverridesSection
                    overrides={config.groupOverrides}
                    engagement={config.engagement}
                    onAdd={addGroupOverride}
                    onUpdate={updateOverride}
                    onRemove={removeOverride}
                  />
                </SettingsDisclosureRow>
              </div>
            )}
          </div>
        </fieldset>
      </div>
      {leaveDialogOpen && (
        <UnsavedChangesDialog
          title={t("leave.title")}
          description={t("leave.description")}
          stayLabel={t("leave.stay")}
          leaveLabel={t("leave.leave")}
          busy={logoutConfirming}
          onStay={handleStayOnPage}
          onLeave={handleLeavePage}
        />
      )}
    </>
  );
}
