import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clock3,
  RefreshCw,
  Save,
  Search,
  UsersRound,
} from "lucide-react";
import { AI_SETTING_BOUNDS, isWithinBounds } from "@cos-tool-bot/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { settingInputBounds } from "@/lib/setting-input-bounds";
import { GroupAiSelectionCard } from "./ai-selection-panel";
import type { MiniAppSessionView } from "./session";
import {
  fetchMiniAppGroup,
  fetchMiniAppGroups,
  MiniAppGroupApiError,
  patchMiniAppGroup,
  retryMiniAppGroupApply,
  type MiniAppGroup,
  type MiniAppGroupConfig,
  type MiniAppGroupPatch,
} from "./groups";

interface GroupsPageProps {
  botId: string;
  session: MiniAppSessionView;
}

type DraftConfig = Omit<MiniAppGroupConfig, "revision" | "aiConfigured">;
type Feedback = { kind: "success" | "pending" | "error"; key: string } | null;

const AI_FIELDS = [
  "group.enabled",
  "group.whitelisted",
  "group.trigger.replyToBot",
  "group.trigger.mentionBot",
  "group.trigger.triggerWords",
  "group.trigger.randomReplyPercent",
  "group.trigger.randomReplyCooldown",
  "group.conversation.enabled",
  "group.conversation.maxContextMessages",
  "group.conversation.groupHistoryMaxTokens",
] as const;

const SUMMARY_FIELDS = [
  "summary.enabled",
  "summary.scheduleHour",
  "summary.scheduleMinute",
  "summary.timezone",
  "summary.windowHours",
  "summary.maxMessages",
  "summary.cooldownSeconds",
] as const;

type FieldName = (typeof AI_FIELDS)[number] | (typeof SUMMARY_FIELDS)[number];

