import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ALL_EMAIL_EVENT_TYPES, DEFAULT_LARK_MENTION_MAP } from "@cos-tool-bot/shared";
import type { BotPlatform, CosInsideConfig, EmailEventType } from "@cos-tool-bot/shared";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  CosInsideTargetsField,
  type CosInsideTargetDraft,
  type CosInsideTargetErrors,
} from "./cos-inside-targets-field";

interface EmailForwardFormData {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  email: string;
  password: string;
  pollIntervalSec: number;
  filters: Array<{ senderPattern?: string; subjectPattern?: string }>;
  larkMentionMap?: Record<string, string>;
  disabledEventTypes?: string[];
}

export interface BotFormData {
  name: string;
  platform: BotPlatform;
  token: string | undefined;
  adminChatIds: number[];
  isActive: boolean;
  miniAppEnabled: boolean;
  webhookUrl?: string;
  signSecret?: string;
  emailForwardConfig?: EmailForwardFormData;
  cosInsideConfig?: CosInsideConfig;
}

interface BotFormProps {
  initialData?: {
    name: string;
    platform?: BotPlatform;
    tokenMasked: string;
    adminChatIds: number[];
    isActive: boolean;
    miniAppEnabled: boolean;
    webhookUrl?: string;
    hasSignSecret?: boolean;
    emailForwardConfig?: {
      imapHost: string;
      imapPort: number;
      email: string;
      pollIntervalSec: number;
      filters: Array<{ senderPattern?: string; subjectPattern?: string }>;
      larkMentionMap?: Record<string, string>;
      disabledEventTypes?: EmailEventType[];
      hasPassword?: boolean;
    };
    cosInsideConfig?: CosInsideConfig;
  };
  onSubmit: (data: BotFormData) => Promise<void>;
  submitLabel: string;
  isEdit?: boolean;
  botId?: string;
  canManageCosInside?: boolean;
}

const EVENT_TYPE_GROUPS: Array<{ labelKey: string; events: EmailEventType[] }> = [
  {
    labelKey: "form.email.eventGroups.pullRequest",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("pr:")),
  },
  {
    labelKey: "form.email.eventGroups.ci",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("ci:")),
  },
  {
    labelKey: "form.email.eventGroups.issue",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("issue:")),
  },
  { labelKey: "form.email.eventGroups.other", events: ["generic"] },
];

