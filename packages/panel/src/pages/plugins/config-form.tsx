import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  mergePluginConfig,
  PluginConfigError,
  type PluginConfigPublic,
  type PluginConfigUpdate,
  type PluginManifest,
} from "@cos-tool-bot/shared";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface PluginConfigFormProps {
  manifest: PluginManifest;
  configuration: PluginConfigPublic;
  scopeKey: string;
  revision: string | number;
  onSave: (update: PluginConfigUpdate) => Promise<void>;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  fieldHelp?: Record<string, ReactNode>;
}

type Draft = Record<string, string | boolean>;
type FieldError = "config.invalidValue" | "config.invalidNumber";

function initialDraft(manifest: PluginManifest, configuration: PluginConfigPublic): Draft {
  return Object.fromEntries(
    manifest.config.map((field) => {
      const value = field.secret ? undefined : (configuration.values[field.key] ?? field.default);
      return [field.key, field.type === "boolean" ? value === true : String(value ?? "")];
    }),
  );
}

// A confirmed revision or a different bot/plugin starts a fresh draft immediately.
export function PluginConfigForm(props: PluginConfigFormProps) {
  const key = JSON.stringify([
    props.scopeKey,
    props.manifest.id,
    props.manifest.version,
    props.revision,
  ]);
  return <ConfigDraft key={key} {...props} />;
}

