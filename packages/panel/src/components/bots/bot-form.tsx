import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { BotPlatform } from "@cos-tool-bot/shared";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link } from "react-router";

interface EmailForwardFormData {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  email: string;
  password: string;
  pollIntervalSec: number;
  filters: Array<{ senderPattern?: string; subjectPattern?: string }>;
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
    signSecret?: string;
    emailForwardConfig?: {
      imapHost: string;
      imapPort: number;
      email: string;
      pollIntervalSec: number;
      filters: Array<{ senderPattern?: string; subjectPattern?: string }>;
    };
  };
  onSubmit: (data: BotFormData) => Promise<void>;
  submitLabel: string;
  isEdit?: boolean;
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
  const [signSecret, setSignSecret] = useState(initialData?.signSecret ?? "");

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
          data.emailForwardConfig = {
            imapHost,
            imapPort: Number(imapPort) || 993,
            imapTls: true,
            email,
            password: emailPassword,
            pollIntervalSec: Number(pollInterval) || 60,
            filters,
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
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="platform"
                    value="telegram"
                    checked={platform === "telegram"}
                    onChange={() => setPlatform("telegram")}
                    className="border-input h-4 w-4"
                  />
                  Telegram
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="platform"
                    value="lark-webhook"
                    checked={platform === "lark-webhook"}
                    onChange={() => setPlatform("lark-webhook")}
                    className="border-input h-4 w-4"
                  />
                  Lark Webhook
                </label>
              </div>
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
                  placeholder="Leave empty if not configured"
                />
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="emailForward"
                    checked={emailEnabled}
                    onChange={(e) => setEmailEnabled(e.target.checked)}
                    className="border-input h-4 w-4 rounded"
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
                          isEdit ? "Leave empty to keep current" : "IMAP authorization code"
                        }
                        required={!isEdit}
                      />
                      {isEdit && (
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
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="border-input h-4 w-4 rounded"
            />
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
