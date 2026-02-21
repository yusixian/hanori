import { Refine, Authenticated } from "@refinedev/core";
import routerProvider, { NavigateToResource } from "@refinedev/react-router";
import { BrowserRouter, Routes, Route, Outlet } from "react-router";
import { authProvider } from "@/providers/auth-provider";
import { dataProvider } from "@/providers/data-provider";
import { AppLayout } from "@/components/layout/app-layout";
import { LoginPage } from "@/pages/login";
import { BotListPage } from "@/pages/bots/list";
import { BotCreatePage } from "@/pages/bots/create";
import { BotEditPage } from "@/pages/bots/edit";
import { BotDashboardPage } from "@/pages/bots/dashboard";
import { LogsListPage } from "@/pages/logs/list";

export function App() {
  return (
    <BrowserRouter>
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
        <Routes>
          <Route
            element={
              <Authenticated key="auth" fallback={<Outlet />}>
                <AppLayout />
              </Authenticated>
            }
          >
            <Route index element={<BotListPage />} />
            <Route path="/bots/new" element={<BotCreatePage />} />
            <Route path="/bots/:botId" element={<BotDashboardPage />} />
            <Route path="/bots/:botId/edit" element={<BotEditPage />} />
            <Route path="/logs" element={<LogsListPage />} />
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
        </Routes>
      </Refine>
    </BrowserRouter>
  );
}
