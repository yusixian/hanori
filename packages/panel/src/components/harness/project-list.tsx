import type {
  HarnessAdminAgentOption,
  HarnessAdminMachine,
  HarnessAdminProject,
} from "@cos-tool-bot/shared";
import { ExternalLink, FolderGit2, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatExecution } from "./execution-draft";
import { MachineStatus, Notice } from "./project-fields";
import "./i18n";

export function ProjectOverview({
  project,
  machines,
  agents,
  action,
  onOpenLink,
}: {
  project: HarnessAdminProject;
  machines: readonly HarnessAdminMachine[];
  agents: readonly HarnessAdminAgentOption[] | null;
  action?: ReactNode;
  onOpenLink?: (url: string) => boolean;
}) {
  const { t } = useTranslation("harness");
  const byKey = new Map(machines.map((machine) => [machine.key, machine]));
  const topicUrl = project.topic.url;
  return (
    <article className="harness-card" aria-labelledby={`harness-project-${project.key}`}>
      <div className="harness-project-head">
        <div>
          <h2 id={`harness-project-${project.key}`}>{project.key}</h2>
          <span className="harness-mono">{project.repo}</span>
        </div>
        {action}
      </div>
      <div className="harness-badges">
        <span className={project.source === "panel" ? "harness-badge is-accent" : "harness-badge"}>
          {t(`source.${project.source}`)}
        </span>
      </div>
      <dl className="harness-meta">
        <div>
          <dt>{t("list.machines")}</dt>
          <dd>
            {project.machines.length === 0
              ? t("list.noMachines")
              : project.machines.map((key) => (
                  <span className="harness-badge" key={key}>
                    {key}
                    <MachineStatus online={byKey.get(key)?.online ?? null} />
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt>{t("list.topic")}</dt>
          <dd>
            {topicUrl ? (
              <a
                href={topicUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (onOpenLink?.(topicUrl)) event.preventDefault();
                }}
              >
                {t("list.openTopic")}
                <ExternalLink aria-hidden="true" width={12} height={12} />
              </a>
            ) : (
              t("list.noTopic")
            )}
          </dd>
        </div>
        <div>
          <dt>{t("list.policy")}</dt>
          <dd>
            <span className="harness-badge">{t(`policySource.${project.policy.source}`)}</span>
            <span className="harness-badge">{t(`kind.${project.policy.kind}`)}</span>
          </dd>
        </div>
        <div>
          <dt>{t("list.model")}</dt>
          <dd>
            <span>
              {formatExecution(project.execution.effective, agents) ?? t("execution.default")}
            </span>
            {project.execution.panel ? (
              <span className="harness-badge is-accent">{t("execution.fromPanel")}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t("list.quickVerify")}</dt>
          <dd>
            {project.policy.verify.quick ? (
              <code>{project.policy.verify.quick}</code>
            ) : (
              t("list.noVerify")
            )}
          </dd>
        </div>
      </dl>
      {project.topic.error ? (
        <Notice kind="warning">{t("list.topicError", { error: project.topic.error })}</Notice>
      ) : null}
      {project.policy.error ? (
        <Notice kind="warning">{t("list.policyError", { error: project.policy.error })}</Notice>
      ) : null}
    </article>
  );
}

export function ProjectList({
  projects,
  machines,
  agents,
  basePath,
  onOpenLink,
}: {
  projects: readonly HarnessAdminProject[];
  machines: readonly HarnessAdminMachine[];
  agents: readonly HarnessAdminAgentOption[] | null;
  basePath: string;
  onOpenLink?: (url: string) => boolean;
}) {
  const { t } = useTranslation("harness");
  if (projects.length === 0) {
    return (
      <section className="harness-card harness-state">
        <FolderGit2 aria-hidden="true" />
        <h2>{t("list.emptyTitle")}</h2>
        <p>{t("list.emptyBody")}</p>
        <Link className="harness-button" to={`${basePath}/new`}>
          <Plus aria-hidden="true" />
          {t("addProject")}
        </Link>
      </section>
    );
  }
  return (
    <div className="harness-project-list">
      {projects.map((project) => (
        <ProjectOverview
          key={project.key}
          project={project}
          machines={machines}
          agents={agents}
          onOpenLink={onOpenLink}
          action={
            <Link
              className="harness-button is-secondary"
              to={`${basePath}/${encodeURIComponent(project.key)}`}
              aria-label={`${t(project.editable ? "list.edit" : "list.view")} ${project.key}`}
            >
              {t(project.editable ? "list.edit" : "list.view")}
            </Link>
          }
        />
      ))}
    </div>
  );
}
