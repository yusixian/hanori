import {
  HARNESS_PROJECT_KINDS,
  type HarnessAdminMachine,
  type HarnessAdminPolicySummary,
  type HarnessProjectKind,
} from "@cos-tool-bot/shared";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { HarnessAdminApiError, HarnessAdminIssue } from "@/lib/harness-admin-client";
import { parseSkills, type PolicyDraft } from "./policy-draft";
import "./i18n";

export function issuesAt(issues: readonly HarnessAdminIssue[], path: string): string[] {
  return issues
    .filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`))
    .map((issue) => issue.message);
}

export function Notice({
  kind,
  children,
}: {
  kind: "error" | "success" | "warning";
  children: ReactNode;
}) {
  const Icon = kind === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`harness-notice is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** Shows the localized failure plus any issues no inline field claimed. */
export function ApiErrorNotice({
  error,
  claimedPaths = [],
}: {
  error: HarnessAdminApiError;
  claimedPaths?: readonly string[];
}) {
  const { t } = useTranslation("harness");
  const unclaimed = error.issues.filter(
    (issue) =>
      !claimedPaths.some((path) => issue.path === path || issue.path.startsWith(`${path}.`)),
  );
  return (
    <Notice kind="error">
      <strong>{t(`errors.${error.code}`)}</strong>
      {error.issues.length === 0 ? <span>{error.message}</span> : null}
      {unclaimed.length > 0 ? (
        <ul>
          {unclaimed.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              {issue.path ? <code>{issue.path}</code> : null} {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

export function FieldErrors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} className="harness-error">
      {messages.join(" ")}
    </p>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  errors = [],
  disabled,
  placeholder,
  inputMode,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  errors?: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  inputMode?: "numeric" | "text";
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, errors.length > 0 ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="harness-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="harness-input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        inputMode={inputMode}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="harness-hint">
          {hint}
        </p>
      ) : null}
      <FieldErrors id={`${id}-error`} messages={errors} />
    </div>
  );
}

export function MachineStatus({ online }: { online: boolean | null }) {
  const { t } = useTranslation("harness");
  const state = online === null ? "unknown" : online ? "online" : "offline";
  return (
    <small>
      <span className={`harness-dot is-${state}`} aria-hidden="true" />
      {t(`machine.${state}`)}
    </small>
  );
}

export function MachinePicker({
  machines,
  selected,
  onChange,
  errors = [],
  disabled,
}: {
  machines: readonly HarnessAdminMachine[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  errors?: readonly string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("harness");
  const id = useId();
  const known = new Set(machines.map((machine) => machine.key));
  const options = [
    ...machines,
    ...selected
      .filter((key) => !known.has(key))
      .map((key) => ({ key, lodyName: key, online: null })),
  ];
  return (
    <fieldset
      className="harness-field"
      aria-describedby={errors.length > 0 ? `${id}-hint ${id}-error` : `${id}-hint`}
    >
      <legend>{t("fields.machines")}</legend>
      <p id={`${id}-hint`} className="harness-hint">
        {options.length === 0 ? t("fields.noMachines") : t("fields.machinesHint")}
      </p>
      <div className="harness-check-list">
        {options.map((machine) => (
          <label className="harness-check" key={machine.key}>
            <input
              type="checkbox"
              checked={selected.includes(machine.key)}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, machine.key]
                    : selected.filter((key) => key !== machine.key),
                )
              }
            />
            <span>
              <strong>
                {machine.key}
                {machine.lodyName !== machine.key ? (
                  <span className="harness-mono"> · {machine.lodyName}</span>
                ) : null}
              </strong>
              <MachineStatus online={machine.online} />
            </span>
          </label>
        ))}
      </div>
      <FieldErrors id={`${id}-error`} messages={errors} />
    </fieldset>
  );
}

export function PolicySummaryList({ policy }: { policy: HarnessAdminPolicySummary }) {
  const { t } = useTranslation("harness");
  const verify = [
    ["fields.verifyQuick", policy.verify.quick],
    ["fields.verifyFull", policy.verify.full],
    ["fields.verifyAcceptance", policy.verify.acceptance],
  ] as const;
  return (
    <>
      <dl className="harness-meta">
        <div>
          <dt>{t("list.policy")}</dt>
          <dd>
            <span className="harness-badge">{t(`policySource.${policy.source}`)}</span>
            <span className="harness-badge">{t(`kind.${policy.kind}`)}</span>
          </dd>
        </div>
        {verify.map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{value ? <code>{value}</code> : t("list.noVerify")}</dd>
          </div>
        ))}
        <div>
          <dt>{t("fields.releaseFragment")}</dt>
          <dd>
            {t(
              policy.releaseFragment === "required"
                ? "fields.releaseRequired"
                : "fields.releaseOptional",
            )}
          </dd>
        </div>
        {policy.preferSkills.length > 0 ? (
          <div>
            <dt>{t("fields.preferSkills")}</dt>
            <dd>
              {policy.preferSkills.map((skill) => (
                <span className="harness-badge" key={skill}>
                  {skill}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("fields.riskDefault")}</dt>
          <dd>{policy.riskDefault}</dd>
        </div>
      </dl>
      {policy.error ? (
        <Notice kind="warning">{t("list.policyError", { error: policy.error })}</Notice>
      ) : null}
    </>
  );
}

export function PolicyAdvancedFields({
  draft,
  onChange,
  open,
  onToggle,
  errors,
  disabled,
  footer,
}: {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  open: boolean;
  onToggle: (open: boolean) => void;
  errors: readonly HarnessAdminIssue[];
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const { t } = useTranslation("harness");
  const kindId = useId();
  const releaseId = useId();
  const set = (patch: Partial<PolicyDraft>) => onChange({ ...draft, ...patch });
  const skills = parseSkills(draft.preferSkills);
  return (
    <details
      className="harness-advanced"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        {t("fields.advanced")}
        <ChevronDown aria-hidden="true" />
      </summary>
      <div>
        <p className="harness-hint">{t("fields.advancedHint")}</p>
        <div className="harness-grid-2">
          <div className="harness-field">
            <label htmlFor={kindId}>{t("fields.kind")}</label>
            <select
              id={kindId}
              className="harness-select"
              value={draft.kind}
              disabled={disabled}
              onChange={(event) => set({ kind: event.target.value as HarnessProjectKind })}
            >
              {HARNESS_PROJECT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </select>
            <FieldErrors id={`${kindId}-error`} messages={issuesAt(errors, "policyPatch.kind")} />
          </div>
          <div className="harness-field">
            <label htmlFor={releaseId}>{t("fields.releaseFragment")}</label>
            <select
              id={releaseId}
              className="harness-select"
              value={draft.releaseFragment}
              disabled={disabled}
              onChange={(event) =>
                set({ releaseFragment: event.target.value as PolicyDraft["releaseFragment"] })
              }
            >
              <option value="required">{t("fields.releaseRequired")}</option>
              <option value="optional">{t("fields.releaseOptional")}</option>
            </select>
          </div>
        </div>
        <TextField
          label={t("fields.verifyQuick")}
          value={draft.verifyQuick}
          placeholder={t("fields.verifyPlaceholder")}
          disabled={disabled}
          errors={issuesAt(errors, "policyPatch.verify.quick")}
          onChange={(verifyQuick) => set({ verifyQuick })}
        />
        <TextField
          label={t("fields.verifyFull")}
          value={draft.verifyFull}
          placeholder={t("fields.verifyPlaceholder")}
          disabled={disabled}
          errors={issuesAt(errors, "policyPatch.verify.full")}
          onChange={(verifyFull) => set({ verifyFull })}
        />
        <TextField
          label={t("fields.verifyAcceptance")}
          value={draft.verifyAcceptance}
          placeholder={t("fields.verifyPlaceholder")}
          disabled={disabled}
          errors={issuesAt(errors, "policyPatch.verify.acceptance")}
          onChange={(verifyAcceptance) => set({ verifyAcceptance })}
        />
        <div className="harness-field">
          <TextField
            label={t("fields.preferSkills")}
            hint={t("fields.preferSkillsHint")}
            value={draft.preferSkills}
            disabled={disabled}
            errors={issuesAt(errors, "policyPatch.prompts")}
            onChange={(preferSkills) => set({ preferSkills })}
          />
          {skills.length > 0 ? (
            <div className="harness-badges" aria-hidden="true">
              {skills.map((skill) => (
                <span className="harness-badge is-accent" key={skill}>
                  {skill}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {footer}
      </div>
    </details>
  );
}
