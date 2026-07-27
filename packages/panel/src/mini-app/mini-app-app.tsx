import { i18n, getResolvedLocale } from "@/i18n";
import { TELEGRAM_COMMAND_CATALOG, type MiniAppRole } from "@cos-tool-bot/shared";
import {
  BookOpenText,
  ChevronRight,
  Languages,
  LockKeyhole,
  Settings2,
  ShieldCheck,
  TerminalSquare,
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
import { AccessPage } from "./access-page";
import { BotSettingsPage } from "./bot-settings-panel";
import { GroupsPage } from "./groups-page";
import { bootstrapMiniAppSession, type MiniAppSessionState } from "./session";
import { createTelegramMiniAppAdapter, type TelegramMiniAppAdapter } from "./telegram-adapter";
import "./i18n";
import "./mini-app.css";

type MiniAppPage = "groups" | "settings" | "access" | "help";

const NAVIGATION: Record<Exclude<MiniAppRole, "none">, readonly MiniAppPage[]> = {
  admin: ["groups", "settings", "access", "help"],
  operator: ["groups", "help"],
  viewer: ["groups", "help"],
};

export function navigationForRole(role: MiniAppRole | null): readonly MiniAppPage[] {
  return role && role !== "none" ? NAVIGATION[role] : ["help"];
}

const NAV_ICONS = {
  groups: UsersRound,
  settings: Settings2,
  access: ShieldCheck,
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
            /\/(?:groups(?:\/-?\d+)?|settings|access)\/?$/,
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

function MiniAppHeader({ role }: { role: MiniAppRole | null }) {
  const { t } = useTranslation("miniApp");
  return (
    <header className="mini-app-header">
      <div className="mini-app-wordmark">
        <span>{t("brand.eyebrow")}</span>
        <strong>{t("brand.name")}</strong>
      </div>
      <div className="mini-app-header-actions">
        {role && role !== "none" ? <span className="mini-app-role">{role}</span> : null}
        <LanguageButton />
      </div>
    </header>
  );
}

function MiniAppNavigation({ botId, role }: { botId: string; role: MiniAppRole | null }) {
  const { t } = useTranslation("miniApp");
  const { pathname } = useLocation();
  return (
    <nav className="mini-app-nav" aria-label="Mini App">
      {navigationForRole(role).map((page) => {
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
      <section className="mini-app-hero">
        <div className="mini-app-orbit" aria-hidden="true">
          <span />
          <span />
          <TerminalSquare />
        </div>
        <p className="mini-app-kicker">{t("help.eyebrow")}</p>
        <h1>{t("help.title")}</h1>
        <p className="mini-app-lede">{t("help.intro")}</p>
      </section>

      <section className="mini-app-principle">
        <LockKeyhole aria-hidden="true" />
        <div>
          <h2>{t("help.privacyTitle")}</h2>
          <p>{t("help.privacyBody")}</p>
        </div>
      </section>

      <section className="mini-app-command-section">
        <div className="mini-app-section-heading">
          <p>{t("help.commandsIntro")}</p>
          <h2>{t("help.commandsTitle")}</h2>
        </div>
        {Object.entries(commandGroups).map(([category, entries]) => (
          <div className="mini-app-command-group" key={category}>
            <h3>{t(`categories.${category}`)}</h3>
            <div className="mini-app-command-grid">
              {entries.map((entry) => (
                <article key={entry.command}>
                  <code aria-label={t("help.commandLabel", { command: entry.command })}>
                    /{entry.command}
                  </code>
                  <p>{entry.description[locale]}</p>
                  <ChevronRight aria-hidden="true" />
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="mini-app-project-note">
        <span aria-hidden="true">HGRM / 01</span>
        <h2>{t("help.projectTitle")}</h2>
        <p>{t("help.projectBody")}</p>
      </section>
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

function PlaceholderPage({ page }: { page: Exclude<MiniAppPage, "help"> }) {
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
}: {
  page: Exclude<MiniAppPage, "help">;
  state: MiniAppSessionState | null;
  botId: string;
}) {
  if (!state) return <MiniAppLoading />;
  if (state.status !== "ready") return <SessionFailure state={state} botId={botId} />;
  if (state.session.role === "none") return <Navigate to={`/mini-app/${botId}/help`} replace />;
  if ((page === "settings" || page === "access") && state.session.role !== "admin") {
    return <Navigate to={`/mini-app/${botId}/groups`} replace />;
  }
  if (page === "groups") return <GroupsPage botId={botId} session={state.session} />;
  if (page === "access") return <AccessPage botId={botId} session={state.session} />;
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
  const segments = location.pathname.split("/").filter(Boolean);
  const candidatePage = segments[2];
  const page: MiniAppPage =
    candidatePage === "groups" ||
    candidatePage === "settings" ||
    candidatePage === "access" ||
    candidatePage === "help"
      ? candidatePage
      : "help";
  const groupDetail = page === "groups" && segments.length > 3;

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
    if (page === "help") return;
    return adapter.setBackButton(() =>
      navigate(`/mini-app/${botId}/${groupDetail ? "groups" : "help"}`),
    );
  }, [adapter, botId, groupDetail, navigate, page]);

  useEffect(() => {
    if (sessionState?.status === "forbidden" && page !== "help") {
      navigate(`/mini-app/${botId}/help`, { replace: true });
    }
  }, [botId, navigate, page, sessionState]);

  const role = sessionState?.status === "ready" ? sessionState.session.role : null;
  return (
    <div className="mini-app-frame">
      <MiniAppHeader role={role} />
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
        <Route path="*" element={<Navigate to="help" replace />} />
      </Routes>
      <MiniAppNavigation botId={botId} role={role} />
    </div>
  );
}

export function MiniAppApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<TelegramMiniAppAdapter | null>(null);
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    setAdapter(createTelegramMiniAppAdapter(rootRef.current));
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
