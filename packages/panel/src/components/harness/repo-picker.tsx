import type { HarnessAdminRepo, HarnessAdminRepoList } from "@cos-tool-bot/shared";
import { ExternalLink, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessAdminApiError, type HarnessAdminApi } from "@/lib/harness-admin-client";
import { ApiErrorNotice } from "./project-fields";
import "./i18n";

function ownerOf(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash > 0 ? fullName.slice(0, slash) : fullName;
}

function nameOf(fullName: string): string {
  return fullName.slice(fullName.indexOf("/") + 1);
}

export function groupRepos(repos: readonly HarnessAdminRepo[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, HarnessAdminRepo[]>();
  for (const repo of repos) {
    if (needle && !repo.fullName.toLocaleLowerCase().includes(needle)) continue;
    const owner = ownerOf(repo.fullName);
    groups.set(owner, [...(groups.get(owner) ?? []), repo]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, entries]) => ({
      owner,
      repos: entries.sort(
        (left, right) =>
          Number(left.tracked) - Number(right.tracked) ||
          left.fullName.localeCompare(right.fullName),
      ),
    }));
}

export function RepoPicker({
  api,
  selected,
  disabled,
  onSelect,
  onOpenLink,
}: {
  api: HarnessAdminApi;
  selected: string | null;
  disabled?: boolean;
  onSelect: (repo: string) => void;
  onOpenLink?: (url: string) => boolean;
}) {
  const { t } = useTranslation("harness");
  const searchId = useId();
  const radioName = useId();
  const [list, setList] = useState<HarnessAdminRepoList | null>(null);
  const [error, setError] = useState<HarnessAdminApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await api.repos());
    } catch (cause) {
      setError(
        cause instanceof HarnessAdminApiError
          ? cause
          : new HarnessAdminApiError(String(cause), 0, "unavailable"),
      );
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupRepos(list?.repos ?? [], query), [list, query]);
  const installUrl = list?.installUrl ?? null;

  return (
    <section className="harness-card" aria-labelledby={`${searchId}-heading`}>
      <h2 id={`${searchId}-heading`}>{t("repos.heading")}</h2>
      <div className="harness-field">
        <label htmlFor={searchId} className="sr-only">
          {t("repos.search")}
        </label>
        <input
          id={searchId}
          type="search"
          className="harness-input"
          value={query}
          placeholder={t("repos.searchPlaceholder")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {loading && !list ? (
        <p className="harness-inline-status" role="status">
          <span className="harness-loader" />
          {t("repos.loading")}
        </p>
      ) : null}
      {error ? <ApiErrorNotice error={error} /> : null}
      {list && list.repos.length === 0 ? <p className="harness-hint">{t("repos.empty")}</p> : null}
      {list && list.repos.length > 0 && groups.length === 0 ? (
        <p className="harness-hint">{t("repos.noMatches")}</p>
      ) : null}

      {groups.length > 0 ? (
        <div className="harness-repo-scroll">
          {groups.map((group) => (
            <fieldset className="harness-repo-group" key={group.owner}>
              <legend>{group.owner}</legend>
              {group.repos.map((repo) => (
                <label className="harness-check" key={repo.fullName}>
                  <input
                    type="radio"
                    name={radioName}
                    value={repo.fullName}
                    checked={selected === repo.fullName}
                    disabled={disabled || repo.tracked}
                    aria-label={repo.fullName}
                    onChange={() => onSelect(repo.fullName)}
                  />
                  <span>
                    <strong>{nameOf(repo.fullName)}</strong>
                    <span className="harness-badges">
                      {repo.private ? (
                        <span className="harness-badge">
                          <LockKeyhole aria-hidden="true" width={11} height={11} />
                          {t("repos.private")}
                        </span>
                      ) : null}
                      {repo.tracked ? (
                        <span className="harness-badge is-accent">{t("repos.tracked")}</span>
                      ) : null}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      ) : null}

      <div className="harness-footer">
        <span className="harness-hint">{t("repos.missing")}</span>
        <div className="harness-actions">
          {installUrl ? (
            <a
              className="harness-button is-secondary"
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (onOpenLink?.(installUrl)) event.preventDefault();
              }}
            >
              <ExternalLink aria-hidden="true" />
              {t("repos.authorize")}
            </a>
          ) : null}
          <button
            type="button"
            className="harness-button is-secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
            {t("refresh")}
          </button>
        </div>
      </div>
    </section>
  );
}
