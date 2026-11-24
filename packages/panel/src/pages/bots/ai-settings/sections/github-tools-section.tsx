import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import type { AiProviderEntryPublic, GitHubToolsConfigPublic } from "@cos-tool-bot/shared";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  ServerCog,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type GitHubAppInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  permissions?: Record<string, string>;
};

export type GitHubAppStatus = {
  available: boolean;
  configurationError?: string;
  connectionError?: string;
  connected: boolean;
  legacyPat: boolean;
  installation?: GitHubAppInstallation;
};

type ApiSuccess<T> = { ok: true; data: T };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string };
      message?: string;
    };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function InstallationStatus({ status }: { status: GitHubAppStatus }) {
  const { t } = useTranslation("aiSettings");
  const installation = status.installation;

  if (!status.available) {
    return (
      <div className="border-warning-border bg-warning-soft text-warning rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <ServerCog className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t("githubTools.appUnavailableTitle")}</p>
            <p className="mt-1 text-xs leading-5">{t("githubTools.appUnavailableDescription")}</p>
            {status.configurationError && (
              <p className="mt-2 font-mono text-xs break-words">{status.configurationError}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!status.connected || !installation) {
    return (
      <div className="border-border bg-background rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <GitBranch className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{t("githubTools.notConnectedTitle")}</p>
              <Badge variant="muted">{t("githubTools.notConnectedBadge")}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              {t("githubTools.notConnectedDescription")}
            </p>
            {status.legacyPat && (
              <p className="text-warning mt-2 text-xs font-medium">
                {t("githubTools.legacyPatNotice")}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const permissionEntries = Object.entries(installation.permissions ?? {});

  return (
    <div className="border-success-border bg-success-soft/60 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <CheckCircle2 className="text-success mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold">{installation.accountLogin}</p>
              <Badge className="border-success-border text-success bg-white">
                {t("githubTools.connectedBadge")}
              </Badge>
              <Badge variant="muted">{installation.accountType}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("githubTools.repositorySelection", {
                selection:
                  installation.repositorySelection === "all"
                    ? t("githubTools.repositorySelectionAll")
                    : t("githubTools.repositorySelectionSelected"),
              })}
            </p>
          </div>
        </div>
        <span className="text-muted-foreground font-mono text-[11px]">
          {t("githubTools.installationId", { id: installation.installationId })}
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="text-foreground text-xs font-semibold">
            {t("githubTools.authorizedRepositories")}
          </p>
          {installation.repositories.length > 0 ? (
            <ul className="text-foreground mt-2 max-h-32 space-y-1 overflow-y-auto text-xs">
              {installation.repositories.map((repository) => (
                <li key={repository} className="font-mono break-all">
                  {repository}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("githubTools.noAuthorizedRepositories")}
            </p>
          )}
        </div>
        <div>
          <p className="text-foreground text-xs font-semibold">
            {t("githubTools.authorizedPermissions")}
          </p>
          {permissionEntries.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {permissionEntries.map(([permission, level]) => (
                <li key={permission}>
                  <Badge variant="muted">
                    {permission}: {level}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("githubTools.permissionsUnavailable")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function GitHubToolsSection({
  botId,
  canManageCredentials,
  authorizationBlocked,
  providers,
  providerApiKeyDrafts = {},
  config,
  onUpdate,
}: {
  botId: string;
  canManageCredentials: boolean;
  authorizationBlocked: boolean;
  providers: AiProviderEntryPublic[];
  providerApiKeyDrafts?: Readonly<Record<string, string>>;
  config: GitHubToolsConfigPublic;
  onUpdate: (updates: Partial<GitHubToolsConfigPublic>) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const [appStatus, setAppStatus] = useState<GitHubAppStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(canManageCredentials);
  const [operation, setOperation] = useState<"authorize" | "refresh" | "disconnect" | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [createIssueConfirmationMinutesDraft, setCreateIssueConfirmationMinutesDraft] = useState(
    () => String(config.createIssueConfirmationTtlMinutes ?? 10),
  );
  const statusRequestSequence = useRef(0);
  const codingProvider = providers.find((provider) => provider.id === config.codingProviderId);
  const providerHasApiKey = (provider: AiProviderEntryPublic) =>
    provider.hasApiKey || !!providerApiKeyDrafts[provider.id]?.trim();
  const codingProviderHasApiKey = codingProvider ? providerHasApiKey(codingProvider) : false;
  const codingModels = codingProvider
    ? [
        codingProvider.defaultModel,
        ...(codingProvider.models?.map((model) => model.id) ?? []),
      ].filter((modelId, index, modelIds) => modelId && modelIds.indexOf(modelId) === index)
    : [];
  const codingModelIsStale = !!config.codingModelId && !codingModels.includes(config.codingModelId);

  const loadAppStatus = useCallback(
    async (signal?: AbortSignal) => {
      const requestSequence = ++statusRequestSequence.current;
      const isCurrent = () =>
        requestSequence === statusRequestSequence.current && signal?.aborted !== true;
      if (!canManageCredentials) {
        setAppStatus(null);
        setStatusLoading(false);
        setConnectionError("");
        return;
      }
      setStatusLoading(true);
      setConnectionError("");
      try {
        const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/github-app`, {
          signal,
        });
        if (!isCurrent()) return;
        if (!response.ok) {
          const message = await readError(response, t("githubTools.statusLoadError"));
          if (isCurrent()) setConnectionError(message);
          return;
        }
        const body = (await response.json()) as ApiSuccess<GitHubAppStatus>;
        if (!isCurrent()) return;
        setAppStatus(body.data);
      } catch (error) {
        if (!isCurrent() || (error instanceof DOMException && error.name === "AbortError")) return;
        setConnectionError(t("githubTools.statusLoadError"));
      } finally {
        if (isCurrent()) setStatusLoading(false);
      }
    },
    [botId, canManageCredentials, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadAppStatus(controller.signal);
    return () => {
      controller.abort();
      statusRequestSequence.current += 1;
    };
  }, [loadAppStatus]);

  useEffect(() => {
    setCreateIssueConfirmationMinutesDraft(String(config.createIssueConfirmationTtlMinutes ?? 10));
  }, [config.createIssueConfirmationTtlMinutes]);

  const authorize = async (refresh = false) => {
    setOperation(refresh ? "refresh" : "authorize");
    setConnectionError("");
    try {
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/github-app/authorize${refresh ? "?refresh=1" : ""}`,
        { method: "POST" },
      );
      if (!response.ok) {
        setConnectionError(await readError(response, t("githubTools.authorizeError")));
        return;
      }
      const body = (await response.json()) as ApiSuccess<{
        url?: string;
        authorizationUrl?: string;
      }>;
      const authorizationUrl = body.data.url ?? body.data.authorizationUrl;
      if (!authorizationUrl) {
        setConnectionError(t("githubTools.authorizeError"));
        return;
      }
      window.location.assign(authorizationUrl);
    } catch {
      setConnectionError(t("githubTools.authorizeError"));
    } finally {
      setOperation(null);
    }
  };

  const visibleConnectionError = connectionError || appStatus?.connectionError;

  const disconnect = async () => {
    if (!window.confirm(t("githubTools.disconnectConfirm"))) return;
    setOperation("disconnect");
    setConnectionError("");
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/github-app`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setConnectionError(await readError(response, t("githubTools.disconnectError")));
        return;
      }
      await loadAppStatus();
    } catch {
      setConnectionError(t("githubTools.disconnectError"));
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch
          id="githubToolsEnabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => onUpdate({ enabled })}
        />
        <label htmlFor="githubToolsEnabled" className="text-sm font-medium">
          {t("githubTools.enable")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.securityDescription")}</p>

      {canManageCredentials && (
        <section aria-labelledby="github-app-connection-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 id="github-app-connection-title" className="text-sm font-semibold">
                {t("githubTools.appConnectionTitle")}
              </h3>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("githubTools.appConnectionDescription")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={
                  statusLoading ||
                  operation !== null ||
                  !appStatus?.available ||
                  authorizationBlocked
                }
                onClick={() => void authorize()}
              >
                {operation === "authorize" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ExternalLink className="size-4" aria-hidden="true" />
                )}
                {appStatus?.connected
                  ? t("githubTools.modifyAuthorization")
                  : t("githubTools.connectGitHub")}
              </Button>
              {appStatus?.connected && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    statusLoading ||
                    operation !== null ||
                    !appStatus.available ||
                    authorizationBlocked
                  }
                  onClick={() => void authorize(true)}
                >
                  {t("githubTools.refreshAuthorization")}
                </Button>
              )}
              {appStatus?.connected && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={operation !== null}
                  onClick={() => void disconnect()}
                >
                  {operation === "disconnect" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Unplug className="size-4" aria-hidden="true" />
                  )}
                  {t("githubTools.disconnect")}
                </Button>
              )}
            </div>
          </div>

          {authorizationBlocked && appStatus?.available && (
            <p className="text-warning text-xs font-medium">
              {t("githubTools.saveBeforeAuthorization")}
            </p>
          )}

          {statusLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-lg border p-4 text-xs">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("githubTools.loadingStatus")}
            </div>
          ) : appStatus ? (
            <InstallationStatus status={appStatus} />
          ) : null}

          {visibleConnectionError && (
            <div
              role="alert"
              className="border-danger-border bg-danger-soft text-destructive flex items-start gap-2 rounded-lg border p-3 text-xs"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{visibleConnectionError}</span>
            </div>
          )}
        </section>
      )}

      {canManageCredentials && (
        <section aria-labelledby="github-create-issue-confirmation-title" className="space-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id="githubCreateIssueConfirmationNeverExpires"
              disabled={!config.enabled}
              checked={config.createIssueConfirmationTtlMinutes == null}
              onCheckedChange={(neverExpires) =>
                onUpdate({
                  createIssueConfirmationTtlMinutes: neverExpires
                    ? null
                    : (config.createIssueConfirmationTtlMinutes ?? 10),
                })
              }
            />
            <label
              id="github-create-issue-confirmation-title"
              htmlFor="githubCreateIssueConfirmationNeverExpires"
              className="text-sm font-medium"
            >
              {t("githubTools.createIssueConfirmationNeverExpires")}
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("githubTools.createIssueConfirmationDescription")}
          </p>
          {config.createIssueConfirmationTtlMinutes != null && (
            <div className="max-w-xs space-y-1.5">
              <label htmlFor="githubCreateIssueConfirmationMinutes" className="text-sm font-medium">
                {t("githubTools.createIssueConfirmationMinutes")}
              </label>
              <Input
                id="githubCreateIssueConfirmationMinutes"
                type="number"
                min={1}
                step={1}
                disabled={!config.enabled}
                value={createIssueConfirmationMinutesDraft}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const minutes = event.currentTarget.valueAsNumber;
                  setCreateIssueConfirmationMinutesDraft(value);
                  if (Number.isSafeInteger(minutes) && minutes >= 1) {
                    onUpdate({ createIssueConfirmationTtlMinutes: minutes });
                  }
                }}
                onBlur={() => {
                  const minutes = Number(createIssueConfirmationMinutesDraft);
                  if (!Number.isSafeInteger(minutes) || minutes < 1) {
                    setCreateIssueConfirmationMinutesDraft(
                      String(config.createIssueConfirmationTtlMinutes ?? 10),
                    );
                  }
                }}
              />
            </div>
          )}
        </section>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="githubPublicReadEnabled"
          disabled={!config.enabled}
          checked={config.publicReadEnabled}
          onCheckedChange={(publicReadEnabled) => onUpdate({ publicReadEnabled })}
        />
        <label htmlFor="githubPublicReadEnabled" className="text-sm font-medium">
          {t("githubTools.publicRead")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.publicReadDescription")}</p>

      <div className="flex items-center gap-2">
        <Switch
          id="githubCodingAgentEnabled"
          disabled={!config.enabled}
          checked={config.codingAgentEnabled}
          onCheckedChange={(codingAgentEnabled) => onUpdate({ codingAgentEnabled })}
        />
        <label htmlFor="githubCodingAgentEnabled" className="text-sm font-medium">
          {t("githubTools.codingAgent")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.codingAgentDescription")}</p>

      {config.codingAgentEnabled && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="githubCodingProvider" className="text-sm font-medium">
                {t("githubTools.codingProvider")}
              </label>
              <Select
                id="githubCodingProvider"
                disabled={!config.enabled}
                value={config.codingProviderId ?? ""}
                onChange={(event) => {
                  const codingProviderId = event.target.value || undefined;
                  onUpdate({ codingProviderId, codingModelId: undefined });
                }}
              >
                <option value="">{t("githubTools.followChatProvider")}</option>
                {config.codingProviderId && !codingProvider && (
                  <option value={config.codingProviderId}>
                    {t("githubTools.unavailableProvider", { id: config.codingProviderId })}
                  </option>
                )}
                {providers.map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={!providerHasApiKey(provider)}
                  >
                    {providerHasApiKey(provider)
                      ? provider.label
                      : t("githubTools.providerMissingApiKey", { provider: provider.label })}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="githubCodingModel" className="text-sm font-medium">
                {t("githubTools.codingModel")}
              </label>
              <Select
                id="githubCodingModel"
                disabled={!config.enabled || !codingProvider || !codingProviderHasApiKey}
                value={config.codingModelId ?? ""}
                onChange={(event) => onUpdate({ codingModelId: event.target.value || undefined })}
              >
                <option value="">
                  {codingProvider
                    ? t("githubTools.providerDefaultModel", {
                        model: codingProvider.defaultModel,
                      })
                    : t("githubTools.followChatModel")}
                </option>
                {codingModelIsStale && (
                  <option value={config.codingModelId}>
                    {t("githubTools.unavailableModel", { id: config.codingModelId })}
                  </option>
                )}
                {codingModels.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {codingProvider?.models?.find((model) => model.id === modelId)?.label ??
                      modelId}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t("githubTools.codingModelDescription")}</p>
          {config.codingProviderId && !codingProvider && (
            <p className="text-destructive text-xs font-medium">
              {t("githubTools.codingSelectionInvalid")}
            </p>
          )}
          {codingProvider && !codingProviderHasApiKey && (
            <p className="text-destructive text-xs font-medium">
              {t("githubTools.codingProviderMissingApiKey")}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.authorName")}</label>
          <Input
            disabled={!config.enabled}
            value={config.authorName}
            onChange={(event) => onUpdate({ authorName: event.target.value })}
            placeholder="Hanori"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.authorEmail")}</label>
          <Input
            type="email"
            disabled={!config.enabled}
            value={config.authorEmail}
            onChange={(event) => onUpdate({ authorEmail: event.target.value })}
            placeholder="hanori@example.invalid"
          />
        </div>
      </div>

      {config.hasToken && (
        <div className="space-y-1.5">
          <label htmlFor="legacyGitHubRepositories" className="text-sm font-medium">
            {t("githubTools.repositories")}
          </label>
          <Textarea
            id="legacyGitHubRepositories"
            disabled={!config.enabled}
            value={config.repositories.join("\n")}
            onChange={(event) =>
              onUpdate({
                repositories: event.target.value
                  .split(/[,\n]/)
                  .map((value) => value.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
            placeholder={"owner/repository\nowner/private-repository"}
            rows={5}
          />
          <p className="text-muted-foreground text-xs">
            {t("githubTools.repositoriesDescription")}
          </p>
        </div>
      )}
    </div>
  );
}
