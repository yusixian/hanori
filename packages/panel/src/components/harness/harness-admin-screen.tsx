import type { HarnessAdminOverview, HarnessAdminProject } from "@cos-tool-bot/shared";
import { AlertTriangle, ArrowLeft, Plus, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { HarnessAdminApiError, type HarnessAdminApi } from "@/lib/harness-admin-client";
import { AddProject } from "./add-project";
import { GlobalExecutionCard } from "./execution-settings";
import { ProjectDetail } from "./project-detail";
import { Notice } from "./project-fields";
import { ProjectList } from "./project-list";
import "./harness-admin.css";
import "./harness-form.css";
import "./i18n";

export type HarnessAdminSurface = "panel" | "mini-app";

interface ScreenProps {
  api: HarnessAdminApi;
  /** Absolute path the screen is mounted at, e.g. `/harness`. */
  basePath: string;
  surface: HarnessAdminSurface;
  /** Rendered immediately while the screen refetches the overview. */
  initialOverview?: HarnessAdminOverview;
  /** Returns true when the host opened the link itself (e.g. through Telegram). */
  onOpenLink?: (url: string) => boolean;
}

function StateBlock({
  icon,
  title,
  body,
  detail,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  detail?: string | null;
  action?: ReactNode;
}) {
  return (
    <section className="harness-card harness-state is-error" role="alert">
      {icon ?? <AlertTriangle aria-hidden="true" />}
      <h2>{title}</h2>
      <p>{body}</p>
      {detail ? <pre>{detail}</pre> : null}
      {action}
    </section>
  );
}

function SubHeader({ basePath, title }: { basePath: string; title: string }) {
  const { t } = useTranslation("harness");
  return (
    <header className="harness-header">
      <div>
        <Link className="harness-back" to={basePath}>
          <ArrowLeft aria-hidden="true" />
          {t("back")}
        </Link>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

function DetailRoute({
  overview,
  ...props
}: Omit<Parameters<typeof ProjectDetail>[0], "project" | "machines" | "execution"> & {
  overview: HarnessAdminOverview;
  basePath: string;
}) {
  const { t } = useTranslation("harness");
  const { key = "" } = useParams();
  const project = overview.projects.find((candidate) => candidate.key === key);
  return (
    <>
      <SubHeader
        basePath={props.basePath}
        title={project && !project.editable ? t("edit.viewTitle") : t("edit.title")}
      />
      {project ? (
        <ProjectDetail
          {...props}
          project={project}
          machines={overview.machines}
          execution={overview.execution}
        />
      ) : (
        <Notice kind="warning">{t("edit.notFound")}</Notice>
      )}
    </>
  );
}

export function HarnessAdminScreen({
  api,
  basePath,
  surface,
  initialOverview,
  onOpenLink,
}: ScreenProps) {
  const { t } = useTranslation("harness");
  const navigate = useNavigate();
  const [overview, setOverview] = useState<HarnessAdminOverview | null>(initialOverview ?? null);
  const [error, setError] = useState<HarnessAdminApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await api.overview());
      setError(null);
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

  const replaceProjects = (update: (projects: HarnessAdminProject[]) => HarnessAdminProject[]) =>
    setOverview((current) =>
      current ? { ...current, projects: update(current.projects) } : current,
    );

  const retry = (
    <button type="button" className="harness-button" disabled={loading} onClick={() => void load()}>
      <RefreshCw aria-hidden="true" />
      {t("retry")}
    </button>
  );

  let body: ReactNode;
  if (!overview && loading) {
    body = (
      <section className="harness-state" role="status" aria-live="polite">
        <span className="harness-loader" />
        <p>{t("loading")}</p>
      </section>
    );
  } else if (!overview) {
    const code = error?.code ?? "unavailable";
    body =
      code === "not_enabled" ? (
        <StateBlock
          icon={<Settings2 aria-hidden="true" />}
          title={t("state.notEnabledTitle")}
          body={t("state.notEnabledBody")}
          action={retry}
        />
      ) : code === "forbidden" ? (
        <StateBlock title={t("state.forbiddenTitle")} body={t("state.forbiddenBody")} />
      ) : (
        <StateBlock
          title={t("state.unavailableTitle")}
          body={t("state.unavailableBody")}
          action={retry}
        />
      );
  } else if (overview.configError) {
    body = (
      <StateBlock
        title={t("state.configErrorTitle")}
        body={t("state.configErrorBody")}
        detail={overview.configError}
        action={retry}
      />
    );
  } else if (!overview.enabled) {
    body = (
      <StateBlock
        icon={<Settings2 aria-hidden="true" />}
        title={t("state.notEnabledTitle")}
        body={t("state.notEnabledBody")}
        action={retry}
      />
    );
  }

  const ready = body === undefined && overview !== null;
  return (
    <div className="harness-admin" data-surface={surface}>
      <Routes>
        <Route
          index
          element={
            <>
              <header className="harness-header">
                <div>
                  <h1>{t("title")}</h1>
                  <p>
                    {ready
                      ? `${t("list.count", { count: overview.projects.length })} · ${t("intro")}`
                      : t("intro")}
                  </p>
                </div>
                {ready ? (
                  <div className="harness-actions">
                    <button
                      type="button"
                      className="harness-button is-secondary"
                      disabled={loading}
                      onClick={() => void load()}
                    >
                      <RefreshCw aria-hidden="true" />
                      {t("refresh")}
                    </button>
                    <Link
                      className="harness-button"
                      to={`${basePath}/new`}
                      onClick={() => setNotice(null)}
                    >
                      <Plus aria-hidden="true" />
                      {t("addProject")}
                    </Link>
                  </div>
                ) : null}
              </header>
              {notice ? <Notice kind="success">{notice}</Notice> : null}
              {error && overview ? <Notice kind="error">{t(`errors.${error.code}`)}</Notice> : null}
              {ready && overview.warnings?.length ? (
                <Notice kind="warning">
                  <strong>{t("list.warnings")}</strong>
                  <ul>
                    {overview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              {ready ? (
                <>
                  <GlobalExecutionCard
                    api={api}
                    view={overview.execution}
                    onSaved={(execution) => {
                      setOverview((current) => (current ? { ...current, execution } : current));
                      void load();
                    }}
                  />
                  <ProjectList
                    projects={overview.projects}
                    machines={overview.machines}
                    agents={overview.execution.agents}
                    basePath={basePath}
                    onOpenLink={onOpenLink}
                  />
                </>
              ) : (
                body
              )}
            </>
          }
        />
        <Route
          path="new"
          element={
            <>
              <SubHeader basePath={basePath} title={t("add.title")} />
              {ready ? (
                <AddProject
                  api={api}
                  machines={overview.machines}
                  onOpenLink={onOpenLink}
                  onCreated={(project) => {
                    replaceProjects((projects) => [
                      ...projects.filter((candidate) => candidate.key !== project.key),
                      project,
                    ]);
                    setNotice(t("notices.created", { key: project.key }));
                    navigate(basePath);
                    void load();
                  }}
                />
              ) : (
                body
              )}
            </>
          }
        />
        <Route
          path=":key"
          element={
            ready ? (
              <DetailRoute
                api={api}
                basePath={basePath}
                overview={overview}
                onOpenLink={onOpenLink}
                onSaved={(project) =>
                  replaceProjects((projects) =>
                    projects.map((candidate) =>
                      candidate.key === project.key ? project : candidate,
                    ),
                  )
                }
                onDeleted={(key) => {
                  replaceProjects((projects) => projects.filter((project) => project.key !== key));
                  setNotice(t("notices.deleted", { key }));
                  navigate(basePath);
                }}
              />
            ) : (
              <>
                <SubHeader basePath={basePath} title={t("edit.title")} />
                {body}
              </>
            )
          }
        />
        <Route path="*" element={<Navigate to={basePath} replace />} />
      </Routes>
    </div>
  );
}