function EventTypeFilter({
  disabledEvents,
  setDisabledEvents,
}: {
  disabledEvents: Set<string>;
  setDisabledEvents: (s: Set<string>) => void;
}) {
  const { t } = useTranslation("bots");

  const toggle = (event: string) => {
    const next = new Set(disabledEvents);
    if (next.has(event)) next.delete(event);
    else next.add(event);
    setDisabledEvents(next);
  };

  const toggleGroup = (events: string[], allDisabled: boolean) => {
    const next = new Set(disabledEvents);
    for (const e of events) {
      if (allDisabled) next.delete(e);
      else next.add(e);
    }
    setDisabledEvents(next);
  };

  return (
    <div className="space-y-2 rounded-md border p-2">
      <label className="text-xs font-medium">{t("form.email.notificationTypes")}</label>
      {EVENT_TYPE_GROUPS.map((group) => {
        const allDisabled = group.events.every((e) => disabledEvents.has(e));
        const disabledCount = group.events.filter((event) => disabledEvents.has(event)).length;
        return (
          <div key={group.labelKey} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Checkbox
                checked={
                  disabledCount > 0 && disabledCount < group.events.length
                    ? "indeterminate"
                    : !allDisabled
                }
                onCheckedChange={() => toggleGroup(group.events, allDisabled)}
                className="border-input h-3.5 w-3.5 rounded"
              />
              <span className="text-xs font-medium">{t(group.labelKey)}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pl-5">
              {group.events.map((event) => (
                <label key={event} className="flex items-center gap-1 text-xs">
                  <Checkbox
                    checked={!disabledEvents.has(event)}
                    onCheckedChange={() => toggle(event)}
                    className="border-input h-3 w-3 rounded"
                  />
                  {t(`form.email.events.${event.replace(":", ".")}`)}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BotForm({
  initialData,
  onSubmit,
  submitLabel,
  isEdit,
  botId,
  canManageCosInside = false,
}: BotFormProps) {
  const { t } = useTranslation("bots");
  const [platform, setPlatform] = useState<BotPlatform>(initialData?.platform ?? "telegram");
  const [name, setName] = useState(initialData?.name ?? "");
  const [token, setToken] = useState("");
  const [adminChatIds, setAdminChatIds] = useState(initialData?.adminChatIds.join(", ") ?? "");
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const [miniAppEnabled, setMiniAppEnabled] = useState(initialData?.miniAppEnabled ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const nextCosInsideKey = useRef(0);
  const [cosInsideTargets, setCosInsideTargets] = useState<CosInsideTargetDraft[]>(() =>
    (initialData?.cosInsideConfig?.targets ?? []).map((target, index) => ({
      key: `stored-${index}`,
      alias: target.alias,
      chatId: String(target.chatId),
    })),
  );
  const [cosInsideTouched, setCosInsideTouched] = useState(false);
  const [cosInsideErrors, setCosInsideErrors] = useState<Record<string, CosInsideTargetErrors>>({});

  // Lark fields
  const [webhookUrl, setWebhookUrl] = useState(initialData?.webhookUrl ?? "");
  const [signSecret, setSignSecret] = useState("");

  // Email forward fields
  const initEmail = initialData?.emailForwardConfig;
  const [emailEnabled, setEmailEnabled] = useState(!!initEmail);
  const [imapHost, setImapHost] = useState(initEmail?.imapHost ?? "imap.qq.com");
  const [imapPort, setImapPort] = useState(String(initEmail?.imapPort ?? 993));
  const [email, setEmail] = useState(initEmail?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [pollInterval, setPollInterval] = useState(String(initEmail?.pollIntervalSec ?? 60));
  const [senderFilter, setSenderFilter] = useState(
    initEmail?.filters[0]?.senderPattern ?? "notifications@github.com",
  );
  const [subjectFilter, setSubjectFilter] = useState(initEmail?.filters[0]?.subjectPattern ?? "");
  const [disabledEvents, setDisabledEvents] = useState<Set<string>>(
    () => new Set(initEmail?.disabledEventTypes ?? []),
  );
  const [mentionMap, setMentionMap] = useState<Array<[string, string]>>(() => {
    const map = initEmail?.larkMentionMap ?? DEFAULT_LARK_MENTION_MAP;
    return Object.entries(map);
  });
  const csvInputRef = useRef<HTMLInputElement>(null);

  const exportMentionCsv = () => {
    const lines = ["github_username,lark_open_id"];
    for (const [gh, lark] of mentionMap) {
      if (gh.trim() || lark.trim()) lines.push(`${gh.trim()},${lark.trim()}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lark-mention-map.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importMentionCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const entries: Array<[string, string]> = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "github_username,lark_open_id") continue;
        const commaIdx = trimmed.indexOf(",");
        if (commaIdx === -1) continue;
        entries.push([trimmed.slice(0, commaIdx), trimmed.slice(commaIdx + 1)]);
      }
      if (entries.length > 0) setMentionMap(entries);
    };
    reader.readAsText(file);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError("");
    let parsedCosInsideConfig: CosInsideConfig | undefined;
    if (platform === "telegram" && canManageCosInside && isEdit && botId && cosInsideTouched) {
      const nextErrors: Record<string, CosInsideTargetErrors> = {};
      const aliases = new Set<string>();
      const targets: CosInsideConfig["targets"] = [];
      for (const target of cosInsideTargets) {
        const alias = target.alias.trim();
        const normalizedAlias = alias.toLowerCase();
        const errors: CosInsideTargetErrors = {};
        if (!/^[a-z0-9_-]{1,32}$/i.test(alias)) {
          errors.alias = t("form.cosInside.aliasInvalid");
        } else if (aliases.has(normalizedAlias)) {
          errors.alias = t("form.cosInside.aliasDuplicate");
        } else {
          aliases.add(normalizedAlias);
        }

        const chatIdText = target.chatId.trim();
        const chatId = Number(chatIdText);
        if (!/^-\d+$/.test(chatIdText) || !Number.isSafeInteger(chatId) || chatId > -1) {
          errors.chatId = t("form.cosInside.groupInvalid");
        }
        if (errors.alias || errors.chatId) nextErrors[target.key] = errors;
        else targets.push({ alias, chatId });
      }
      setCosInsideErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
      parsedCosInsideConfig = { targets };
    }
    setSubmitting(true);
    try {
      const ids = adminChatIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));

      const data: BotFormData = {
        name,
        platform,
        token: platform === "telegram" ? (isEdit && !token ? undefined : token) : undefined,
        adminChatIds: ids,
        isActive,
        miniAppEnabled,
      };

      if (parsedCosInsideConfig) data.cosInsideConfig = parsedCosInsideConfig;

      if (platform === "lark-webhook") {
        data.webhookUrl = webhookUrl;
        data.signSecret = signSecret || undefined;
        if (emailEnabled) {
          const filters: Array<{ senderPattern?: string; subjectPattern?: string }> = [];
          if (senderFilter || subjectFilter) {
            filters.push({
              senderPattern: senderFilter || undefined,
              subjectPattern: subjectFilter || undefined,
            });
          }
          const larkMentionMapObj: Record<string, string> = {};
          for (const [k, v] of mentionMap) {
            if (k.trim() && v.trim()) larkMentionMapObj[k.trim()] = v.trim();
          }
          data.emailForwardConfig = {
            imapHost,
            imapPort: Number(imapPort) || 993,
            imapTls: true,
            email,
            password: emailPassword,
            pollIntervalSec: Number(pollInterval) || 60,
            filters,
            larkMentionMap:
              Object.keys(larkMentionMapObj).length > 0 ? larkMentionMapObj : undefined,
            disabledEventTypes: disabledEvents.size > 0 ? [...disabledEvents] : undefined,
          };
        }
      }

      await onSubmit(data);
    } catch {
      setSubmitError(t("form.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">
          {isEdit ? t("form.editTitle") : t("form.createTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isEdit && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("form.platform")}</label>
              <RadioGroup
                value={platform}
                onValueChange={(value) => setPlatform(value as BotPlatform)}
                className="flex gap-3"
              >
                <label className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="telegram" />
                  Telegram
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value="lark-webhook" />
                  Lark Webhook
                </label>
              </RadioGroup>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="bot-name" className="text-sm font-medium">
              {t("form.name")}
            </label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
              required
            />
          </div>

          {platform === "telegram" ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="bot-token" className="text-sm font-medium">
                  {t("form.botToken")}
                </label>
                <Input
                  id="bot-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    isEdit
                      ? (initialData?.tokenMasked ?? t("form.keepCurrent"))
                      : "123456:ABC-DEF..."
                  }
                  required={!isEdit}
                />
                {isEdit && (
                  <p className="text-muted-foreground text-xs">{t("form.keepCurrentToken")}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bot-admin-ids" className="text-sm font-medium">
                  {t("form.adminChatIds")}
                </label>
                <Input
                  id="bot-admin-ids"
                  value={adminChatIds}
                  onChange={(e) => setAdminChatIds(e.target.value)}
                  placeholder="123456, 789012"
                />
                <p className="text-muted-foreground text-xs">{t("form.adminChatIdsHint")}</p>
              </div>

              {canManageCosInside &&
                (isEdit && botId ? (
                  <CosInsideTargetsField
                    botId={botId}
                    targets={cosInsideTargets}
                    errors={cosInsideErrors}
                    onAdd={() => {
                      const key = `new-${nextCosInsideKey.current++}`;
                      setCosInsideTargets((current) => [
                        ...current,
                        { key, alias: "", chatId: "" },
                      ]);
                      setCosInsideTouched(true);
                    }}
                    onUpdate={(key, patch) => {
                      setCosInsideTargets((current) =>
                        current.map((target) =>
                          target.key === key ? { ...target, ...patch } : target,
                        ),
                      );
                      setCosInsideErrors((current) => {
                        if (!(key in current)) return current;
                        const next = { ...current };
                        delete next[key];
                        return next;
                      });
                      setCosInsideTouched(true);
                    }}
                    onRemove={(key) => {
                      setCosInsideTargets((current) =>
                        current.filter((target) => target.key !== key),
                      );
                      setCosInsideErrors((current) => {
                        if (!(key in current)) return current;
                        const next = { ...current };
                        delete next[key];
                        return next;
                      });
                      setCosInsideTouched(true);
                    }}
                  />
                ) : (
                  <div className="space-y-1 rounded-md border p-3">
                    <h3 className="text-sm font-medium">{t("form.cosInside.title")}</h3>
                    <p className="text-muted-foreground text-xs">
                      {t("form.cosInside.createFirst")}
                    </p>
                  </div>
                ))}
            </>
          ) : (
            <>
              <div className="border-secondary-border bg-secondary rounded-md border p-3 text-sm">
                {t("form.larkFirstTime")}{" "}
                <Link
                  to="/guides/lark-setup"
                  target="_blank"
                  className="text-secondary-foreground hover:text-primary font-medium underline underline-offset-2"
                >
                  {t("form.larkSetupGuide")} &rarr;
                </Link>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="webhook-url" className="text-sm font-medium">
                  {t("form.webhookUrl")}
                </label>
                <Input
                  id="webhook-url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="sign-secret" className="text-sm font-medium">
                  {t("form.signSecret")}
                </label>
                <Input
                  id="sign-secret"
                  value={signSecret}
                  onChange={(e) => setSignSecret(e.target.value)}
                  placeholder={
                    isEdit && initialData?.hasSignSecret
                      ? t("form.keepCurrent")
                      : t("form.leaveEmptyIfNotConfigured")
                  }
                />
                {isEdit && initialData?.hasSignSecret && (
                  <p className="text-muted-foreground text-xs">{t("form.keepCurrentSecret")}</p>
                )}
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="emailForward"
                    checked={emailEnabled}
                    onCheckedChange={setEmailEnabled}
                  />
                  <label htmlFor="emailForward" className="text-sm font-medium">
                    {t("form.email.title")}
                  </label>
                </div>

                {emailEnabled && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium">{t("form.email.imapHost")}</label>
                        <Input
                          value={imapHost}
                          onChange={(e) => setImapHost(e.target.value)}
                          placeholder="imap.qq.com"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium">{t("form.email.port")}</label>
                        <Input
                          value={imapPort}
                          onChange={(e) => setImapPort(e.target.value)}
                          placeholder="993"
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">{t("form.email.address")}</label>
                      <Input
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="contact@example.invalid"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">{t("form.email.password")}</label>
                      <Input
                        type="password"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value)}
                        placeholder={
                          isEdit && initEmail?.hasPassword
                            ? t("form.keepCurrent")
                            : t("form.email.authorizationCode")
                        }
                        required={!isEdit || !initEmail?.hasPassword}
                      />
                      {isEdit && initEmail?.hasPassword && (
                        <p className="text-muted-foreground text-xs">
                          {t("form.email.keepCurrentPassword")}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">{t("form.email.pollInterval")}</label>
                      <Input
                        value={pollInterval}
                        onChange={(e) => setPollInterval(e.target.value)}
                        placeholder="60"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium">
                          {t("form.email.senderFilter")}
                        </label>
                        <Input
                          value={senderFilter}
                          onChange={(e) => setSenderFilter(e.target.value)}
                          placeholder="notifications@github.com"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium">
                          {t("form.email.subjectFilter")}
                        </label>
                        <Input
                          value={subjectFilter}
                          onChange={(e) => setSubjectFilter(e.target.value)}
                          placeholder="pull request"
                        />
                      </div>
                    </div>

                    <EventTypeFilter
                      disabledEvents={disabledEvents}
                      setDisabledEvents={setDisabledEvents}
                    />

                    <div className="space-y-2 rounded-md border p-2">
                      <label className="text-xs font-medium">{t("form.email.mentionMap")}</label>
                      <div className="space-y-1">
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {mentionMap.map(([ghLogin, larkId], idx) => (
                            <div key={idx} className="flex items-center gap-1">
                              <Input
                                className="h-7 text-xs"
                                value={ghLogin}
                                onChange={(e) => {
                                  const next = [...mentionMap];
                                  next[idx] = [e.target.value, larkId];
                                  setMentionMap(next);
                                }}
                                placeholder={t("form.email.githubLogin")}
                              />
                              <Input
                                className="h-7 text-xs"
                                value={larkId}
                                onChange={(e) => {
                                  const next = [...mentionMap];
                                  next[idx] = [ghLogin, e.target.value];
                                  setMentionMap(next);
                                }}
                                placeholder="ou_xxx"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 shrink-0 p-0"
                                onClick={() =>
                                  setMentionMap(mentionMap.filter((_, i) => i !== idx))
                                }
                              >
                                &times;
                              </Button>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setMentionMap([...mentionMap, ["", ""]])}
                          >
                            {t("form.email.addMapping")}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={exportMentionCsv}
                          >
                            {t("form.email.exportCsv")}
                          </Button>
                          <Input
                            ref={csvInputRef}
                            type="file"
                            accept=".csv"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) importMentionCsv(file);
                              e.target.value = "";
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => csvInputRef.current?.click()}
                          >
                            {t("form.email.importCsv")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            <Switch id="isActive" checked={isActive} onCheckedChange={setIsActive} />
            <label htmlFor="isActive" className="text-sm font-medium">
              {t("form.autoStart")}
            </label>
          </div>

          {platform === "telegram" ? (
            <div className="flex items-center gap-2">
              <Switch
                id="miniAppEnabled"
                checked={miniAppEnabled}
                onCheckedChange={setMiniAppEnabled}
              />
              <label htmlFor="miniAppEnabled" className="text-sm font-medium">
                {t("form.miniAppEnabled")}
              </label>
            </div>
          ) : null}

          {submitError && (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          )}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? t("common:common.saving") : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
