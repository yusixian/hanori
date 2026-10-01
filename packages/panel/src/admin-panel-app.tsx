import { ErrorBoundary } from "@/components/error-boundary";
import { LanguageSwitcher } from "@/components/language-switcher";
import { AppLayout } from "@/components/layout/app-layout";
import { authProvider } from "@/providers/auth-provider";
import { dataProvider } from "@/providers/data-provider";
import { Authenticated, Refine } from "@refinedev/core";
import routerProvider, { CatchAllNavigate, NavigateToResource } from "@refinedev/react-router";
import { lazy, Suspense } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router";
import { useTranslation } from "react-i18next";

const LoginPage = lazy(() => import("@/pages/login").then((m) => ({ default: m.LoginPage })));
const BackupPage = lazy(() => import("@/pages/backup").then((m) => ({ default: m.BackupPage })));
const BotListPage = lazy(() =>
  import("@/pages/bots/list").then((m) => ({ default: m.BotListPage })),
);
const BotCreatePage = lazy(() =>
  import("@/pages/bots/create").then((m) => ({ default: m.BotCreatePage })),
);
const BotEditPage = lazy(() =>
  import("@/pages/bots/edit").then((m) => ({ default: m.BotEditPage })),
);
const BotDashboardPage = lazy(() =>
  import("@/pages/bots/dashboard").then((m) => ({ default: m.BotDashboardPage })),
);
const BotAiSettingsPage = lazy(() =>
  import("@/pages/bots/ai-settings").then((m) => ({ default: m.BotAiSettingsPage })),
);
const BotGovernancePage = lazy(() =>
  import("@/pages/bots/governance").then((m) => ({ default: m.BotGovernancePage })),
);
const BotSkillsPage = lazy(() =>
  import("@/pages/bots/skills").then((m) => ({ default: m.BotSkillsPage })),
);
const BotConversationsPage = lazy(() =>
  import("@/pages/bots/conversations").then((m) => ({ default: m.BotConversationsPage })),
);
const BotProfilesPage = lazy(() =>
  import("@/pages/bots/profiles").then((m) => ({ default: m.BotProfilesPage })),
);
const BotGenerationLibraryPage = lazy(() =>
  import("@/pages/bots/generation-library").then((m) => ({
    default: m.BotGenerationLibraryPage,
  })),
);
const BotMemoriesPage = lazy(() =>
  import("@/pages/bots/memories").then((m) => ({ default: m.BotMemoriesPage })),
);
const BotExportPage = lazy(() =>
  import("@/pages/bots/data-transfer").then((m) => ({ default: m.BotExportPage })),
);
const BotGenerationsPage = lazy(() =>
  import("@/pages/bots/generations").then((m) => ({ default: m.BotGenerationsPage })),
);
const BotGenerationDetailPage = lazy(() =>
  import("@/pages/bots/generation-detail").then((m) => ({
    default: m.BotGenerationDetailPage,
  })),
);
const BotFilesPage = lazy(() =>
  import("@/pages/bots/files").then((m) => ({ default: m.BotFilesPage })),
);
const DataPage = lazy(() => import("@/pages/data").then((m) => ({ default: m.DataPage })));
const ApiTestPage = lazy(() =>
  import("@/pages/api-test").then((m) => ({ default: m.ApiTestPage })),
);
const BotLogsPage = lazy(() =>
  import("@/pages/bots/logs").then((m) => ({ default: m.BotLogsPage })),
);
const LogsListPage = lazy(() =>
  import("@/pages/logs/list").then((m) => ({ default: m.LogsListPage })),
);
const UsagePage = lazy(() => import("@/pages/usage").then((m) => ({ default: m.UsagePage })));
const TimersListPage = lazy(() =>
  import("@/pages/timers/list").then((m) => ({ default: m.TimersListPage })),
);
const BotRssPage = lazy(() => import("@/pages/bots/rss").then((m) => ({ default: m.BotRssPage })));
const BotSummaryPage = lazy(() =>
  import("@/pages/bots/summary").then((m) => ({ default: m.BotSummaryPage })),
);
const BotDebuggerPage = lazy(() =>
  import("@/pages/bots/debugger").then((m) => ({ default: m.BotDebuggerPage })),
);
const McpServersPage = lazy(() =>
  import("@/pages/mcp-servers").then((m) => ({ default: m.McpServersPage })),
);
const LarkSetupGuidePage = lazy(() =>
  import("@/pages/guides/lark-setup").then((m) => ({ default: m.LarkSetupGuidePage })),
);
const HarnessPage = lazy(() => import("@/pages/harness").then((m) => ({ default: m.HarnessPage })));
const SettingsPage = lazy(() =>
  import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
);
const AcceptInvitationPage = lazy(() =>
  import("@/pages/accept-invitation").then((m) => ({ default: m.AcceptInvitationPage })),
);
const ResetPasswordPage = lazy(() =>
  import("@/pages/reset-password").then((m) => ({ default: m.ResetPasswordPage })),
);