function groupName(group: MiniAppGroup): string {
  return group.title || (group.username ? `@${group.username}` : String(group.chatId));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function cloneDraft(config: MiniAppGroupConfig): DraftConfig {
  return {
    group: {
      enabled: config.group.enabled,
      whitelisted: config.group.whitelisted,
      trigger: { ...config.group.trigger, triggerWords: [...config.group.trigger.triggerWords] },
      conversation: { ...config.group.conversation },
    },
    summary: { ...config.summary },
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

function fieldValue(config: DraftConfig, field: FieldName): unknown {
  const [section, subsection, key] = field.split(".");
  if (section === "summary") return config.summary[subsection as keyof typeof config.summary];
  if (subsection === "trigger") {
    return config.group.trigger[key as keyof typeof config.group.trigger];
  }
  if (subsection === "conversation") {
    return config.group.conversation[key as keyof typeof config.group.conversation];
  }
  return config.group[subsection as "enabled" | "whitelisted"];
}

function changedFields(original: MiniAppGroupConfig, draft: DraftConfig): FieldName[] {
  const base = cloneDraft(original);
  return [...AI_FIELDS, ...SUMMARY_FIELDS].filter(
    (field) => !sameValue(fieldValue(base, field), fieldValue(draft, field)),
  );
}

function buildPatch(original: MiniAppGroupConfig, draft: DraftConfig): MiniAppGroupPatch {
  const patch: MiniAppGroupPatch = {};
  const fields = changedFields(original, draft);
  for (const field of fields) {
    if (field === "group.enabled" || field === "group.whitelisted") {
      patch.group ??= {};
      patch.group[field.slice("group.".length) as "enabled" | "whitelisted"] = fieldValue(
        draft,
        field,
      ) as boolean;
    } else if (field.startsWith("group.trigger.")) {
      patch.group ??= {};
      patch.group.trigger ??= {};
      const key = field.slice("group.trigger.".length) as keyof typeof draft.group.trigger;
      Object.assign(patch.group.trigger, { [key]: fieldValue(draft, field) });
    } else if (field.startsWith("group.conversation.")) {
      patch.group ??= {};
      patch.group.conversation ??= {};
      const key = field.slice(
        "group.conversation.".length,
      ) as keyof typeof draft.group.conversation;
      Object.assign(patch.group.conversation, { [key]: fieldValue(draft, field) });
    } else {
      patch.summary ??= {};
      const key = field.slice("summary.".length) as keyof typeof draft.summary;
      Object.assign(patch.summary, { [key]: fieldValue(draft, field) });
    }
  }
  return patch;
}

function parseNullableInteger(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function draftIsValid(draft: DraftConfig): boolean {
  const { trigger, conversation } = draft.group;
  const { summary } = draft;
  return (
    trigger.triggerWords.length <= 32 &&
    trigger.triggerWords.every((word) => word.length >= 1 && word.length <= 64) &&
    isWithinBounds(trigger.randomReplyPercent, AI_SETTING_BOUNDS.randomReplyPercent) &&
    isWithinBounds(trigger.randomReplyCooldown, AI_SETTING_BOUNDS.randomReplyCooldown) &&
    isWithinBounds(conversation.maxContextMessages, AI_SETTING_BOUNDS.maxContextMessages) &&
    isWithinBounds(conversation.groupHistoryMaxTokens, AI_SETTING_BOUNDS.groupHistoryMaxTokens) &&
    (summary.scheduleHour === null ||
      (Number.isInteger(summary.scheduleHour) &&
        summary.scheduleHour >= 0 &&
        summary.scheduleHour <= 23)) &&
    (summary.scheduleMinute === null ||
      (Number.isInteger(summary.scheduleMinute) &&
        summary.scheduleMinute >= 0 &&
        summary.scheduleMinute <= 59)) &&
    (summary.timezone === null ||
      (summary.timezone.trim().length >= 1 && summary.timezone.length <= 64)) &&
    Number.isInteger(summary.windowHours) &&
    summary.windowHours >= 1 &&
    summary.windowHours <= 72 &&
    (summary.maxMessages === null ||
      (Number.isInteger(summary.maxMessages) &&
        summary.maxMessages >= 10 &&
        summary.maxMessages <= 2_000)) &&
    (summary.cooldownSeconds === null ||
      (Number.isInteger(summary.cooldownSeconds) &&
        summary.cooldownSeconds >= 0 &&
        summary.cooldownSeconds <= 86_400))
  );
}

function StatusPill({ group }: { group: MiniAppGroup }) {
  const { t } = useTranslation("miniApp");
  const pending = group.applyState === "pending";
  return (
    <span className={`mini-groups-status ${pending ? "is-pending" : "is-applied"}`}>
      {pending ? <Clock3 aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
      {t(`groups.status.${group.applyState}`)}
    </span>
  );
}

function GroupsList({ botId }: { botId: string }) {
  const { t } = useTranslation("miniApp");
  const [groups, setGroups] = useState<MiniAppGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setFailed(false);
    setRefreshing(true);
    try {
      const response = await fetchMiniAppGroups(botId);
      setGroups(response.groups);
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [botId]);

  useEffect(() => {
    let active = true;
    void fetchMiniAppGroups(botId)
      .then((response) => {
        if (active) setGroups(response.groups);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [botId]);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return groups ?? [];
    return (groups ?? []).filter((group) =>
      [group.title, group.username, String(group.chatId)].some((value) =>
        value?.toLocaleLowerCase().includes(normalizedQuery),
      ),
    );
  }, [groups, query]);

  if (!groups && !failed) {
    return (
      <main className="mini-app-content mini-groups mini-groups-state" role="status">
        <span className="mini-app-loader" />
        <p>{t("groups.loading")}</p>
      </main>
    );
  }

  if (!groups) {
    return (
      <main className="mini-app-content mini-groups mini-groups-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{t("groups.errorTitle")}</h1>
        <p>{t("groups.errorBody")}</p>
        <button type="button" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          {t("groups.retry")}
        </button>
      </main>
    );
  }

  return (
    <main className="mini-app-content mini-groups">
      <header className="mini-groups-heading">
        <div>
          <p>{t("groups.eyebrow")}</p>
          <h1>{t("groups.title")}</h1>
        </div>
        <span>{t("groups.count", { count: groups.length })}</span>
      </header>
      <div className="mini-groups-toolbar">
        <label>
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={t("groups.searchLabel")}
            value={query}
            placeholder={t("groups.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="is-secondary mini-groups-refresh"
          aria-label={t("groups.refresh")}
          title={t("groups.refresh")}
          disabled={refreshing}
          onClick={() => void load()}
        >
          <RefreshCw className={refreshing ? "is-spinning" : undefined} aria-hidden="true" />
        </button>
      </div>
      {failed ? (
        <p className="mini-groups-feedback is-error" role="alert">
          {t("groups.refreshFailed")}
        </p>
      ) : null}
      {groups.length === 0 ? (
        <section className="mini-groups-empty">
          <UsersRound aria-hidden="true" />
          <h2>{t("groups.emptyTitle")}</h2>
          <p>{t("groups.emptyBody")}</p>
        </section>
      ) : filteredGroups.length === 0 ? (
        <section className="mini-groups-empty is-filtered">
          <Search aria-hidden="true" />
          <h2>{t("groups.noMatches")}</h2>
        </section>
      ) : (
        <section className="mini-groups-list" aria-label={t("groups.listLabel")}>
          {filteredGroups.map((group) => (
            <Link key={group.chatId} to={`/mini-app/${botId}/groups/${group.chatId}`}>
              <div className="mini-groups-card-title">
                <span>{groupName(group)}</span>
                {group.archived ? <small>{t("groups.status.archived")}</small> : null}
              </div>
              <div className="mini-groups-card-meta">
                <code>{group.chatId}</code>
                {group.config.aiConfigured ? (
                  <span className="mini-groups-ai-entry">{t("groups.aiSelectionEntry")}</span>
                ) : null}
                <StatusPill group={group} />
              </div>
              <ChevronRight aria-hidden="true" />
            </Link>
          ))}
        </section>
      )}
    </main>
  );
}

function ReadValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function GroupReadOnly({ group }: { group: MiniAppGroup }) {
  const { t } = useTranslation("miniApp");
  const boolean = (value: boolean) => t(value ? "groups.values.on" : "groups.values.off");
  const nullable = (value: number | string | null) =>
    value === null ? t("groups.values.unset") : String(value);
  return (
    <div className="mini-groups-readonly">
      {!group.config.aiConfigured ? (
        <p className="mini-groups-notice is-warning">{t("groups.aiUnavailable")}</p>
      ) : null}
      <section>
        <h2>{t("groups.sections.ai")}</h2>
        <dl>
          <ReadValue
            label={t("groups.fields.groupEnabled")}
            value={boolean(group.config.group.enabled)}
          />
          <ReadValue
            label={t("groups.fields.whitelisted")}
            value={boolean(group.config.group.whitelisted)}
          />
          <ReadValue
            label={t("groups.fields.replyToBot")}
            value={boolean(group.config.group.trigger.replyToBot)}
          />
          <ReadValue
            label={t("groups.fields.mentionBot")}
            value={boolean(group.config.group.trigger.mentionBot)}
          />
          <ReadValue
            label={t("groups.fields.triggerWords")}
            value={group.config.group.trigger.triggerWords.join(", ") || t("groups.values.none")}
          />
          <ReadValue
            label={t("groups.fields.randomReplyPercent")}
            value={`${group.config.group.trigger.randomReplyPercent}%`}
          />
          <ReadValue
            label={t("groups.fields.randomReplyCooldown")}
            value={String(group.config.group.trigger.randomReplyCooldown)}
          />
          <ReadValue
            label={t("groups.fields.conversationEnabled")}
            value={boolean(group.config.group.conversation.enabled)}
          />
          <ReadValue
            label={t("groups.fields.maxContextMessages")}
            value={String(group.config.group.conversation.maxContextMessages)}
          />
          <ReadValue
            label={t("groups.fields.groupHistoryMaxTokens")}
            value={String(group.config.group.conversation.groupHistoryMaxTokens)}
          />
        </dl>
      </section>
      <section>
        <h2>{t("groups.sections.summary")}</h2>
        <dl>
          <ReadValue
            label={t("groups.fields.summaryEnabled")}
            value={boolean(group.config.summary.enabled)}
          />
          <ReadValue
            label={t("groups.fields.scheduleHour")}
            value={nullable(group.config.summary.scheduleHour)}
          />
          <ReadValue
            label={t("groups.fields.scheduleMinute")}
            value={nullable(group.config.summary.scheduleMinute)}
          />
          <ReadValue
            label={t("groups.fields.timezone")}
            value={nullable(group.config.summary.timezone)}
          />
          <ReadValue
            label={t("groups.fields.windowHours")}
            value={String(group.config.summary.windowHours)}
          />
          <ReadValue
            label={t("groups.fields.maxMessages")}
            value={nullable(group.config.summary.maxMessages)}
          />
          <ReadValue
            label={t("groups.fields.cooldownSeconds")}
            value={nullable(group.config.summary.cooldownSeconds)}
          />
        </dl>
      </section>
    </div>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="mini-groups-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  nullable = false,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number | "any";
  nullable?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="mini-groups-field">
      <span>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        required={!nullable}
        onChange={(event) => onChange(parseNullableInteger(event.target.value))}
      />
    </label>
  );
}

function GroupEditor({
  group,
  draft,
  setDraft,
}: {
  group: MiniAppGroup;
  draft: DraftConfig;
  setDraft: (updater: (current: DraftConfig) => DraftConfig) => void;
}) {
  const { t } = useTranslation("miniApp");
  const updateGroup = (patch: Partial<DraftConfig["group"]>) =>
    setDraft((current) => ({ ...current, group: { ...current.group, ...patch } }));
  const updateTrigger = (patch: Partial<DraftConfig["group"]["trigger"]>) =>
    setDraft((current) => ({
      ...current,
      group: { ...current.group, trigger: { ...current.group.trigger, ...patch } },
    }));
  const updateConversation = (patch: Partial<DraftConfig["group"]["conversation"]>) =>
    setDraft((current) => ({
      ...current,
      group: { ...current.group, conversation: { ...current.group.conversation, ...patch } },
    }));
  const updateSummary = (patch: Partial<DraftConfig["summary"]>) =>
    setDraft((current) => ({ ...current, summary: { ...current.summary, ...patch } }));

  return (
    <div className="mini-groups-editor">
      <section>
        <h2>{t("groups.sections.ai")}</h2>
        {!group.config.aiConfigured ? (
          <p className="mini-groups-notice is-warning">{t("groups.aiUnavailable")}</p>
        ) : (
          <div className="mini-groups-fields">
            <ToggleField
              label={t("groups.fields.groupEnabled")}
              checked={draft.group.enabled}
              onChange={(enabled) => updateGroup({ enabled })}
            />
            <ToggleField
              label={t("groups.fields.whitelisted")}
              checked={draft.group.whitelisted}
              onChange={(whitelisted) => updateGroup({ whitelisted })}
            />
            <ToggleField
              label={t("groups.fields.replyToBot")}
              checked={draft.group.trigger.replyToBot}
              onChange={(replyToBot) => updateTrigger({ replyToBot })}
            />
            <ToggleField
              label={t("groups.fields.mentionBot")}
              checked={draft.group.trigger.mentionBot}
              onChange={(mentionBot) => updateTrigger({ mentionBot })}
            />
            <label className="mini-groups-field is-wide">
              <span>{t("groups.fields.triggerWords")}</span>
              <input
                type="text"
                value={draft.group.trigger.triggerWords.join(", ")}
                placeholder={t("groups.triggerWordsPlaceholder")}
                onChange={(event) =>
                  updateTrigger({
                    triggerWords: event.target.value
                      .split(",")
                      .map((word) => word.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <NumberField
              label={t("groups.fields.randomReplyPercent")}
              value={draft.group.trigger.randomReplyPercent}
              {...settingInputBounds(AI_SETTING_BOUNDS.randomReplyPercent)}
              onChange={(randomReplyPercent) =>
                updateTrigger({ randomReplyPercent: randomReplyPercent ?? 0 })
              }
            />
            <NumberField
              label={t("groups.fields.randomReplyCooldown")}
              value={draft.group.trigger.randomReplyCooldown}
              {...settingInputBounds(AI_SETTING_BOUNDS.randomReplyCooldown)}
              onChange={(randomReplyCooldown) =>
                updateTrigger({ randomReplyCooldown: randomReplyCooldown ?? 0 })
              }
            />
            <ToggleField
              label={t("groups.fields.conversationEnabled")}
              checked={draft.group.conversation.enabled}
              onChange={(enabled) => updateConversation({ enabled })}
            />
            <NumberField
              label={t("groups.fields.maxContextMessages")}
              value={draft.group.conversation.maxContextMessages}
              {...settingInputBounds(AI_SETTING_BOUNDS.maxContextMessages)}
              onChange={(maxContextMessages) =>
                updateConversation({ maxContextMessages: maxContextMessages ?? 0 })
              }
            />
            <NumberField
              label={t("groups.fields.groupHistoryMaxTokens")}
              value={draft.group.conversation.groupHistoryMaxTokens}
              {...settingInputBounds(AI_SETTING_BOUNDS.groupHistoryMaxTokens)}
              onChange={(groupHistoryMaxTokens) =>
                updateConversation({ groupHistoryMaxTokens: groupHistoryMaxTokens ?? 0 })
              }
            />
          </div>
        )}
      </section>
      <section>
        <h2>{t("groups.sections.summary")}</h2>
        <div className="mini-groups-fields">
          <ToggleField
            label={t("groups.fields.summaryEnabled")}
            checked={draft.summary.enabled}
            onChange={(enabled) => updateSummary({ enabled })}
          />
          <NumberField
            label={t("groups.fields.scheduleHour")}
            value={draft.summary.scheduleHour}
            min={0}
            max={23}
            nullable
            onChange={(scheduleHour) => updateSummary({ scheduleHour })}
          />
          <NumberField
            label={t("groups.fields.scheduleMinute")}
            value={draft.summary.scheduleMinute}
            min={0}
            max={59}
            nullable
            onChange={(scheduleMinute) => updateSummary({ scheduleMinute })}
          />
          <label className="mini-groups-field">
            <span>{t("groups.fields.timezone")}</span>
            <input
              type="text"
              maxLength={64}
              value={draft.summary.timezone ?? ""}
              placeholder="Asia/Shanghai"
              onChange={(event) => updateSummary({ timezone: event.target.value.trim() || null })}
            />
          </label>
          <NumberField
            label={t("groups.fields.windowHours")}
            value={draft.summary.windowHours}
            min={1}
            max={72}
            onChange={(windowHours) => updateSummary({ windowHours: windowHours ?? 0 })}
          />
          <NumberField
            label={t("groups.fields.maxMessages")}
            value={draft.summary.maxMessages}
            min={10}
            max={2_000}
            nullable
            onChange={(maxMessages) => updateSummary({ maxMessages })}
          />
          <NumberField
            label={t("groups.fields.cooldownSeconds")}
            value={draft.summary.cooldownSeconds}
            min={0}
            max={86_400}
            nullable
            onChange={(cooldownSeconds) => updateSummary({ cooldownSeconds })}
          />
        </div>
      </section>
    </div>
  );
}

function GroupDetail({ botId, chatId, session }: GroupsPageProps & { chatId: number }) {
  const { t } = useTranslation("miniApp");
  const [detail, setDetail] = useState<{ editable: boolean; group: MiniAppGroup } | null>(null);
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [conflictLatest, setConflictLatest] = useState<MiniAppGroup | null>(null);

  const adopt = (next: { editable: boolean; group: MiniAppGroup }) => {
    setDetail(next);
    setDraft(cloneDraft(next.group.config));
  };

  const load = useCallback(async () => {
    setFailed(false);
    try {
      adopt(await fetchMiniAppGroup(botId, chatId));
    } catch {
      setFailed(true);
    }
  }, [botId, chatId]);

  useEffect(() => {
    let active = true;
    void fetchMiniAppGroup(botId, chatId)
      .then((response) => {
        if (active) adopt(response);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [botId, chatId]);

  const changes = useMemo(
    () => (detail && draft ? changedFields(detail.group.config, draft) : []),
    [detail, draft],
  );
  const editable = Boolean(
    detail?.editable &&
    !detail.group.archived &&
    (session.role === "admin" || session.role === "operator"),
  );
  const valid = draft ? draftIsValid(draft) : false;

  if (!detail && !failed) {
    return (
      <main className="mini-app-content mini-groups mini-groups-state" role="status">
        <span className="mini-app-loader" />
        <p>{t("groups.loadingDetail")}</p>
      </main>
    );
  }

  if (!detail || !draft) {
    return (
      <main className="mini-app-content mini-groups mini-groups-state" role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{t("groups.errorTitle")}</h1>
        <p>{t("groups.errorBody")}</p>
        <button type="button" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          {t("groups.retry")}
        </button>
      </main>
    );
  }

  const save = async () => {
    if (!valid || changes.length === 0) return;
    setSaving(true);
    setFeedback(null);
    setConflictLatest(null);
    try {
      const result = await patchMiniAppGroup({
        botId,
        chatId,
        expectedRevision: detail.group.config.revision,
        patch: buildPatch(detail.group.config, draft),
        csrfToken: session.csrfToken,
      });
      adopt({ editable: detail.editable, group: result.group });
      setFeedback({
        kind: result.persisted && result.applied ? "success" : "pending",
        key: result.persisted && result.applied ? "groups.savedApplied" : "groups.savedPending",
      });
    } catch (error) {
      if (error instanceof MiniAppGroupApiError && error.code === "stale_revision") {
        setConflictLatest(error.latest ?? null);
        setFeedback({ kind: "error", key: "groups.conflictBody" });
      } else if (error instanceof MiniAppGroupApiError && error.code === "archived") {
        setFeedback({ kind: "error", key: "groups.archivedDuringEdit" });
        void load();
      } else if (error instanceof MiniAppGroupApiError && error.code === "ai_not_configured") {
        setFeedback({ kind: "error", key: "groups.aiUnavailable" });
        void load();
      } else {
        setFeedback({ kind: "error", key: "groups.saveFailed" });
      }
    } finally {
      setSaving(false);
    }
  };

  const retryApply = async () => {
    setRetrying(true);
    setFeedback(null);
    try {
      const group = await retryMiniAppGroupApply({ botId, chatId, csrfToken: session.csrfToken });
      adopt({ editable: detail.editable, group });
      setFeedback({
        kind: group.applyState === "applied" ? "success" : "pending",
        key: group.applyState === "applied" ? "groups.retryApplied" : "groups.retryPending",
      });
    } catch {
      setFeedback({ kind: "error", key: "groups.retryFailed" });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <main className="mini-app-content mini-groups mini-groups-detail">
      <Link className="mini-groups-back" to={`/mini-app/${botId}/groups`}>
        <ArrowLeft aria-hidden="true" />
        {t("groups.back")}
      </Link>
      <header className="mini-groups-detail-heading">
        <div>
          <p>{detail.group.type}</p>
          <h1>{groupName(detail.group)}</h1>
          <code>{detail.group.chatId}</code>
        </div>
        <StatusPill group={detail.group} />
      </header>
      <div className="mini-groups-observed">
        <span>{t("groups.lastObserved", { date: formatDate(detail.group.lastObservedAt) })}</span>
        {detail.group.botMembershipStatus ? <span>{detail.group.botMembershipStatus}</span> : null}
      </div>

      {detail.group.archived ? (
        <p className="mini-groups-notice is-warning" role="status">
          {t("groups.archivedReadOnly")}
        </p>
      ) : !editable ? (
        <p className="mini-groups-notice">{t("groups.viewerReadOnly")}</p>
      ) : null}

      {detail.group.applyState === "pending" ? (
        <section className="mini-groups-apply-state" role="status">
          <div>
            <Clock3 aria-hidden="true" />
            <span>
              <strong>{t("groups.pendingTitle")}</strong>
              {t("groups.pendingBody")}
            </span>
          </div>
          {session.role === "admin" ? (
            <button
              type="button"
              disabled={retrying || changes.length > 0}
              onClick={() => void retryApply()}
            >
              <RefreshCw aria-hidden="true" />
              {retrying ? t("groups.retrying") : t("groups.retryApply")}
            </button>
          ) : null}
        </section>
      ) : null}

      {detail.group.config.aiConfigured ? (
        <GroupAiSelectionCard botId={botId} chatId={chatId} session={session} />
      ) : null}

      {editable ? (
        <GroupEditor
          group={detail.group}
          draft={draft}
          setDraft={(updater) => setDraft((current) => (current ? updater(current) : current))}
        />
      ) : (
        <GroupReadOnly group={detail.group} />
      )}

      {editable ? (
        <section className="mini-groups-save-panel">
          <div>
            <h2>{t("groups.changesTitle")}</h2>
            {changes.length === 0 ? (
              <p>{t("groups.noChanges")}</p>
            ) : (
              <ul>
                {changes.map((field) => (
                  <li key={field}>{t(`groups.changeLabels.${field}`)}</li>
                ))}
              </ul>
            )}
            {!valid ? (
              <p className="mini-groups-validation" role="alert">
                {t("groups.validationError")}
              </p>
            ) : null}
          </div>
          <div className="mini-groups-save-actions">
            <button
              type="button"
              className="is-secondary"
              disabled={saving || changes.length === 0}
              onClick={() => {
                setDraft(cloneDraft(detail.group.config));
                setFeedback(null);
                setConflictLatest(null);
              }}
            >
              {t("groups.discard")}
            </button>
            <button
              type="button"
              disabled={saving || changes.length === 0 || !valid}
              onClick={() => void save()}
            >
              <Save aria-hidden="true" />
              {saving ? t("groups.saving") : t("groups.save")}
            </button>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <p
          className={`mini-groups-feedback is-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {t(feedback.key)}
        </p>
      ) : null}

      {conflictLatest ? (
        <section className="mini-groups-conflict" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <h2>{t("groups.conflictTitle")}</h2>
            <p>{t("groups.conflictKeepDraft")}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              adopt({ editable: detail.editable, group: conflictLatest });
              setConflictLatest(null);
              setFeedback(null);
            }}
          >
            {t("groups.useLatest")}
          </button>
        </section>
      ) : null}
    </main>
  );
}

export function GroupsPage({ botId, session }: GroupsPageProps) {
  const { chatId } = useParams<{ chatId?: string }>();
  if (chatId === undefined) return <GroupsList botId={botId} />;
  const parsedChatId = Number(chatId);
  return Number.isSafeInteger(parsedChatId) && parsedChatId < 0 ? (
    <GroupDetail botId={botId} chatId={parsedChatId} session={session} />
  ) : (
    <GroupsList botId={botId} />
  );
}
