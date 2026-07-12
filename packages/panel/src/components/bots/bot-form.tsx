import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ALL_EMAIL_EVENT_TYPES, DEFAULT_LARK_MENTION_MAP } from "@cos-tool-bot/shared";
import type { BotPlatform, EmailEventType } from "@cos-tool-bot/shared";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router";

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
  webhookUrl?: string;
  signSecret?: string;
  emailForwardConfig?: EmailForwardFormData;
}

interface BotFormProps {
  initialData?: {
    name: string;
    platform?: BotPlatform;
    tokenMasked: string;
    adminChatIds: number[];
    isActive: boolean;
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
  };
  onSubmit: (data: BotFormData) => Promise<void>;
  submitLabel: string;
  isEdit?: boolean;
}

const EVENT_TYPE_GROUPS: Array<{ label: string; events: EmailEventType[] }> = [
  {
    label: "PR Events",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("pr:")),
  },
  {
    label: "CI Events",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("ci:")),
  },
  {
    label: "Issue Events",
    events: ALL_EMAIL_EVENT_TYPES.filter((t): t is EmailEventType => t.startsWith("issue:")),
  },
  { label: "Other", events: ["generic"] },
];

function formatEventLabel(event: string): string {
  const action = event.includes(":") ? event.split(":")[1]! : event;
  return action
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function EventTypeFilter({
  disabledEvents,
  setDisabledEvents,
}: {
  disabledEvents: Set<string>;
  setDisabledEvents: (s: Set<string>) => void;
}) {
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
      <label className="text-xs font-medium">Notification Types</label>
      {EVENT_TYPE_GROUPS.map((group) => {
        const allDisabled = group.events.every((e) => disabledEvents.has(e));
        const disabledCount = group.events.filter((event) => disabledEvents.has(event)).length;
        return (
          <div key={group.label} className="space-y-1">
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
              <span className="text-xs font-medium">{group.label}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pl-5">
              {group.events.map((event) => (
                <label key={event} className="flex items-center gap-1 text-xs">
                  <Checkbox
                    checked={!disabledEvents.has(event)}
                    onCheckedChange={() => toggle(event)}
                    className="border-input h-3 w-3 rounded"
                  />
                  {formatEventLabel(event)}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function BotForm({ initialData, onSubmit, submitLabel, isEdit }: BotFormProps) {
  const [platform, setPlatform] = useState<BotPlatform>(initialData?.platform ?? "telegram");
  const [name, setName] = useState(initialData?.name ?? "");
  const [token, setToken] = useState("");
  const [adminChatIds, setAdminChatIds] = useState(initialData?.adminChatIds.join(", ") ?? "");
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);

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
      };

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
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">{isEdit ? "Edit Bot" : "Create Bot"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isEdit && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Platform</label>
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
              Name
            </label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Bot"
              required
            />
          </div>

          {platform === "telegram" ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="bot-token" className="text-sm font-medium">
                  Bot Token
                </label>
                <Input
                  id="bot-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={
                    isEdit
                      ? (initialData?.tokenMasked ?? "Leave empty to keep current")
                      : "123456:ABC-DEF..."
                  }
                  required={!isEdit}
                />
                {isEdit && (
                  <p className="text-muted-foreground text-xs">Leave empty to keep current token</p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="bot-admin-ids" className="text-sm font-medium">
                  Admin Chat IDs
                </label>
                <Input
                  id="bot-admin-ids"
                  value={adminChatIds}
                  onChange={(e) => setAdminChatIds(e.target.value)}
                  placeholder="123456, 789012"
                />
                <p className="text-muted-foreground text-xs">Comma-separated chat IDs</p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
                First time setting up a Lark bot?{" "}
                <Link
                  to="/guides/lark-setup"
                  target="_blank"
                  className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  See the setup guide &rarr;
                </Link>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="webhook-url" className="text-sm font-medium">
                  Webhook URL
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
                  Sign Secret (optional)
                </label>
                <Input
                  id="sign-secret"
                  value={signSecret}
                  onChange={(e) => setSignSecret(e.target.value)}
                  placeholder={
                    isEdit && initialData?.hasSignSecret
                      ? "Leave empty to keep current"
                      : "Leave empty if not configured"
                  }
                />
                {isEdit && initialData?.hasSignSecret && (
                  <p className="text-muted-foreground text-xs">
                    Leave empty to keep current secret
                  </p>
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
                    Email Forwarding (IMAP)
                  </label>
                </div>

                {emailEnabled && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium">IMAP Host</label>
                        <Input
                          value={imapHost}
                          onChange={(e) => setImapHost(e.target.value)}
                          placeholder="imap.qq.com"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium">Port</label>
                        <Input
                          value={imapPort}
                          onChange={(e) => setImapPort(e.target.value)}
                          placeholder="993"
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Email</label>
                      <Input
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="contact@example.invalid"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Password / App Token</label>
                      <Input
                        type="password"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value)}
                        placeholder={
                          isEdit && initEmail?.hasPassword
                            ? "Leave empty to keep current"
                            : "IMAP authorization code"
                        }
                        required={!isEdit || !initEmail?.hasPassword}
                      />
                      {isEdit && initEmail?.hasPassword && (
                        <p className="text-muted-foreground text-xs">
                          Leave empty to keep current password
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Poll Interval (sec)</label>
                      <Input
                        value={pollInterval}
                        onChange={(e) => setPollInterval(e.target.value)}
                        placeholder="60"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium">Sender Filter</label>
                        <Input
                          value={senderFilter}
                          onChange={(e) => setSenderFilter(e.target.value)}
                          placeholder="notifications@github.com"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium">Subject Filter</label>
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
                      <label className="text-xs font-medium">
                        Lark @Mention (GitHub Username → Lark Open ID)
                      </label>
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
                                placeholder="GitHub login"
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
                            + Add Mapping
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={exportMentionCsv}
                          >
                            Export CSV
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
                            Import CSV
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
              Auto-start on server launch
            </label>
          </div>

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
