import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import {
  DEFAULT_IMAGE_ROUTE_COPY,
  getDefaultUsageLimits,
  type UsageResource,
  type UsageScope,
} from "@cos-tool-bot/shared";
import { Loader2, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { GovernanceSubjectPicker, type GovernanceSubjectOption } from "./governance-subject-picker";
import { createGovernanceSubjectResolver } from "./governance-subject-resolver";
import { ImageMcpPlatformSettings } from "./image-mcp-platform-settings";

type GeneralRouteMode = "off" | "explicit_only" | "semantic_auto";
interface ConnectionView {
  status: "disconnected" | "authorizing" | "connected" | "error";
  scopes: string[];
  lastError?: string;
}
type BackendId = "mcp_pixai" | "mcp_openai" | "mcp_gemini" | "general_backend";
const backendLabels: Record<BackendId, string> = {
  mcp_pixai: "PixAI",
  mcp_openai: "GPT Image",
  mcp_gemini: "Gemini Image",
  general_backend: "Legacy",
};
interface BackendDraft {
  backendId: BackendId;
  enabled: boolean;
  defaultPresetKey?: string;
  allowedPresetKeys: string[];
}
interface RouteDraft {
  defaultBackendId?: BackendId;
  backends?: BackendDraft[];
  purpose: "anime_illustration" | "general_image";
  enabled: boolean;
  label: string;
  useWhen: string;
  avoidWhen: string;
  examples: string[];
  defaultPresetKey?: string;
  allowedPresetKeys: string[];
}
function routeBindings(route: RouteDraft): BackendDraft[] {
  const defaultId =
    route.defaultBackendId ??
    (route.purpose === "anime_illustration" ? "mcp_pixai" : "general_backend");
  return (["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"] as const).map(
    (backendId) =>
      route.backends?.find((binding) => binding.backendId === backendId) ?? {
        backendId,
        enabled: backendId !== "general_backend" || route.purpose === "general_image",
        defaultPresetKey: backendId === defaultId ? route.defaultPresetKey : undefined,
        allowedPresetKeys: backendId === defaultId ? route.allowedPresetKeys : [],
      },
  );
}

interface LimitDraft {
  key: string;
  label: string;
  cooldownSeconds?: number;
  hourly?: number;
  daily?: number;
  monthly?: number;
  concurrency?: number;
}
interface PolicyDraft {
  resource: "ai_reply" | "image";
  scope: "chat" | "user_global" | "chat_user";
  subjectKey: string;
  cooldownSeconds?: number;
  hourly?: number;
  daily?: number;
  monthly?: number;
  concurrency?: number;
}
type SubjectKind = "chat" | "user";
interface SubjectSearchResult {
  id: string;
  name: string | null;
  username: string | null;
}
interface GovernanceDraft {
  timezone: string;
  connection: ConnectionView;
  connections?: Partial<Record<BackendId, ConnectionView>>;
  generalRouteMode: GeneralRouteMode;
  privateChatUserIds: Array<number | "">;
  routes: RouteDraft[];
  limits: LimitDraft[];
  overrides: PolicyDraft[];
}

function defaultLimitDraft(
  key: string,
  label: string,
  resource: UsageResource,
  scope: UsageScope,
): LimitDraft {
  const limits = getDefaultUsageLimits(resource, scope, "group");
  if (!limits) throw new Error(`Missing governance defaults for ${resource}:${scope}`);
  return {
    key,
    label,
    cooldownSeconds:
      limits.cooldownMs === undefined ? undefined : Math.floor(limits.cooldownMs / 1_000),
    hourly: limits.hour,
    daily: limits.day,
    monthly: limits.month,
    concurrency: limits.maxConcurrent,
  };
}

const DEFAULT_DRAFT: GovernanceDraft = {
  timezone: "Asia/Shanghai",
  connection: { status: "disconnected", scopes: [] },
  generalRouteMode: "off",
  privateChatUserIds: [],
  routes: [
    {
      purpose: "anime_illustration",
      defaultBackendId: "mcp_pixai",
      enabled: true,
      ...DEFAULT_IMAGE_ROUTE_COPY.anime_illustration,
      allowedPresetKeys: [],
    },
    {
      purpose: "general_image",
      defaultBackendId: "mcp_openai",
      enabled: false,
      ...DEFAULT_IMAGE_ROUTE_COPY.general_image,
      allowedPresetKeys: [],
    },
  ],
  limits: [
    defaultLimitDraft("ai_bot", "AI · Bot total", "ai_reply", "bot"),
    defaultLimitDraft("ai_chat_user", "AI · group user", "ai_reply", "chat_user"),
    defaultLimitDraft("ai_user_global", "AI · user across groups", "ai_reply", "user_global"),
    defaultLimitDraft("ai_chat", "AI · group total", "ai_reply", "chat"),
    defaultLimitDraft("image_bot", "Image · Bot total", "image", "bot"),
    defaultLimitDraft("image_chat_user", "Image · group user", "image", "chat_user"),
    defaultLimitDraft("image_user_global", "Image · user across groups", "image", "user_global"),
    defaultLimitDraft("image_chat", "Image · group total", "image", "chat"),
    defaultLimitDraft("proactive_bot", "Proactive replies · Bot", "proactive_reply", "bot"),
  ],
  overrides: [],
};

function createDefaultDraft(connection = DEFAULT_DRAFT.connection): GovernanceDraft {
  return {
    ...DEFAULT_DRAFT,
    connection: { ...connection, scopes: [...connection.scopes] },
    privateChatUserIds: [],
    routes: DEFAULT_DRAFT.routes.map((route) => ({
      ...route,
      examples: [...route.examples],
      allowedPresetKeys: [...route.allowedPresetKeys],
    })),
    limits: DEFAULT_DRAFT.limits.map((limit) => ({ ...limit })),
    overrides: [],
  };
}

function statusVariant(status: ConnectionView["status"]): "default" | "muted" | "destructive" {
  if (status === "connected") return "default";
  if (status === "error") return "destructive";
  return "muted";
}

function isValidPolicySubject(policy: PolicyDraft): boolean {
  if (policy.scope === "chat") return /^-\d+$/.test(policy.subjectKey);
  if (policy.scope === "user_global") return /^\d+$/.test(policy.subjectKey);
  return /^-\d+:\d+$/.test(policy.subjectKey);
}

function splitChatUserSubject(subjectKey: string): { chatId: string; userId: string } {
  const separatorIndex = subjectKey.indexOf(":");
  if (separatorIndex < 0)
    return { chatId: subjectKey.startsWith("-") ? subjectKey : "", userId: "" };
  return {
    chatId: subjectKey.slice(0, separatorIndex),
    userId: subjectKey.slice(separatorIndex + 1),
  };
}

export function BotGovernancePage() {
  const { botId } = useParams<{ botId: string }>();
  const { t } = useTranslation("bots");
  const [draft, setDraft] = useState<GovernanceDraft>(() => createDefaultDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [overrideErrors, setOverrideErrors] = useState<Record<number, string>>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);

  const searchSubjects = useCallback(
    async (
      kind: SubjectKind,
      query: string,
      signal: AbortSignal,
    ): Promise<GovernanceSubjectOption[]> => {
      if (!botId) return [];
      const params = new URLSearchParams({ kind, query });
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/governance/subjects?${params.toString()}`,
        { signal },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        subjects?: SubjectSearchResult[];
      };
      if (!response.ok || !body.ok || !body.subjects) throw new Error("subject_search_failed");
      return body.subjects.map((subject) => {
        const fallback =
          kind === "chat"
            ? t("governance.overrides.groupWithId", { id: subject.id })
            : t("governance.overrides.personWithId", { id: subject.id });
        const label = subject.name || (subject.username ? `@${subject.username}` : fallback);
        const details = [
          subject.name && subject.username ? `@${subject.username}` : undefined,
          `ID ${subject.id}`,
        ].filter(Boolean);
        return { value: subject.id, label, detail: details.join(" · ") };
      });
    },
    [botId, t],
  );
  const loadChats = useCallback(
    (query: string, signal: AbortSignal) => searchSubjects("chat", query, signal),
    [searchSubjects],
  );
  const loadUsers = useCallback(
    (query: string, signal: AbortSignal) => searchSubjects("user", query, signal),
    [searchSubjects],
  );
  const subjectResolver = useMemo(
    () => createGovernanceSubjectResolver(searchSubjects),
    [directoryRevision, searchSubjects],
  );
  useEffect(() => {
    subjectResolver.retain();
    return () => subjectResolver.release();
  }, [subjectResolver]);
  const resolveChat = useCallback(
    (value: string, signal: AbortSignal) => subjectResolver.resolve("chat", value, signal),
    [subjectResolver],
  );
  const resolveUser = useCallback(
    (value: string, signal: AbortSignal) => subjectResolver.resolve("user", value, signal),
    [subjectResolver],
  );
  const clearOverrideError = (index: number) => {
    setOverrideErrors((current) => {
      if (!(index in current)) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
  };

  const load = useCallback(async () => {
    if (!botId) return;
    setDirectoryRevision((revision) => revision + 1);
    setLoading(true);
    setMessage(undefined);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/governance`);
      const body = (await response.json()) as {
        ok?: boolean;
        data?: GovernanceDraft;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.data) throw new Error(body.error ?? "load_failed");
      setDraft(body.data);
    } catch {
      setMessage(t("governance.loadError"));
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!botId) return;
    const nextOverrideErrors = Object.fromEntries(
      draft.overrides.flatMap((policy, index) =>
        isValidPolicySubject(policy)
          ? []
          : [[index, t("governance.overrides.invalidSubject")] as const],
      ),
    );
    if (Object.keys(nextOverrideErrors).length > 0) {
      setOverrideErrors(nextOverrideErrors);
      setMessage(t("governance.overrides.invalidSubjectSummary"));
      return;
    }
    const seenOverrides = new Set<string>();
    for (const [index, policy] of draft.overrides.entries()) {
      const key = `${policy.resource}:${policy.scope}:${policy.subjectKey}`;
      if (seenOverrides.has(key)) {
        nextOverrideErrors[index] = t("governance.overrides.duplicateSubject");
      }
      seenOverrides.add(key);
    }
    if (Object.keys(nextOverrideErrors).length > 0) {
      setOverrideErrors(nextOverrideErrors);
      setMessage(t("governance.overrides.duplicateSubjectSummary"));
      return;
    }
    setOverrideErrors({});
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/governance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: draft.timezone,
          generalRouteMode: draft.generalRouteMode,
          privateChatUserIds: draft.privateChatUserIds.filter(
            (userId): userId is number => userId !== "",
          ),
          routes: draft.routes,
          limits: draft.limits,
          overrides: draft.overrides,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: GovernanceDraft;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.data) throw new Error(body.error ?? "save_failed");
      setDraft(body.data);
      setMessage(t("governance.saved"));
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "invalid_override_subject"
          ? t("governance.overrides.invalidSubjectSummary")
          : t("governance.saveError"),
      );
    } finally {
      setSaving(false);
    }
  };

  const beginOAuth = async (backendId: BackendId = "mcp_pixai") => {
    const prefix =
      backendId === "mcp_openai"
        ? "/api/image-mcp-openai"
        : backendId === "mcp_gemini"
          ? "/api/image-mcp-gemini"
          : "/api/image-mcp";
    try {
      const response = await authFetch(`${prefix}/oauth/start`, { method: "POST" });
      const body = (await response.json()) as { ok?: boolean; authorizationUrl?: string };
      if (response.ok && body.ok && body.authorizationUrl)
        window.location.assign(body.authorizationUrl);
      else setMessage(t("governance.connection.startError"));
    } catch {
      setMessage(t("governance.connection.startError"));
    }
  };

  const refreshConnections = async () => {
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId!)}/governance`);
      const body = (await response.json()) as { ok?: boolean; data?: GovernanceDraft };
      if (!response.ok || !body.ok || !body.data) throw new Error();
      const { connection, connections } = body.data;
      setDraft((current) => ({ ...current, connection, connections }));
    } catch {
      setMessage(t("governance.loadError"));
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t("governance.loading")}</span>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground text-sm font-medium">{t("governance.eyebrow")}</p>
          <h1 className="text-2xl font-bold tracking-tight">{t("governance.title")}</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            {t("governance.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("governance.refresh")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDirectoryRevision((revision) => revision + 1);
              setDraft((current) => ({
                ...createDefaultDraft(current.connection),
                connections: current.connections,
              }));
              setMessage(t("governance.resetReady"));
            }}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("governance.reset")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t("governance.save")}
          </Button>
        </div>
      </header>

      {message && (
        <p className="bg-muted rounded-lg px-3 py-2 text-sm" role="status">
          {message}
        </p>
      )}

      <ImageMcpPlatformSettings onSaved={() => void refreshConnections()} />

      {(["mcp_openai", "mcp_gemini"] as const).map((backendId) => (
        <Card key={backendId}>
          <CardHeader>
            <CardTitle>{backendLabels[backendId]}</CardTitle>
            <CardDescription>{t("governance.connection.independent")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Badge
              variant={statusVariant(draft.connections?.[backendId]?.status ?? "disconnected")}
            >
              {t(
                `governance.connection.status.${draft.connections?.[backendId]?.status ?? "disconnected"}`,
              )}
            </Badge>
            {draft.connections?.[backendId]?.lastError && (
              <p className="text-destructive text-sm">
                {draft.connections[backendId]?.lastError === "NOT_CONFIGURED"
                  ? t("governance.platform.notConfigured")
                  : draft.connections[backendId]?.lastError}
              </p>
            )}
            <Button
              type="button"
              disabled={draft.connections?.[backendId]?.lastError === "NOT_CONFIGURED"}
              onClick={() => void beginOAuth(backendId)}
            >
              {t("governance.connection.connect")}
            </Button>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("governance.connection.title")}</CardTitle>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("governance.connection.description")}
            </p>
          </div>
          <Badge variant={statusVariant(draft.connection.status)}>
            {t(`governance.connection.status.${draft.connection.status}`)}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ShieldCheck className="size-4" aria-hidden="true" />
            <span>{t("governance.connection.scopes")}</span>
            {draft.connection.scopes.length > 0
              ? draft.connection.scopes.map((scope) => (
                  <Badge key={scope} variant="muted">
                    {scope}
                  </Badge>
                ))
              : t("governance.connection.noScopes")}
          </div>
          {draft.connection.lastError && (
            <p className="text-destructive text-sm">
              {draft.connection.lastError === "NOT_CONFIGURED"
                ? t("governance.platform.notConfigured")
                : draft.connection.lastError}
            </p>
          )}
          <Button
            variant="outline"
            disabled={draft.connection.lastError === "NOT_CONFIGURED"}
            onClick={() => void beginOAuth()}
          >
            {draft.connection.status === "connected"
              ? t("governance.connection.reconnect")
              : t("governance.connection.connect")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t("governance.privateImages.title")}</CardTitle>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("governance.privateImages.description")}
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full shrink-0 sm:w-auto"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                privateChatUserIds: [...current.privateChatUserIds, ""],
              }))
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("governance.privateImages.add")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.privateChatUserIds.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("governance.privateImages.empty")}</p>
          ) : (
            draft.privateChatUserIds.map((userId, userIndex) => (
              <div
                key={`${userId}:${userIndex}`}
                className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-end"
              >
                <div className="grid flex-1 gap-2">
                  <Label htmlFor={`private-image-user-${userIndex}`}>
                    {t("governance.privateImages.userId")}
                  </Label>
                  <Input
                    id={`private-image-user-${userIndex}`}
                    type="number"
                    min={1}
                    step={1}
                    placeholder="123456789"
                    value={userId}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        privateChatUserIds: current.privateChatUserIds.map((item, index) =>
                          index === userIndex
                            ? event.target.value === ""
                              ? ""
                              : Number(event.target.value)
                            : item,
                        ),
                      }))
                    }
                  />
                </div>
                <Button
                  variant="outline"
                  aria-label={t("governance.privateImages.remove")}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      privateChatUserIds: current.privateChatUserIds.filter(
                        (_, index) => index !== userIndex,
                      ),
                    }))
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
          <p className="text-muted-foreground text-xs">{t("governance.privateImages.hint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("governance.routing.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2 sm:max-w-md">
            <Label htmlFor="general-route-mode">{t("governance.routing.generalMode")}</Label>
            <select
              id="general-route-mode"
              className="border-input bg-background h-10 rounded-md border px-3 text-sm"
              value={draft.generalRouteMode}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  generalRouteMode: event.target.value as GeneralRouteMode,
                }))
              }
            >
              <option value="off">{t("governance.routing.modes.off")}</option>
              <option value="explicit_only">{t("governance.routing.modes.explicit_only")}</option>
              <option value="semantic_auto">{t("governance.routing.modes.semantic_auto")}</option>
            </select>
            <p className="text-muted-foreground text-xs">{t("governance.routing.ambiguous")}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {draft.routes.map((route, routeIndex) => (
              <section key={route.purpose} className="rounded-xl border p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">{route.label}</p>
                    <code className="text-muted-foreground text-xs">{route.purpose}</code>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={route.enabled}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          routes: current.routes.map((item, index) =>
                            index === routeIndex
                              ? { ...item, enabled: event.target.checked }
                              : item,
                          ),
                        }))
                      }
                    />
                    {t("governance.routing.enabled")}
                  </label>
                </div>
                <div className="grid gap-3">
                  <Label htmlFor={`provider-${route.purpose}`}>
                    {t("governance.routing.defaultProvider")}
                  </Label>
                  <select
                    id={`provider-${route.purpose}`}
                    className="bg-background w-full min-w-0 rounded border px-3 py-2"
                    value={
                      route.defaultBackendId ??
                      (route.purpose === "anime_illustration" ? "mcp_pixai" : "general_backend")
                    }
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex
                            ? {
                                ...item,
                                backends: routeBindings(item),
                                defaultBackendId: event.target.value as BackendId,
                              }
                            : item,
                        ),
                      }))
                    }
                  >
                    {Object.entries(backendLabels).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {(["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"] as const).map(
                    (backendId) => {
                      const binding = routeBindings(route).find(
                        (binding) => binding.backendId === backendId,
                      )!;
                      const update = (patch: Partial<BackendDraft>) =>
                        setDraft((current) => ({
                          ...current,
                          routes: current.routes.map((item, index) =>
                            index === routeIndex
                              ? {
                                  ...item,
                                  backends: routeBindings(item).map((binding) =>
                                    binding.backendId === backendId
                                      ? { ...binding, ...patch }
                                      : binding,
                                  ),
                                }
                              : item,
                          ),
                        }));
                      return (
                        <fieldset className="min-w-0 space-y-3 rounded border p-3" key={backendId}>
                          <legend>{backendLabels[backendId]}</legend>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={binding.enabled}
                              onChange={(event) => update({ enabled: event.target.checked })}
                            />
                            {t("governance.routing.enabled")}
                          </label>
                          <Label htmlFor={`preset-${route.purpose}-${backendId}`}>
                            {t("governance.routing.defaultPreset")}
                          </Label>
                          <Input
                            id={`preset-${route.purpose}-${backendId}`}
                            value={binding.defaultPresetKey ?? ""}
                            onChange={(event) =>
                              update({ defaultPresetKey: event.target.value || undefined })
                            }
                          />
                          <Label htmlFor={`allowed-${route.purpose}-${backendId}`}>
                            {t("governance.routing.allowedPresets")}
                          </Label>
                          <Input
                            id={`allowed-${route.purpose}-${backendId}`}
                            value={binding.allowedPresetKeys.join(", ")}
                            onChange={(event) =>
                              update({
                                allowedPresetKeys: event.target.value
                                  .split(",")
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </fieldset>
                      );
                    },
                  )}
                  <Label htmlFor={`label-${route.purpose}`}>{t("governance.routing.label")}</Label>
                  <Input
                    id={`label-${route.purpose}`}
                    value={route.label}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex ? { ...item, label: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                  <Label htmlFor={`use-${route.purpose}`}>{t("governance.routing.useWhen")}</Label>
                  <Input
                    id={`use-${route.purpose}`}
                    value={route.useWhen}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex ? { ...item, useWhen: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                  <Label htmlFor={`avoid-${route.purpose}`}>
                    {t("governance.routing.avoidWhen")}
                  </Label>
                  <Input
                    id={`avoid-${route.purpose}`}
                    value={route.avoidWhen}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex ? { ...item, avoidWhen: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                  <Label htmlFor={`examples-${route.purpose}`}>
                    {t("governance.routing.examples")}
                  </Label>
                  <Textarea
                    id={`examples-${route.purpose}`}
                    value={route.examples.join("\n")}
                    placeholder={t("governance.routing.examplesPlaceholder")}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex
                            ? {
                                ...item,
                                examples: event.target.value
                                  .split("\n")
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              }
                            : item,
                        ),
                      }))
                    }
                  />
                </div>
              </section>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("governance.limits.title")}</CardTitle>
          <p className="text-muted-foreground text-sm">{t("governance.limits.description")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="governance-timezone">{t("governance.limits.timezone")}</Label>
            <Input
              id="governance-timezone"
              value={draft.timezone}
              onChange={(event) =>
                setDraft((current) => ({ ...current, timezone: event.target.value }))
              }
            />
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.scope")}</th>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.cooldown")}</th>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.hourly")}</th>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.daily")}</th>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.monthly")}</th>
                  <th className="px-3 py-2 font-medium">{t("governance.limits.concurrency")}</th>
                </tr>
              </thead>
              <tbody>
                {draft.limits.map((limit, limitIndex) => (
                  <tr key={limit.key} className="border-t">
                    <th className="px-3 py-2 font-medium">{limit.label}</th>
                    {(
                      ["cooldownSeconds", "hourly", "daily", "monthly", "concurrency"] as const
                    ).map((field) => (
                      <td key={field} className="px-2 py-2">
                        <Input
                          type="number"
                          min={0}
                          aria-label={`${limit.label} ${field}`}
                          value={limit[field] ?? ""}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              limits: current.limits.map((item, index) =>
                                index === limitIndex
                                  ? {
                                      ...item,
                                      [field]:
                                        event.target.value === ""
                                          ? undefined
                                          : Number(event.target.value),
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-xs">{t("governance.limits.tightenOnly")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <CardTitle>{t("governance.overrides.title")}</CardTitle>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("governance.overrides.description")}
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full shrink-0 sm:w-auto"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                overrides: [
                  ...current.overrides,
                  {
                    resource: "ai_reply",
                    scope: "chat",
                    subjectKey: "",
                    hourly: 10,
                    daily: 50,
                  },
                ],
              }))
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("governance.overrides.add")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.overrides.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("governance.overrides.empty")}</p>
          ) : (
            draft.overrides.map((policy, policyIndex) => {
              const chatUser = splitChatUserSubject(policy.subjectKey);
              const subjectError = overrideErrors[policyIndex];
              const updateSubject = (subjectKey: string) => {
                clearOverrideError(policyIndex);
                setDraft((current) => ({
                  ...current,
                  overrides: current.overrides.map((item, index) =>
                    index === policyIndex ? { ...item, subjectKey } : item,
                  ),
                }));
              };
              const pickerShared = {
                searchPlaceholder: t("governance.overrides.searchPlaceholder"),
                emptyText: t("governance.overrides.noSubjects"),
                loadErrorText: t("governance.overrides.subjectLoadError"),
                invalid: Boolean(subjectError),
              };
              return (
                <section
                  key={`${policy.resource}:${policy.scope}:${policyIndex}`}
                  className="relative space-y-4 rounded-xl border p-4 pr-14"
                >
                  <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[10rem_11rem_minmax(0,1fr)]">
                    <div className="grid min-w-0 gap-2">
                      <Label>{t("governance.overrides.resource")}</Label>
                      <select
                        aria-label={t("governance.overrides.resource")}
                        className="border-input bg-background h-10 min-w-0 rounded-md border px-3 text-sm"
                        value={policy.resource}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            overrides: current.overrides.map((item, index) =>
                              index === policyIndex
                                ? {
                                    ...item,
                                    resource: event.target.value as PolicyDraft["resource"],
                                  }
                                : item,
                            ),
                          }))
                        }
                      >
                        <option value="ai_reply">{t("governance.overrides.resources.ai")}</option>
                        <option value="image">{t("governance.overrides.resources.image")}</option>
                      </select>
                    </div>
                    <div className="grid min-w-0 gap-2">
                      <Label>{t("governance.overrides.scope")}</Label>
                      <select
                        aria-label={t("governance.overrides.scope")}
                        className="border-input bg-background h-10 min-w-0 rounded-md border px-3 text-sm"
                        value={policy.scope}
                        onChange={(event) => {
                          clearOverrideError(policyIndex);
                          setDraft((current) => ({
                            ...current,
                            overrides: current.overrides.map((item, index) =>
                              index === policyIndex
                                ? {
                                    ...item,
                                    scope: event.target.value as PolicyDraft["scope"],
                                    subjectKey: "",
                                  }
                                : item,
                            ),
                          }));
                        }}
                      >
                        <option value="chat">{t("governance.overrides.scopes.chat")}</option>
                        <option value="user_global">
                          {t("governance.overrides.scopes.user_global")}
                        </option>
                        <option value="chat_user">
                          {t("governance.overrides.scopes.chat_user")}
                        </option>
                      </select>
                    </div>
                    <div
                      className={
                        policy.scope === "chat_user"
                          ? "grid min-w-0 gap-3 md:col-span-2 md:grid-cols-2 xl:col-span-1"
                          : "grid min-w-0 gap-2 md:col-span-2 xl:col-span-1"
                      }
                    >
                      {policy.scope === "chat" && (
                        <div className="grid min-w-0 gap-2">
                          <Label>{t("governance.overrides.group")}</Label>
                          <GovernanceSubjectPicker
                            key={`chat:${botId}`}
                            {...pickerShared}
                            label={t("governance.overrides.group")}
                            value={policy.subjectKey}
                            onValueChange={updateSubject}
                            loadOptions={loadChats}
                            resolveOption={resolveChat}
                            placeholder={t("governance.overrides.chooseGroup")}
                            unknownText={(value) =>
                              t("governance.overrides.unknownGroup", { id: value })
                            }
                          />
                        </div>
                      )}
                      {policy.scope === "user_global" && (
                        <div className="grid min-w-0 gap-2">
                          <Label>{t("governance.overrides.person")}</Label>
                          <GovernanceSubjectPicker
                            key={`user:${botId}`}
                            {...pickerShared}
                            label={t("governance.overrides.person")}
                            value={policy.subjectKey}
                            onValueChange={updateSubject}
                            loadOptions={loadUsers}
                            resolveOption={resolveUser}
                            placeholder={t("governance.overrides.choosePerson")}
                            unknownText={(value) =>
                              t("governance.overrides.unknownPerson", { id: value })
                            }
                          />
                        </div>
                      )}
                      {policy.scope === "chat_user" && (
                        <>
                          <div className="grid min-w-0 gap-2">
                            <Label>{t("governance.overrides.group")}</Label>
                            <GovernanceSubjectPicker
                              key={`chat-user-chat:${botId}`}
                              {...pickerShared}
                              label={t("governance.overrides.group")}
                              value={chatUser.chatId}
                              onValueChange={(chatId) =>
                                updateSubject(`${chatId}:${chatUser.userId}`)
                              }
                              loadOptions={loadChats}
                              resolveOption={resolveChat}
                              placeholder={t("governance.overrides.chooseGroup")}
                              unknownText={(value) =>
                                t("governance.overrides.unknownGroup", { id: value })
                              }
                            />
                          </div>
                          <div className="grid min-w-0 gap-2">
                            <Label>{t("governance.overrides.person")}</Label>
                            <GovernanceSubjectPicker
                              key={`chat-user-user:${botId}`}
                              {...pickerShared}
                              label={t("governance.overrides.person")}
                              value={chatUser.userId}
                              onValueChange={(userId) =>
                                updateSubject(`${chatUser.chatId}:${userId}`)
                              }
                              loadOptions={loadUsers}
                              resolveOption={resolveUser}
                              placeholder={t("governance.overrides.choosePerson")}
                              unknownText={(value) =>
                                t("governance.overrides.unknownPerson", { id: value })
                              }
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  {subjectError && (
                    <p className="text-destructive text-sm" role="alert">
                      {subjectError}
                    </p>
                  )}
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(["hourly", "daily", "cooldownSeconds"] as const).map((field) => (
                      <div className="grid min-w-0 gap-2" key={field}>
                        <Label>{t(`governance.overrides.${field}`)}</Label>
                        <Input
                          type="number"
                          min={0}
                          value={policy[field] ?? ""}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              overrides: current.overrides.map((item, index) =>
                                index === policyIndex
                                  ? {
                                      ...item,
                                      [field]:
                                        event.target.value === ""
                                          ? undefined
                                          : Number(event.target.value),
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-3 right-3"
                    aria-label={t("governance.overrides.remove")}
                    onClick={() => {
                      setOverrideErrors({});
                      setDraft((current) => ({
                        ...current,
                        overrides: current.overrides.filter((_, index) => index !== policyIndex),
                      }));
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </section>
              );
            })
          )}
          <p className="text-muted-foreground text-xs">{t("governance.overrides.hint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
