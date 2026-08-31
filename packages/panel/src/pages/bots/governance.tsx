import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/client";
import { Loader2, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";

type GeneralRouteMode = "off" | "explicit_only" | "semantic_auto";
interface ConnectionView {
  status: "disconnected" | "authorizing" | "connected" | "error";
  scopes: string[];
  lastError?: string;
}
interface RouteDraft {
  purpose: "anime_illustration" | "general_image";
  enabled: boolean;
  label: string;
  useWhen: string;
  avoidWhen: string;
  examples: string[];
  defaultPresetKey?: string;
  allowedPresetKeys: string[];
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
interface GovernanceDraft {
  timezone: string;
  connection: ConnectionView;
  generalRouteMode: GeneralRouteMode;
  routes: RouteDraft[];
  limits: LimitDraft[];
  overrides: PolicyDraft[];
}

const EMPTY_DRAFT: GovernanceDraft = {
  timezone: "Asia/Shanghai",
  connection: { status: "disconnected", scopes: [] },
  generalRouteMode: "off",
  routes: [
    {
      purpose: "anime_illustration",
      enabled: true,
      label: "Anime illustration",
      useWhen: "Anime, manga, character art, or stylized illustration is requested.",
      avoidWhen: "The request explicitly requires the general image backend.",
      examples: [],
      allowedPresetKeys: [],
    },
    {
      purpose: "general_image",
      enabled: false,
      label: "General image",
      useWhen: "The user explicitly asks for a general-purpose image.",
      avoidWhen: "The request is ambiguous or anime-oriented.",
      examples: [],
      allowedPresetKeys: [],
    },
  ],
  limits: [
    { key: "ai_bot", label: "AI · Bot total", hourly: 500, daily: 5_000 },
    { key: "ai_chat_user", label: "AI · group user", cooldownSeconds: 10, hourly: 20, daily: 100 },
    { key: "ai_user_global", label: "AI · user across groups", hourly: 50, daily: 200 },
    { key: "ai_chat", label: "AI · group total", hourly: 120, daily: 1000 },
    { key: "image_bot", label: "Image · Bot total", hourly: 100, daily: 500 },
    {
      key: "image_chat_user",
      label: "Image · group user",
      cooldownSeconds: 60,
      hourly: 5,
      daily: 20,
    },
    { key: "image_user_global", label: "Image · user across groups", hourly: 10, daily: 30 },
    { key: "image_chat", label: "Image · group total", hourly: 20, daily: 100 },
    { key: "proactive_bot", label: "Proactive replies · Bot", hourly: 30 },
  ],
  overrides: [],
};

function statusVariant(status: ConnectionView["status"]): "default" | "muted" | "destructive" {
  if (status === "connected") return "default";
  if (status === "error") return "destructive";
  return "muted";
}

export function BotGovernancePage() {
  const { botId } = useParams<{ botId: string }>();
  const { t } = useTranslation("bots");
  const [draft, setDraft] = useState<GovernanceDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    if (!botId) return;
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
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await authFetch(`/api/bots/${encodeURIComponent(botId)}/governance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: draft.timezone,
          generalRouteMode: draft.generalRouteMode,
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
    } catch {
      setMessage(t("governance.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const beginOAuth = async () => {
    const response = await authFetch("/api/image-mcp/oauth/start", { method: "POST" });
    const body = (await response.json()) as { ok?: boolean; authorizationUrl?: string };
    if (response.ok && body.ok && body.authorizationUrl)
      window.location.assign(body.authorizationUrl);
    else setMessage(t("governance.connection.startError"));
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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("governance.refresh")}
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
            <p className="text-destructive text-sm">{draft.connection.lastError}</p>
          )}
          <Button variant="outline" onClick={() => void beginOAuth()}>
            {draft.connection.status === "connected"
              ? t("governance.connection.reconnect")
              : t("governance.connection.connect")}
          </Button>
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
                  <Label htmlFor={`preset-${route.purpose}`}>
                    {t("governance.routing.defaultPreset")}
                  </Label>
                  <Input
                    id={`preset-${route.purpose}`}
                    value={route.defaultPresetKey ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex
                            ? { ...item, defaultPresetKey: event.target.value || undefined }
                            : item,
                        ),
                      }))
                    }
                  />
                  <Label htmlFor={`allowed-presets-${route.purpose}`}>
                    {t("governance.routing.allowedPresets")}
                  </Label>
                  <Input
                    id={`allowed-presets-${route.purpose}`}
                    value={route.allowedPresetKeys.join(", ")}
                    placeholder={t("governance.routing.allowedPresetsPlaceholder")}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        routes: current.routes.map((item, index) =>
                          index === routeIndex
                            ? {
                                ...item,
                                allowedPresetKeys: event.target.value
                                  .split(",")
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
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("governance.overrides.title")}</CardTitle>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("governance.overrides.description")}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                overrides: [
                  ...current.overrides,
                  {
                    resource: "ai_reply",
                    scope: "chat_user",
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
            draft.overrides.map((policy, policyIndex) => (
              <section
                key={`${policy.resource}:${policy.scope}:${policy.subjectKey}:${policyIndex}`}
                className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[10rem_10rem_minmax(12rem,1fr)_repeat(3,8rem)_auto] lg:items-end"
              >
                <div className="grid gap-2">
                  <Label>{t("governance.overrides.resource")}</Label>
                  <select
                    className="border-input bg-background h-10 rounded-md border px-3 text-sm"
                    value={policy.resource}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        overrides: current.overrides.map((item, index) =>
                          index === policyIndex
                            ? { ...item, resource: event.target.value as PolicyDraft["resource"] }
                            : item,
                        ),
                      }))
                    }
                  >
                    <option value="ai_reply">AI</option>
                    <option value="image">Image</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>{t("governance.overrides.scope")}</Label>
                  <select
                    className="border-input bg-background h-10 rounded-md border px-3 text-sm"
                    value={policy.scope}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        overrides: current.overrides.map((item, index) =>
                          index === policyIndex
                            ? { ...item, scope: event.target.value as PolicyDraft["scope"] }
                            : item,
                        ),
                      }))
                    }
                  >
                    <option value="chat">chat</option>
                    <option value="user_global">user_global</option>
                    <option value="chat_user">chat_user</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>{t("governance.overrides.subject")}</Label>
                  <Input
                    value={policy.subjectKey}
                    placeholder={
                      policy.scope === "chat_user"
                        ? "-100123:456"
                        : policy.scope === "chat"
                          ? "-100123"
                          : "456"
                    }
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        overrides: current.overrides.map((item, index) =>
                          index === policyIndex
                            ? { ...item, subjectKey: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </div>
                {(["hourly", "daily", "cooldownSeconds"] as const).map((field) => (
                  <div className="grid gap-2" key={field}>
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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("governance.overrides.remove")}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      overrides: current.overrides.filter((_, index) => index !== policyIndex),
                    }))
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </section>
            ))
          )}
          <p className="text-muted-foreground text-xs">{t("governance.overrides.hint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
