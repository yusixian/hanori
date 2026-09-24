import { i18n, getResolvedLocale } from "@/i18n";
import {
  TELEGRAM_COMMAND_CATALOG,
  type HarnessAdminOverview,
  type MiniAppRole,
} from "@cos-tool-bot/shared";
import {
  BookOpenText,
  FolderGit2,
  Languages,
  ListTree,
  LockKeyhole,
  Settings2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { createMiniAppHarnessAdminApi } from "@/lib/harness-admin-client";
import { AccessPage } from "./access-page";
import { BotSettingsPage } from "./bot-settings-panel";
import { GroupsPage } from "./groups-page";
import { HarnessPage } from "./harness-page";
import { LogsPage } from "./logs-page";
import { bootstrapMiniAppSession, type MiniAppSessionState } from "./session";
import {
  createTelegramMiniAppAdapter,
  ensureTelegramMiniAppSdk,
  type TelegramMiniAppAdapter,
} from "./telegram-adapter";
import "./i18n";
import "./mini-app.css";

type MiniAppPage = "groups" | "settings" | "access" | "logs" | "harness" | "help";

const MINI_APP_PAGES: readonly MiniAppPage[] = [
  "groups",
  "settings",
  "access",
  "logs",
  "harness",
  "help",
];

function isMiniAppPage(value: string | null | undefined): value is MiniAppPage {
  return MINI_APP_PAGES.includes(value as MiniAppPage);
}

const NAVIGATION: Record<Exclude<MiniAppRole, "none">, readonly MiniAppPage[]> = {
  admin: ["groups", "settings", "access", "logs", "help"],
  operator: ["groups", "help"],
  viewer: ["groups", "help"],
};

/** Harness appears only after its overview succeeds; the server limits it to harness owners. */
export function navigationForRole(
  role: MiniAppRole | null,
  harness = false,
): readonly MiniAppPage[] {
  if (!role || role === "none") return ["help"];
  const pages = NAVIGATION[role];
  return harness ? [...pages.filter((page) => page !== "help"), "harness", "help"] : pages;
}

/** Telegram deep links (`startapp=<page>`) land on the configured entry URL, usually Help. */
export function readStartPage(initData: string, search: string): MiniAppPage | null {
  const param =
    new URLSearchParams(initData).get("start_param") ??
    new URLSearchParams(search).get("tgWebAppStartParam");
  return isMiniAppPage(param) ? param : null;
}

const NAV_ICONS = {
  groups: UsersRound,
  settings: Settings2,
  access: ShieldCheck,
  logs: ListTree,
  harness: FolderGit2,
  help: BookOpenText,
} satisfies Record<MiniAppPage, typeof BookOpenText>;

class MiniAppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Mini App surface failed", {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  override render() {
    return this.state.failed ? (
      <main className="mini-app-failure" role="alert">
        <LockKeyhole aria-hidden="true" />
        <h1>{i18n.t("miniApp:session.unavailableTitle")}</h1>
        <a
          href={window.location.pathname.replace(
            /\/(?:groups(?:\/-?\d+)?|settings|access|logs|harness(?:\/[^/]+)?)\/?$/,
            "/help",
          )}
        >
          {i18n.t("miniApp:session.openHelp")}
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}

function MiniAppLoading() {
  const { t } = useTranslation("miniApp");
  return (
    <div className="mini-app-session-state" role="status" aria-live="polite">
      <span className="mini-app-loader" />
      <p>{t("session.loading")}</p>
    </div>
  );
}

function LanguageButton() {
  const { t } = useTranslation("miniApp");
  const locale = getResolvedLocale();
  return (
    <button
      className="mini-app-language"
      type="button"
      aria-label={t("language")}
      onClick={() => void i18n.changeLanguage(locale === "zh-CN" ? "en" : "zh-CN")}
    >
      <Languages aria-hidden="true" />
      <span>{locale === "zh-CN" ? "EN" : "中"}</span>
    </button>
  );
}

function MiniAppNavigation({
  botId,
  role,
  harness,
}: {
  botId: string;
  role: MiniAppRole | null;
  harness: boolean;
}) {
  const { t } = useTranslation("miniApp");
  const { pathname } = useLocation();
  return (
    <nav className="mini-app-nav" aria-label="Mini App">
      {navigationForRole(role, harness).map((page) => {
        const Icon = NAV_ICONS[page];
        const href = `/mini-app/${botId}/${page}`;
        return (
          <Link
            key={page}
            to={href}
            aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{t(`nav.${page}`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function HelpPage() {
  const { t } = useTranslation("miniApp");
  const locale = getResolvedLocale();
  const commands = TELEGRAM_COMMAND_CATALOG.filter(
    ({ publicHelpVisibility }) => publicHelpVisibility === "public",
  );
  const commandGroups = commands.reduce(
    (groups, command) => {
      (groups[command.category] ??= []).push(command);
      return groups;
    },
    {} as Record<string, typeof commands>,
  );

  return (
    <main className="mini-app-content mini-app-help">
      <header className="mini-app-help-heading">
        <div className="mini-app-help-heading-copy">
          <p className="mini-app-kicker">{t("help.eyebrow")}</p>
          <h1>{t("help.title")}</h1>
          <p className="mini-app-lede">{t("help.intro")}</p>
        </div>
        <LanguageButton />
      </header>

      <section className="mini-app-command-section" aria-label={t("help.title")}>
        {Object.entries(commandGroups).map(([category, entries]) => (
          <div className="mini-app-command-group" key={category}>
            <h2>{t(`categories.${category}`)}</h2>
            <div className="mini-app-command-grid">
              {entries.map((entry) => (
                <article key={entry.command}>
                  <code aria-label={t("help.commandLabel", { command: entry.command })}>
                    /{entry.command}
                  </code>
                  <p>{entry.description[locale]}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <aside className="mini-app-help-notes">
        <article>
          <LockKeyhole aria-hidden="true" />
          <div>
            <h2>{t("help.privacyTitle")}</h2>
            <p>{t("help.privacyBody")}</p>
          </div>
        </article>
        <article>
          <BookOpenText aria-hidden="true" />
          <div>
            <h2>{t("help.projectTitle")}</h2>
            <p>{t("help.projectBody")}</p>
          </div>
        </article>
      </aside>
    </main>
  );
}

function SessionFailure({ state, botId }: { state: MiniAppSessionState; botId: string }) {
  const { t } = useTranslation("miniApp");
  const unavailable = state.status === "unavailable";
  return (
    <main className="mini-app-session-state" role="alert">
      <LockKeyhole aria-hidden="true" />
      <h1>{t(unavailable ? "session.unavailableTitle" : "session.expiredTitle")}</h1>
      <p>{t(unavailable ? "session.unavailableBody" : "session.expiredBody")}</p>
      <Link to={`/mini-app/${botId}/help`}>{t("session.openHelp")}</Link>
    </main>
  );
}

function PlaceholderPage({ page }: { page: Exclude<MiniAppPage, "help" | "logs" | "harness"> }) {
  const { t } = useTranslation("miniApp");
  const Icon = NAV_ICONS[page];
  return (
    <main className="mini-app-content mini-app-placeholder">
      <Icon aria-hidden="true" />
      <p>G{page === "groups" ? "3–4" : page === "access" ? "3" : "6"}</p>
      <h1>{t(`placeholder.${page}Title`)}</h1>
      <span>{t(`placeholder.${page}Body`)}</span>
    </main>
  );
}

function ProtectedPage({
  page,
  state,
  botId,
  harnessOverview,
}: {
  page: Exclude<MiniAppPage, "help">;
  state: MiniAppSessionState | null;
  botId: string;
  harnessOverview?: HarnessAdminOverview;
}) {
  if (!state) return <MiniAppLoading />;
  if (state.status !== "ready") return <SessionFailure state={state} botId={botId} />;
  if (state.session.role === "none") return <Navigate to={`/mini-app/${botId}/help`} replace />;
  if (
    (page === "settings" || page === "access" || page === "logs") &&
    state.session.role !== "admin"
  ) {
    return <Navigate to={`/mini-app/${botId}/groups`} replace />;
  }
  if (page === "groups") return <GroupsPage botId={botId} session={state.session} />;
  if (page === "access") return <AccessPage botId={botId} session={state.session} />;
  if (page === "logs") return <LogsPage botId={botId} />;
  if (page === "harness") {
    return <HarnessPage botId={botId} session={state.session} initialOverview={harnessOverview} />;
  }
  if (page === "settings") {
    return <BotSettingsPage botId={botId} session={state.session} />;
  }
  return <PlaceholderPage page={page} />;
}

function ConnectedMiniApp({ adapter }: { adapter: TelegramMiniAppAdapter }) {
  const { botId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const telegram = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getSnapshot,
  );
  const [sessionState, setSessionState] = useState<MiniAppSessionState | null>(null);
  const [harnessOverview, setHarnessOverview] = useState<HarnessAdminOverview | null>(null);
  const startPageHandled = useRef(false);
  const segments = location.pathname.split("/").filter(Boolean);
  const candidatePage = segments[2];
  const page: MiniAppPage = isMiniAppPage(candidatePage) ? candidatePage : "help";
  const detailView = (page === "groups" || page === "harness") && segments.length > 3;

  useEffect(() => {
    adapter.ready();
    adapter.expand();
  }, [adapter]);

  useEffect(() => {
    let active = true;
    void bootstrapMiniAppSession({ botId, initData: telegram.initData }).then((state) => {
      if (active) setSessionState(state);
    });
    return () => {
      active = false;
    };
  }, [botId, telegram.initData]);

  useEffect(() => {
    if (startPageHandled.current) return;
    const startPage = readStartPage(telegram.initData, window.location.search);
    if (!startPage) return;
    startPageHandled.current = true;
    if (page === "help" && startPage !== "help") {
      navigate(`/mini-app/${botId}/${startPage}`, { replace: true });
    }
  }, [botId, navigate, page, telegram.initData]);

  useEffect(() => {
    setHarnessOverview(null);
    if (sessionState?.status !== "ready" || sessionState.session.role === "none") return;
    let active = true;
    void createMiniAppHarnessAdminApi(botId, sessionState.session.csrfToken)
      .overview()
      .then(
        (overview) => {
          if (active) setHarnessOverview(overview);
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [botId, sessionState]);

  useEffect(() => {
    if (page === "help") return;
    return adapter.setBackButton(() =>
      navigate(`/mini-app/${botId}/${detailView ? page : "help"}`),
    );
  }, [adapter, botId, detailView, navigate, page]);

  useEffect(() => {
    if (sessionState?.status === "forbidden" && page !== "help") {
      navigate(`/mini-app/${botId}/help`, { replace: true });
    }
  }, [botId, navigate, page, sessionState]);

  const role = sessionState?.status === "ready" ? sessionState.session.role : null;
  return (
    <div className="mini-app-frame">
      <Routes>
        <Route path="help" element={<HelpPage />} />
        <Route
          path="groups"
          element={<ProtectedPage page="groups" state={sessionState} botId={botId} />}
        />
        <Route
          path="groups/:chatId"
          element={<ProtectedPage page="groups" state={sessionState} botId={botId} />}
        />
        <Route
          path="settings"
          element={<ProtectedPage page="settings" state={sessionState} botId={botId} />}
        />
        <Route
          path="access"
          element={<ProtectedPage page="access" state={sessionState} botId={botId} />}
        />
        <Route
          path="logs"
          element={<ProtectedPage page="logs" state={sessionState} botId={botId} />}
        />
        <Route
          path="harness/*"
          element={
            <ProtectedPage
              page="harness"
              state={sessionState}
              botId={botId}
              harnessOverview={harnessOverview ?? undefined}
            />
          }
        />
        <Route path="*" element={<Navigate to="help" replace />} />
      </Routes>
      <MiniAppNavigation botId={botId} role={role} harness={harnessOverview !== null} />
    </div>
  );
}

export function MiniAppApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<TelegramMiniAppAdapter | null>(null);
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const root = rootRef.current;
    setAdapter(createTelegramMiniAppAdapter(root));
    let active = true;
    void ensureTelegramMiniAppSdk().then(() => {
      if (active) setAdapter(createTelegramMiniAppAdapter(root));
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <MiniAppErrorBoundary>
      <div className="mini-app-root" ref={rootRef}>
        {adapter ? (
          <Routes>
            <Route path="/mini-app/:botId/*" element={<ConnectedMiniApp adapter={adapter} />} />
            <Route path="*" element={<MiniAppLoading />} />
          </Routes>
        ) : (
          <MiniAppLoading />
        )}
      </div>
    </MiniAppErrorBoundary>
  );
}
