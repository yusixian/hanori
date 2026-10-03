import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  ASR_PROVIDERS,
  type AsrAccountPublic,
  type AsrAccountUpdate,
  type AsrProvider,
  type AsrSecretName,
  type AsrSettingsPublic,
} from "@cos-tool-bot/shared";
import { AudioLines, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { asrSettingsApi, AsrSettingsRequestError } from "./asr-settings-api";

const POLICY_LINKS: Record<AsrProvider, string> = {
  tencent: "https://cloud.tencent.com/document/product/1093/35686",
  aliyun: "https://help.aliyun.com/zh/model-studio/model-pricing",
  groq: "https://console.groq.com/docs/rate-limits",
  openai: "https://openai.com/api/pricing/",
};
const NUMBER_FIELDS = [
  "costPerMinute",
  "maxPerJobCost",
  "dailyCost",
  "monthlyCost",
  "monthlyMinutes",
] as const;

/** Mounted only for owners/admins; server authorization is still required for every request. */
export function AsrSettingsPanel() {
  const { t } = useTranslation("auth");
  const [settings, setSettings] = useState<AsrSettingsPublic | null>(null);
  const [provider, setProvider] = useState<AsrProvider>("tencent");
  const [secrets, setSecrets] = useState<
    Partial<Record<AsrProvider, Partial<Record<AsrSecretName, string | null>>>>
  >({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      setSettings(await asrSettingsApi.get());
      setSecrets({});
    } catch {
      setError(t("asr.loadFailed"));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const account = settings?.accounts.find((item) => item.provider === provider);
  const patch = (values: Partial<AsrAccountPublic>) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            accounts: current.accounts.map((item) =>
              item.provider === provider ? { ...item, ...values } : item,
            ),
          }
        : current,
    );
  const changeSecret = (name: AsrSecretName, value: string | null) =>
    setSecrets((current) => ({
      ...current,
      [provider]: { ...current[provider], [name]: value },
    }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setPending(true);
    setError("");
    setNotice("");
    const accounts: AsrAccountUpdate[] = settings.accounts.map(
      ({ currency: _currency, configuredSecrets: _configured, ...values }) => ({
        ...values,
        ...(secrets[values.provider] ? { secrets: secrets[values.provider] } : {}),
      }),
    );
    try {
      setSettings(await asrSettingsApi.save({ revision: settings.revision, accounts }));
      setSecrets({});
      setNotice(t("asr.saved"));
    } catch (failure) {
      setError(
        t(
          failure instanceof AsrSettingsRequestError && failure.conflict
            ? "asr.conflict"
            : "asr.saveFailed",
        ),
      );
    } finally {
      setPending(false);
    }
  };
  const secretNames: AsrSecretName[] =
    provider === "tencent" ? ["secretId", "secretKey"] : ["apiKey"];
  return (
    <section id="asr-settings" className="settings-section" aria-labelledby="asr-settings-title">
      <header className="settings-section-heading">
        <span className="settings-section-icon" aria-hidden="true">
          <AudioLines size={19} strokeWidth={1.5} />
        </span>
        <div>
          <h2 id="asr-settings-title">{t("asr.title")}</h2>
          <p>{t("asr.description")}</p>
        </div>
      </header>
      <Card className="settings-surface">
        <CardContent>
          {error && (
            <p role="alert" className="text-destructive mb-4 text-sm">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mb-4 text-sm">
              {notice}
            </p>
          )}
          {!account ? (
            <div className="flex items-center gap-3">
              {pending ? (
                <p role="status">{t("asr.loading")}</p>
              ) : (
                <Button onClick={() => void load()}>{t("asr.reload")}</Button>
              )}
            </div>
          ) : (
            <form onSubmit={(event) => void save(event)} className="space-y-5">
              <fieldset disabled={pending} className="min-w-0 space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="asr-provider">{t("asr.provider")}</Label>
                  <Select
                    id="asr-provider"
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as AsrProvider)}
                  >
                    {ASR_PROVIDERS.map((item) => (
                      <option key={item} value={item}>
                        {t(`asr.providers.${item}`)}
                      </option>
                    ))}
                  </Select>
                  <p className="text-muted-foreground text-xs">{t("asr.priority")}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={account.enabled}
                    onCheckedChange={(checked) => patch({ enabled: checked === true })}
                  />
                  {t("asr.enabled")}
                </label>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t(`asr.policies.${provider}`)}{" "}
                  <a
                    href={POLICY_LINKS[provider]}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {t("asr.policyLink")}
                  </a>
                </p>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  {secretNames.map((name) => (
                    <div key={name} className="min-w-0 space-y-2">
                      <Label htmlFor={`asr-${name}`}>{t(`asr.secrets.${name}`)}</Label>
                      <Input
                        id={`asr-${name}`}
                        type="password"
                        autoComplete="new-password"
                        value={secrets[provider]?.[name] ?? ""}
                        placeholder={
                          account.configuredSecrets.includes(name)
                            ? t("asr.configured")
                            : t("asr.secretPlaceholder")
                        }
                        onChange={(event) => changeSecret(name, event.target.value)}
                      />
                      {account.configuredSecrets.includes(name) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            changeSecret(name, secrets[provider]?.[name] === null ? "" : null)
                          }
                        >
                          {t(
                            secrets[provider]?.[name] === null
                              ? "asr.keepSecret"
                              : "asr.clearSecret",
                          )}
                        </Button>
                      )}
                    </div>
                  ))}
                  <div className="min-w-0 space-y-2">
                    <Label htmlFor="asr-model">{t("asr.model")}</Label>
                    <Input
                      id="asr-model"
                      value={account.model}
                      onChange={(event) => patch({ model: event.target.value })}
                      required
                      maxLength={64}
                    />
                  </div>
                  {provider === "tencent" && (
                    <div className="space-y-2">
                      <Label htmlFor="asr-region">{t("asr.region")}</Label>
                      <Input
                        id="asr-region"
                        value={account.region}
                        onChange={(event) => patch({ region: event.target.value })}
                        required
                      />
                    </div>
                  )}
                  {provider === "openai" && (
                    <div className="min-w-0 space-y-2 sm:col-span-2">
                      <Label htmlFor="asr-base-url">{t("asr.baseUrl")}</Label>
                      <Input
                        id="asr-base-url"
                        type="url"
                        value={account.baseUrl}
                        onChange={(event) => patch({ baseUrl: event.target.value })}
                        required
                      />
                    </div>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">{t("asr.secretHint")}</p>
                {provider === "groq" && (
                  <label className="flex items-start gap-2 text-sm leading-relaxed">
                    <Checkbox
                      className="mt-0.5"
                      checked={account.freeOnly}
                      onCheckedChange={(checked) => patch({ freeOnly: checked === true })}
                    />
                    {t("asr.freeOnly")}
                  </label>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {NUMBER_FIELDS.map((name) => (
                    <div key={name} className="space-y-2">
                      <Label htmlFor={`asr-${name}`}>
                        {t(`asr.fields.${name}`, { currency: account.currency })}
                      </Label>
                      <Input
                        id={`asr-${name}`}
                        type="number"
                        min={
                          name === "monthlyMinutes" ? 1 : name === "costPerMinute" ? 0 : 0.000001
                        }
                        step={name === "monthlyMinutes" ? 1 : "any"}
                        value={account[name]}
                        onChange={(event) => patch({ [name]: Number(event.target.value) })}
                        required
                      />
                    </div>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {t("asr.budgetHint")}
                </p>
                <label className="flex items-start gap-2 text-sm leading-relaxed">
                  <Checkbox
                    className="mt-0.5"
                    checked={account.freeQuotaVerified}
                    onCheckedChange={(checked) => patch({ freeQuotaVerified: checked === true })}
                  />
                  {t("asr.quotaVerified")}
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="asr-free-quota-expiry">{t("asr.quotaExpiry")}</Label>
                    <Input
                      id="asr-free-quota-expiry"
                      type="date"
                      value={account.freeQuotaExpiresAt.slice(0, 10)}
                      onChange={(event) =>
                        patch({
                          freeQuotaExpiresAt: event.target.value
                            ? `${event.target.value}T23:59:59Z`
                            : "",
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="asr-policy-date">{t("asr.policyDate")}</Label>
                    <Input
                      id="asr-policy-date"
                      type="date"
                      value={account.policyCheckedAt.slice(0, 10)}
                      onChange={(event) => patch({ policyCheckedAt: event.target.value })}
                    />
                  </div>
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {t("asr.quotaHint")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit">
                    {pending && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {t(pending ? "asr.saving" : "asr.save")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void load()}>
                    {t("asr.reload")}
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
