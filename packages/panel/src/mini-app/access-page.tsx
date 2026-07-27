import {
  BadgeCheck,
  Bot,
  Check,
  ExternalLink,
  History,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MiniAppSessionView } from "./session";
import {
  createMiniAppChatGrant,
  createMiniAppOperatorGrant,
  fetchMiniAppAccess,
  MiniAppAccessError,
  type MiniAppAccessPerson,
  type MiniAppAccessView,
  revokeMiniAppChatGrant,
  revokeMiniAppOperatorGrant,
  searchMiniAppAccessPeople,
} from "./access";

interface AccessPageProps {
  botId: string;
  session: MiniAppSessionView;
}

type RevocationTarget = { kind: "chat"; id: number } | { kind: "operator"; id: number } | null;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function personName(person: {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
}): string {
  return (
    person.displayName || (person.username ? `@${person.username}` : String(person.telegramUserId))
  );
}

function requestErrorKey(error: unknown): string {
  if (error instanceof MiniAppAccessError && error.code === "bot_admin_required") {
    return "access.errors.botAdminRequired";
  }
  if (error instanceof MiniAppAccessError && error.code === "conflict") {
    return "access.errors.conflict";
  }
  return "access.errors.generic";
}

function matchesFilter(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function EmptyState({ children }: { children: string }) {
  return <p className="mini-access-empty">{children}</p>;
}

export function AccessPage({ botId, session }: AccessPageProps) {
  const { t } = useTranslation("miniApp");
  const [data, setData] = useState<MiniAppAccessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [actionErrorKey, setActionErrorKey] = useState<string | null>(null);
  const [chatNotes, setChatNotes] = useState<Record<string, string>>({});
  const [revocation, setRevocation] = useState<RevocationTarget>(null);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<MiniAppAccessPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<MiniAppAccessPerson | null>(null);
  const [operatorNote, setOperatorNote] = useState("");
  const [activityFilters, setActivityFilters] = useState({ actor: "", action: "", resource: "" });
  const requestVersion = useRef(0);

  const loadAccess = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoadError(false);
    try {
      const next = await fetchMiniAppAccess(botId);
      if (version === requestVersion.current) setData(next);
    } catch {
      if (version === requestVersion.current) setLoadError(true);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setLoading(true);
    void loadAccess();
    return () => {
      requestVersion.current += 1;
    };
  }, [loadAccess]);

  useEffect(() => {
    const normalized = query.trim();
    setSelectedPerson(null);
    setSearchFailed(false);
    if (!normalized) {
      setPeople([]);
      setSearching(false);
      return;
    }

    setPeople([]);
    setSearching(true);
    let active = true;
    const timer = window.setTimeout(() => {
      void searchMiniAppAccessPeople(botId, normalized)
        .then((next) => {
          if (active) setPeople(next);
        })
        .catch(() => {
          if (active) {
            setPeople([]);
            setSearchFailed(true);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [botId, query]);

  const runMutation = async (key: string, mutation: () => Promise<void>): Promise<boolean> => {
    setMutationKey(key);
    setActionErrorKey(null);
    try {
      await mutation();
      await loadAccess();
      setRevocation(null);
      return true;
    } catch (error) {
      if (error instanceof MiniAppAccessError && error.code === "conflict") await loadAccess();
      setActionErrorKey(requestErrorKey(error));
      return false;
    } finally {
      setMutationKey(null);
    }
  };

  const exactTelegramId = useMemo(() => {
    const normalized = query.trim();
    if (!/^[1-9]\d*$/.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isSafeInteger(value) ? value : null;
  }, [query]);
  const exactResult = exactTelegramId
    ? people.find((person) => person.telegramUserId === exactTelegramId)
    : undefined;
  const manualPerson: MiniAppAccessPerson | null =
    exactTelegramId && !exactResult
      ? { telegramUserId: exactTelegramId, username: null, displayName: null, lastSeen: "" }
      : null;
  const operatorIds = new Set(data?.operators.map(({ telegramUserId }) => telegramUserId));
  const grantedChatCount = data?.chats.filter(({ granted }) => granted).length ?? 0;
  const filteredActivity = data?.activity.filter((entry) => {
    const actor = `${entry.actorRole} ${entry.actorTelegramUserId ?? ""}`.toLowerCase();
    const resource = `${entry.resourceType} ${entry.resourceId}`.toLowerCase();
    return (
      matchesFilter(actor, activityFilters.actor) &&
      matchesFilter(entry.action, activityFilters.action) &&
      matchesFilter(resource, activityFilters.resource)
    );
  });

  if (loading && !data) {
    return (
      <main className="mini-access mini-access-state" role="status" aria-live="polite">
        <span className="mini-app-loader" />
        <p>{t("access.loading")}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mini-access mini-access-state" role="alert">
        <ShieldAlert aria-hidden="true" />
        <h1>{t("access.errors.title")}</h1>
        <p>{t("access.errors.generic")}</p>
        <button type="button" onClick={() => void loadAccess()}>
          {t("access.retry")}
        </button>
      </main>
    );
  }

  const botUsername = data.bot.username.replace(/^@/, "");
  const addGroupUrl = `https://t.me/${encodeURIComponent(botUsername)}?startgroup&admin=manage_chat+pin_messages`;

  return (
    <main className="mini-app-content mini-access">
      <header className="mini-access-intro">
        <div className="mini-access-intro-title">
          <h1>{t("access.title")}</h1>
          <p>{t("access.intro", { bot: data.bot.displayName })}</p>
        </div>
        <dl className="mini-access-summary" aria-label={t("access.summary.label")}>
          <div>
            <dt>{t("access.summary.chats")}</dt>
            <dd>
              {grantedChatCount}
              <span>/{data.chats.length}</span>
            </dd>
          </div>
          <div>
            <dt>{t("access.summary.operators")}</dt>
            <dd>{data.operators.length}</dd>
          </div>
        </dl>
        <button
          className="mini-access-icon-button"
          type="button"
          aria-label={t("access.refresh")}
          disabled={loading}
          onClick={() => void loadAccess()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>

      {loadError ? <p className="mini-access-alert">{t("access.errors.refresh")}</p> : null}
      {actionErrorKey ? (
        <p className="mini-access-alert" role="alert">
          {t(actionErrorKey)}
        </p>
      ) : null}

      <section className="mini-access-section" aria-labelledby="access-chats-title">
        <div className="mini-access-section-heading">
          <div>
            <MessageSquare aria-hidden="true" />
            <div>
              <h2 id="access-chats-title">{t("access.chats.title")}</h2>
              <p>{t("access.chats.description")}</p>
            </div>
          </div>
          <div className="mini-access-section-action">
            <span className="mini-access-section-count">{data.chats.length}</span>
            {botUsername ? (
              <a
                className="mini-access-primary-link"
                href={addGroupUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Bot aria-hidden="true" />
                {t("access.chats.addGroup")}
                <ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <p className="mini-access-link-unavailable">
                {t("access.chats.addGroupUnavailable")}
              </p>
            )}
          </div>
        </div>

        {data.chats.length === 0 ? (
          <EmptyState>{t("access.chats.empty")}</EmptyState>
        ) : (
          <div className="mini-access-card-list">
            {data.chats.map((chat) => {
              const canGrant =
                chat.botMembershipStatus === "administrator" ||
                chat.botMembershipStatus === "creator";
              const mutationId = `chat:${chat.chatId}`;
              const confirming = revocation?.kind === "chat" && revocation.id === chat.chatId;
              return (
                <article className="mini-access-card" key={chat.chatId}>
                  <div className="mini-access-card-title">
                    <MessageSquare aria-hidden="true" />
                    <div>
                      <h3>{chat.title || t("access.chats.untitled")}</h3>
                      <p>
                        {chat.username ? `@${chat.username} · ` : ""}
                        {chat.chatId}
                      </p>
                    </div>
                    <span className={chat.granted ? "is-granted" : ""}>
                      {t(chat.granted ? "access.chats.granted" : "access.chats.notGranted")}
                    </span>
                  </div>
                  <dl className="mini-access-facts">
                    <div>
                      <dt>{t("access.chats.membership")}</dt>
                      <dd
                        className={
                          chat.leftAt ||
                          chat.botMembershipStatus === "left" ||
                          chat.botMembershipStatus === "kicked"
                            ? "is-danger"
                            : undefined
                        }
                      >
                        {chat.botMembershipStatus || t("access.chats.unknownMembership")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("access.lastSeen")}</dt>
                      <dd>{formatDate(chat.lastObservedAt)}</dd>
                    </div>
                  </dl>

                  {chat.granted ? (
                    <div className="mini-access-grant-detail">
                      {chat.grant?.note ? <p>{chat.grant.note}</p> : null}
                      <small>
                        {t("access.grantedBy", {
                          id: chat.grant?.createdBy,
                          date: chat.grant ? formatDate(chat.grant.createdAt) : "",
                        })}
                      </small>
                      {confirming ? (
                        <div
                          className="mini-access-confirm"
                          role="group"
                          aria-label={t("access.confirm.title")}
                        >
                          <strong>{t("access.confirm.chat")}</strong>
                          <button
                            type="button"
                            disabled={mutationKey === mutationId}
                            onClick={() =>
                              void runMutation(mutationId, () =>
                                revokeMiniAppChatGrant({
                                  botId,
                                  chatId: chat.chatId,
                                  csrfToken: session.csrfToken,
                                }),
                              )
                            }
                          >
                            <Check aria-hidden="true" />
                            {t("access.confirm.revoke")}
                          </button>
                          <button type="button" onClick={() => setRevocation(null)}>
                            <X aria-hidden="true" />
                            {t("access.confirm.cancel")}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="mini-access-danger-button"
                          type="button"
                          onClick={() => setRevocation({ kind: "chat", id: chat.chatId })}
                        >
                          <Trash2 aria-hidden="true" />
                          {t("access.chats.revoke")}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="mini-access-grant-form">
                      {!canGrant ? (
                        <p className="mini-access-membership-warning">
                          <ShieldAlert aria-hidden="true" />
                          {t("access.chats.adminRequired")}
                        </p>
                      ) : null}
                      <label htmlFor={`chat-note-${chat.chatId}`}>{t("access.note")}</label>
                      <input
                        id={`chat-note-${chat.chatId}`}
                        maxLength={200}
                        value={chatNotes[String(chat.chatId)] ?? ""}
                        placeholder={t("access.noteOptional")}
                        onChange={(event) =>
                          setChatNotes((current) => ({
                            ...current,
                            [String(chat.chatId)]: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        disabled={mutationKey === mutationId}
                        onClick={() =>
                          void runMutation(mutationId, () =>
                            createMiniAppChatGrant({
                              botId,
                              chatId: chat.chatId,
                              note: chatNotes[String(chat.chatId)] ?? "",
                              csrfToken: session.csrfToken,
                            }),
                          )
                        }
                      >
                        {t(canGrant ? "access.chats.grant" : "access.chats.verifyAndGrant")}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="mini-access-section" aria-labelledby="access-operators-title">
        <div className="mini-access-section-heading">
          <div>
            <UsersRound aria-hidden="true" />
            <div>
              <h2 id="access-operators-title">{t("access.operators.title")}</h2>
              <p>{t("access.operators.description")}</p>
            </div>
          </div>
          <span className="mini-access-section-count">{data.operators.length}</span>
        </div>

        <div className="mini-access-search-panel">
          <label htmlFor="operator-search">{t("access.operators.searchLabel")}</label>
          <div className="mini-access-search-input">
            <Search aria-hidden="true" />
            <input
              id="operator-search"
              value={query}
              autoComplete="off"
              placeholder={t("access.operators.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <small>{t("access.operators.searchPrivacy")}</small>

          {searching ? (
            <p className="mini-access-search-state" role="status">
              {t("access.operators.searching")}
            </p>
          ) : searchFailed ? (
            <p className="mini-access-search-state" role="alert">
              {t("access.operators.searchFailed")}
            </p>
          ) : query.trim() && people.length === 0 && !manualPerson ? (
            <p className="mini-access-search-state">{t("access.operators.noResults")}</p>
          ) : null}

          {[...people, ...(manualPerson ? [manualPerson] : [])].length > 0 ? (
            <div
              className="mini-access-people"
              role="listbox"
              aria-label={t("access.operators.results")}
            >
              {[...people, ...(manualPerson ? [manualPerson] : [])].map((person) => {
                const manual = person === manualPerson;
                const selected = selectedPerson?.telegramUserId === person.telegramUserId;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={person.telegramUserId}
                    onClick={() => setSelectedPerson(person)}
                  >
                    <span>{personName(person)}</span>
                    <small>
                      {person.telegramUserId}
                      {person.username ? ` · @${person.username}` : ""}
                    </small>
                    {manual ? <em>{t("access.operators.unverified")}</em> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {selectedPerson ? (
            <div className="mini-access-operator-form">
              <div>
                <strong>{personName(selectedPerson)}</strong>
                <span>{selectedPerson.telegramUserId}</span>
              </div>
              <label htmlFor="operator-note">{t("access.note")}</label>
              <input
                id="operator-note"
                maxLength={200}
                value={operatorNote}
                placeholder={t("access.noteOptional")}
                onChange={(event) => setOperatorNote(event.target.value)}
              />
              <button
                type="button"
                disabled={
                  operatorIds.has(selectedPerson.telegramUserId) || mutationKey === "operator:add"
                }
                onClick={() =>
                  void (async () => {
                    const created = await runMutation("operator:add", () =>
                      createMiniAppOperatorGrant({
                        botId,
                        telegramUserId: selectedPerson.telegramUserId,
                        note: operatorNote,
                        csrfToken: session.csrfToken,
                      }),
                    );
                    if (created) {
                      setOperatorNote("");
                      setQuery("");
                    }
                  })()
                }
              >
                <UserPlus aria-hidden="true" />
                {operatorIds.has(selectedPerson.telegramUserId)
                  ? t("access.operators.alreadyOperator")
                  : t("access.operators.grant")}
              </button>
            </div>
          ) : null}
        </div>

        {data.operators.length === 0 ? (
          <EmptyState>{t("access.operators.empty")}</EmptyState>
        ) : (
          <div className="mini-access-card-list mini-access-operator-list">
            {data.operators.map((operator) => {
              const mutationId = `operator:${operator.telegramUserId}`;
              const confirming =
                revocation?.kind === "operator" && revocation.id === operator.telegramUserId;
              return (
                <article
                  className="mini-access-card mini-access-operator"
                  key={operator.telegramUserId}
                >
                  <div className="mini-access-card-title">
                    <UsersRound aria-hidden="true" />
                    <div>
                      <h3>{personName(operator)}</h3>
                      <p>
                        {operator.telegramUserId}
                        {operator.username ? ` · @${operator.username}` : ""}
                      </p>
                    </div>
                    {operator.verified ? (
                      <span className="is-verified">
                        <BadgeCheck aria-hidden="true" />
                        {t("access.operators.verified")}
                      </span>
                    ) : (
                      <span>{t("access.operators.unverified")}</span>
                    )}
                  </div>
                  {operator.note ? <p className="mini-access-note">{operator.note}</p> : null}
                  <small>
                    {t("access.grantedBy", {
                      id: operator.createdBy,
                      date: formatDate(operator.createdAt),
                    })}
                  </small>
                  {confirming ? (
                    <div
                      className="mini-access-confirm"
                      role="group"
                      aria-label={t("access.confirm.title")}
                    >
                      <strong>{t("access.confirm.operator")}</strong>
                      <button
                        type="button"
                        disabled={mutationKey === mutationId}
                        onClick={() =>
                          void runMutation(mutationId, () =>
                            revokeMiniAppOperatorGrant({
                              botId,
                              telegramUserId: operator.telegramUserId,
                              csrfToken: session.csrfToken,
                            }),
                          )
                        }
                      >
                        <Check aria-hidden="true" />
                        {t("access.confirm.revoke")}
                      </button>
                      <button type="button" onClick={() => setRevocation(null)}>
                        <X aria-hidden="true" />
                        {t("access.confirm.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="mini-access-danger-button"
                      type="button"
                      onClick={() =>
                        setRevocation({ kind: "operator", id: operator.telegramUserId })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      {t("access.operators.revoke")}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="mini-access-section" aria-labelledby="access-activity-title">
        <div className="mini-access-section-heading">
          <div>
            <History aria-hidden="true" />
            <div>
              <h2 id="access-activity-title">{t("access.activity.title")}</h2>
              <p>{t("access.activity.description")}</p>
            </div>
          </div>
          <span className="mini-access-section-count">{filteredActivity?.length ?? 0}</span>
        </div>
        <div className="mini-access-filters" aria-label={t("access.activity.filterLabel")}>
          {(["actor", "action", "resource"] as const).map((filter) => (
            <label key={filter}>
              <span>{t(`access.activity.filters.${filter}`)}</span>
              <input
                value={activityFilters[filter]}
                placeholder={t(`access.activity.placeholders.${filter}`)}
                onChange={(event) =>
                  setActivityFilters((current) => ({ ...current, [filter]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
        {!filteredActivity?.length ? (
          <EmptyState>{t("access.activity.empty")}</EmptyState>
        ) : (
          <ol className="mini-access-activity">
            {filteredActivity.map((entry) => (
              <li key={entry.id}>
                <History aria-hidden="true" />
                <div>
                  <strong>{entry.action}</strong>
                  <span>
                    {entry.resourceType} · {entry.resourceId}
                  </span>
                </div>
                <div>
                  <em>{entry.outcome}</em>
                  <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                  <small>
                    {entry.actorRole}
                    {entry.actorTelegramUserId ? ` · ${entry.actorTelegramUserId}` : ""}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