function ConfigDraft({
  manifest,
  configuration,
  onSave,
  disabled,
  onDirtyChange,
  fieldHelp,
}: PluginConfigFormProps) {
  const { t } = useTranslation("plugins");
  const id = useId();
  const [draft, setDraft] = useState(() => initialDraft(manifest, configuration));
  const [savedValues, setSavedValues] = useState(configuration.values);
  const [configuredSecrets, setConfiguredSecrets] = useState(configuration.configuredSecrets);
  const [clearedSecrets, setClearedSecrets] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, FieldError>>({});
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const locked = disabled || saving;
  const savedDraft = initialDraft(manifest, { values: savedValues, configuredSecrets });
  const dirty =
    clearedSecrets.length > 0 ||
    manifest.config.some((field) => draft[field.key] !== savedDraft[field.key]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function edit(key: string, value: string | boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setStatus(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending.current) return;
    const update: PluginConfigUpdate = { values: {}, secrets: {} };
    const nextErrors: Record<string, FieldError> = {};
    for (const field of manifest.config) {
      const value = draft[field.key] ?? "";
      if (field.secret) {
        if (clearedSecrets.includes(field.key)) update.secrets![field.key] = null;
        else if (typeof value === "string" && value !== "") update.secrets![field.key] = value;
      } else if (field.type === "number" || field.type === "integer") {
        const text = String(value).trim();
        if (text === "" && savedValues[field.key] === undefined && field.default === undefined)
          continue;
        if (text === "") {
          update.values[field.key] = null;
          continue;
        }
        // Keep incomplete input as text; Number("") and non-decimal formats are not valid edits.
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
          nextErrors[field.key] = "config.invalidNumber";
          continue;
        }
        update.values[field.key] = Number(text);
      } else if (field.type === "select" && value === "") {
        if (savedValues[field.key] !== undefined || field.default !== undefined)
          update.values[field.key] = null;
      } else if (
        value === "" &&
        savedValues[field.key] === undefined &&
        field.default === undefined
      ) {
        continue;
      } else {
        update.values[field.key] = value;
      }
    }
    // Validate fields independently so every invalid field gets an associated error.
    for (const field of manifest.config) {
      if (nextErrors[field.key]) continue;
      try {
        const value = update.values[field.key];
        const secret = update.secrets![field.key];
        mergePluginConfig(
          { ...manifest, config: [field] },
          {},
          {
            values: value !== undefined ? { [field.key]: value } : {},
            secrets: secret !== undefined ? { [field.key]: secret } : {},
          },
        );
      } catch (error) {
        if (error instanceof PluginConfigError) nextErrors[field.key] = "config.invalidValue";
        else throw error;
      }
    }
    setErrors(nextErrors);
    setStatus(null);
    if (Object.keys(nextErrors).length > 0) {
      document.getElementById(`${id}-${Object.keys(nextErrors)[0]}`)?.focus();
      return;
    }
    if (Object.keys(update.secrets!).length === 0) delete update.secrets;
    pending.current = true;
    setSaving(true);
    try {
      await onSave(update);
      if (!mounted.current) return;
      setSavedValues((current) => mergePluginConfig(manifest, current, { values: update.values }));
      setConfiguredSecrets((current) => {
        const next = new Set(current);
        for (const [key, value] of Object.entries(update.secrets ?? {})) {
          if (value === null) next.delete(key);
          else next.add(key);
        }
        return [...next];
      });
      setDraft((current) => {
        const next = { ...current };
        for (const field of manifest.config) {
          if (field.secret) next[field.key] = "";
          else if (update.values[field.key] === null) next[field.key] = String(field.default ?? "");
        }
        return next;
      });
      setClearedSecrets([]);
      setStatus("saved");
    } catch {
      // Transport errors can contain credentials; display only a translated generic message.
      if (mounted.current) setStatus("failed");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate autoComplete="off" className="min-w-0 space-y-5">
      <p className="text-muted-foreground text-sm break-words">
        {manifest.config.length === 0 ? t("config.empty") : t("config.draftHint")}
      </p>
      {manifest.config.map((field) => {
        const fieldId = `${id}-${field.key}`;
        const error = errors[field.key];
        const clearing = clearedSecrets.includes(field.key);
        const savedSecret = configuredSecrets.includes(field.key);
        const resettingDefault =
          !field.secret &&
          draft[field.key] === "" &&
          field.default !== undefined &&
          (field.type === "number" || field.type === "integer" || field.type === "select");
        const describedBy = [
          field.description ? `${fieldId}-description` : null,
          field.secret ? `${fieldId}-secret` : null,
          error ? `${fieldId}-error` : null,
          resettingDefault ? `${fieldId}-default` : null,
        ]
          .filter(Boolean)
          .join(" ");
        const controlProps = {
          id: fieldId,
          disabled: locked || (field.secret && clearing),
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy || undefined,
        };
        return (
          <div key={field.key} className="min-w-0 space-y-2">
            <Label htmlFor={fieldId} className="block leading-5 break-words">
              {field.label}
              {field.required ? (
                <span className="text-muted-foreground ml-2 text-xs">{t("config.required")}</span>
              ) : null}
            </Label>
            {field.type === "boolean" ? (
              <input
                {...controlProps}
                type="checkbox"
                checked={draft[field.key] === true}
                onChange={(event) => edit(field.key, event.target.checked)}
                className="accent-primary h-5 w-5"
              />
            ) : field.type === "select" ? (
              <select
                {...controlProps}
                value={String(draft[field.key])}
                onChange={(event) => edit(field.key, event.target.value)}
                className="border-input focus-visible:ring-ring/20 h-10 w-full min-w-0 rounded-lg border bg-white px-3 text-base outline-none focus-visible:ring-2 disabled:opacity-50 md:text-sm"
              >
                <option value="">{t("config.choose")}</option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "text" ? (
              <Textarea
                {...controlProps}
                autoComplete={field.secret ? "new-password" : "off"}
                spellCheck={field.secret ? false : undefined}
                value={String(draft[field.key])}
                onChange={(event) => edit(field.key, event.target.value)}
                className={cn(
                  "min-w-0 [overflow-wrap:anywhere]",
                  field.secret && "[-webkit-text-security:disc]",
                )}
              />
            ) : (
              <Input
                {...controlProps}
                type={field.secret ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                spellCheck={field.secret ? false : undefined}
                inputMode={
                  field.type === "integer"
                    ? "numeric"
                    : field.type === "number"
                      ? "decimal"
                      : undefined
                }
                value={String(draft[field.key])}
                onChange={(event) => edit(field.key, event.target.value)}
                className="min-w-0"
              />
            )}
            {field.description ? (
              <p
                id={`${fieldId}-description`}
                className="text-muted-foreground text-sm [overflow-wrap:anywhere] break-words"
              >
                {field.description}
              </p>
            ) : null}
            {resettingDefault ? (
              <p id={`${fieldId}-default`} className="text-muted-foreground text-sm break-words">
                {t("config.resetDefault", { value: field.default })}
              </p>
            ) : null}
            {field.secret ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p id={`${fieldId}-secret`} className="text-muted-foreground text-sm break-words">
                  {clearing
                    ? t("config.secretClearing")
                    : savedSecret
                      ? t("config.secretConfigured")
                      : t("config.secretMissing")}
                </p>
                {savedSecret ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => {
                      setClearedSecrets((current) =>
                        clearing
                          ? current.filter((key) => key !== field.key)
                          : [...current, field.key],
                      );
                      setStatus(null);
                    }}
                  >
                    {clearing ? t("config.undoClearSecret") : t("config.clearSecret")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {fieldHelp?.[field.key]}
            {error ? (
              <p
                id={`${fieldId}-error`}
                role="alert"
                className="text-destructive text-sm break-words"
              >
                {t(error)}
              </p>
            ) : null}
          </div>
        );
      })}
      {status === "failed" ? (
        <p role="alert" className="text-destructive text-sm">
          {t("config.saveFailed")}
        </p>
      ) : null}
      {status === "saved" ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t("config.saved")}
        </p>
      ) : null}
      <Button type="submit" disabled={locked} className="max-w-full whitespace-normal">
        {saving ? t("config.saving") : t("config.save")}
      </Button>
    </form>
  );
}