function LoadingFallback() {
  const { t } = useTranslation("common");
  return (
    <div className="flex items-center justify-center py-20" role="status" aria-live="polite">
      <div className="text-muted-foreground flex items-center gap-3 text-sm">
        <span className="border-t-primary border-border size-4 animate-spin rounded-full border-2" />
        {t("common.loading")}
      </div>
    </div>
  );
}

function PublicLanguageSwitcher() {
  const { pathname } = useLocation();
  const normalizedPathname = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const isPublicAuthPage =
    normalizedPathname === "/accept-invitation" || normalizedPathname === "/reset-password";
  return isPublicAuthPage ? <LanguageSwitcher className="fixed top-4 right-4 z-[70]" /> : null;
}

export function AdminPanelApp() {
  return (
    <ErrorBoundary>
      <PublicLanguageSwitcher />
      <Refine
        routerProvider={routerProvider}
        authProvider={authProvider}
        dataProvider={dataProvider}
        resources={[
          { name: "bots", list: "/" },
          { name: "logs", list: "/logs" },
        ]}
        options={{ disableTelemetry: true }}
      >
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route
              element={
                <Authenticated key="auth" fallback={<CatchAllNavigate to="/login" />}>
                  <AppLayout />
                </Authenticated>
              }
            >
              <Route index element={<BotListPage />} />
              <Route path="/bots/new" element={<BotCreatePage />} />
              <Route path="/bots/:botId" element={<BotDashboardPage />} />
              <Route path="/bots/:botId/edit" element={<BotEditPage />} />
              <Route path="/bots/:botId/ai" element={<BotAiSettingsPage />} />
              <Route path="/bots/:botId/governance" element={<BotGovernancePage />} />
              <Route path="/bots/:botId/skills" element={<BotSkillsPage />} />
              <Route path="/bots/:botId/conversations" element={<BotConversationsPage />} />
              <Route path="/bots/:botId/profiles" element={<BotProfilesPage />} />
              <Route
                path="/bots/:botId/generation-library"
                element={<BotGenerationLibraryPage />}
              />
              <Route path="/bots/:botId/memories" element={<BotMemoriesPage />} />
              <Route path="/bots/:botId/generations" element={<BotGenerationsPage />} />
              <Route
                path="/bots/:botId/generations/:source/:generationId"
                element={<BotGenerationDetailPage />}
              />
              <Route path="/bots/:botId/files" element={<BotFilesPage />} />
              <Route path="/bots/:botId/rss" element={<BotRssPage />} />
              <Route path="/bots/:botId/summary" element={<BotSummaryPage />} />
              <Route path="/bots/:botId/export" element={<BotExportPage />} />
              <Route path="/bots/:botId/logs" element={<BotLogsPage />} />
              <Route path="/bots/:botId/debugger" element={<BotDebuggerPage />} />
              <Route path="/data" element={<DataPage />} />
              <Route path="/backup" element={<BackupPage />} />
              <Route path="/api-test" element={<ApiTestPage />} />
              <Route path="/usage" element={<UsagePage />} />
              <Route path="/timers" element={<TimersListPage />} />
              <Route path="/logs" element={<LogsListPage />} />
              <Route path="/mcp-servers" element={<McpServersPage />} />
              <Route path="/harness/*" element={<HarnessPage />} />
              <Route path="/guides/lark-setup" element={<LarkSetupGuidePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route
              element={
                <Authenticated key="auth-login" fallback={<Outlet />}>
                  <NavigateToResource resource="bots" />
                </Authenticated>
              }
            >
              <Route path="/login" element={<LoginPage />} />
            </Route>
            <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
          </Routes>
        </Suspense>
      </Refine>
    </ErrorBoundary>
  );
}
