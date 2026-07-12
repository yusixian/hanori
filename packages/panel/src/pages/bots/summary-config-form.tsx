import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { CodeBlock } from "@/components/ui/code-block";
import { client } from "@/lib/client";
import type {
  AiProviderEntryPublic,
  SummaryAccessMode,
  SummaryConfigRecord,
} from "@cos-tool-bot/shared";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";

interface DefaultsData {
  systemPrompt: string;
  windowHours: number;
  maxMessages: number;
  cooldownSeconds: number;
  timezone: string;
}

export function SummaryConfigForm({
  botId,
  config,
  onSaved,
  onCancel,
}: {
  botId: string;
  config?: SummaryConfigRecord;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("bots");
  const isEdit = !!config;

  const [chatId, setChatId] = useState(config ? String(config.chatId) : "");
  const [isActive, setIsActive] = useState(config?.isActive ?? true);
  const [scheduleHour, setScheduleHour] = useState(
    config?.scheduleHour != null ? String(config.scheduleHour) : "",
  );
  const [scheduleMinute, setScheduleMinute] = useState(
    config?.scheduleMinute != null ? String(config.scheduleMinute) : "",
  );
  const [windowHours, setWindowHours] = useState(String(config?.windowHours ?? 24));
  const [maxMessages, setMaxMessages] = useState(
    config?.maxMessages != null ? String(config.maxMessages) : "",
  );
  const [cooldownSeconds, setCooldownSeconds] = useState(
    config?.cooldownSeconds != null ? String(config.cooldownSeconds) : "",
  );
  const [accessMode, setAccessMode] = useState<SummaryAccessMode>(config?.accessMode ?? "all");
  const [providerId, setProviderId] = useState(config?.providerId ?? "");
  const [modelId, setModelId] = useState(config?.modelId ?? "");
  const [customPrompt, setCustomPrompt] = useState(config?.customPrompt ?? "");
  const [showDefaults, setShowDefaults] = useState(false);
  const [defaults, setDefaults] = useState<DefaultsData | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AiProviderEntryPublic[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>(undefined);
  const [providersError, setProvidersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
        if (!res.ok) {
          if (!cancelled)
            setProvidersError(t("summary.form.providersFailedStatus", { status: res.status }));
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        if (json.ok) {
          setProviders(json.data.providers ?? []);
          setActiveProviderId(json.data.activeProviderId);
          setProvidersError(null);
        } else {
          setProvidersError(t("summary.form.providersFailed"));
        }
      } catch (err) {
        if (!cancelled) {
          setProvidersError(err instanceof Error ? err.message : t("summary.form.providersFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, t]);

  const toggleDefaults = async () => {
    if (showDefaults) {
      setShowDefaults(false);
      return;
    }
    setShowDefaults(true);
    if (!defaults) {
      setLoadingDefaults(true);
      try {
        const res = await client.api.bots[":botId"].summary.defaults.$get({
          param: { botId },
        });
        const json = await res.json();
        if (json.ok) setDefaults(json.data);
      } finally {
        setLoadingDefaults(false);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatId) return;
    setSubmitting(true);
    setError(null);
    try {
      const hourVal = scheduleHour !== "" ? Number(scheduleHour) : null;
      const minuteVal = scheduleMinute !== "" ? Number(scheduleMinute) : null;
      const payload = {
        chatId: Number(chatId),
        isActive,
        scheduleHour: hourVal,
        scheduleMinute: minuteVal,
        windowHours: Number(windowHours),
        maxMessages: maxMessages !== "" ? Number(maxMessages) : null,
        cooldownSeconds: cooldownSeconds !== "" ? Number(cooldownSeconds) : null,
        accessMode,
        providerId: providerId || null,
        modelId: modelId || null,
        customPrompt: customPrompt || null,
      };
      const res = isEdit
        ? await client.api.bots[":botId"].summary.configs[":id"].$patch({
            param: { botId, id: String(config.id) },
            json: payload,
          })
        : await client.api.bots[":botId"].summary.configs.$post({
            param: { botId },
            json: payload,
          });
      if (!res.ok) {
        setError(
          isEdit
            ? t("summary.form.updateFailed", { status: res.status })
            : t("summary.form.createFailed", { status: res.status }),
        );
        return;
      }
      onSaved();
    } catch {
      setError(t("summary.form.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.chatId")}</label>
          <Input
            type="number"
            placeholder={t("summary.form.chatIdPlaceholder")}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            required
            disabled={isEdit}
          />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <Switch id="isActive" checked={isActive} onCheckedChange={setIsActive} />
          <label htmlFor="isActive" className="text-sm font-medium">
            {t("common:common.enabled")}
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.scheduleHour")}</label>
          <Input
            type="number"
            min={0}
            max={23}
            placeholder={t("summary.form.noSchedule")}
            value={scheduleHour}
            onChange={(e) => setScheduleHour(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">{t("summary.form.timezoneHint")}</p>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.scheduleMinute")}</label>
          <Input
            type="number"
            min={0}
            max={59}
            placeholder={t("summary.form.noSchedule")}
            value={scheduleMinute}
            onChange={(e) => setScheduleMinute(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.windowHours")}</label>
          <Input
            type="number"
            min={1}
            max={72}
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.maxMessages")}</label>
          <Input
            type="number"
            min={10}
            max={2000}
            placeholder={t("summary.form.defaultMaxMessages")}
            value={maxMessages}
            onChange={(e) => setMaxMessages(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.cooldown")}</label>
          <Input
            type="number"
            min={0}
            max={86400}
            placeholder={t("summary.form.defaultCooldown")}
            value={cooldownSeconds}
            onChange={(e) => setCooldownSeconds(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.access")}</label>
          <Select
            className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
            value={accessMode}
            onChange={(e) => setAccessMode(e.target.value as SummaryAccessMode)}
          >
            <option value="all">{t("summary.form.everyone")}</option>
            <option value="admin">{t("summary.form.adminOnly")}</option>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.provider")}</label>
          <Select
            className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            <option value="">
              {activeProviderId
                ? t("summary.form.currentProvider", {
                    provider:
                      providers.find((p) => p.id === activeProviderId)?.label ?? activeProviderId,
                  })
                : t("summary.form.defaultProvider")}
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.providerFormat})
              </option>
            ))}
          </Select>
          {providersError && <p className="text-xs text-red-500">{providersError}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">{t("summary.form.modelId")}</label>
          <Input
            placeholder={
              providerId
                ? t("summary.form.modelPlaceholder", {
                    model:
                      providers.find((p) => p.id === providerId)?.defaultModel ??
                      t("summary.form.selectedProviderDefault"),
                  })
                : t("summary.form.mainModelPlaceholder")
            }
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">{t("summary.form.customPrompt")}</label>
          <button
            type="button"
            onClick={toggleDefaults}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            {showDefaults ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {t("summary.form.viewDefault")}
          </button>
        </div>
        {showDefaults && (
          <div className="bg-muted rounded-md p-3 text-xs">
            {loadingDefaults ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CodeBlock>{defaults?.systemPrompt ?? "—"}</CodeBlock>
            )}
          </div>
        )}
        <Textarea
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={t("summary.form.promptPlaceholder")}
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          rows={4}
        />
        <p className="text-muted-foreground text-xs">
          <Trans
            t={t}
            i18nKey="summary.form.globalPromptDescription"
            components={{
              settings: <Link to={`/bots/${botId}/ai`} className="underline hover:opacity-80" />,
            }}
          />
        </p>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isEdit ? t("common:common.save") : t("common:common.create")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t("common:common.cancel")}
        </Button>
      </div>
    </form>
  );

  if (isEdit) return form;

  return (
    <Card>
      <CardContent className="pt-6">{form}</CardContent>
    </Card>
  );
}
