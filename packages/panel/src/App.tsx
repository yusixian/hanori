import { Refine, Authenticated } from "@refinedev/core";
import routerProvider, { NavigateToResource } from "@refinedev/react-router";
import { BrowserRouter, Routes, Route, Outlet } from "react-router";
import { authProvider } from "@/providers/auth-provider";
import { dataProvider } from "@/providers/data-provider";
import { AppLayout } from "@/components/layout/app-layout";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { LogsListPage } from "@/pages/logs/list";

export function App() {
  return (
    <BrowserRouter>
      <Refine
        routerProvider={routerProvider}
        authProvider={authProvider}
        dataProvider={dataProvider}
        resources={[
          { name: "dashboard", list: "/" },
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
            <Route index element={<DashboardPage />} />
            <Route path="/logs" element={<LogsListPage />} />
          </Route>

          <Route
            element={
              <Authenticated key="auth-login" fallback={<Outlet />}>
                <NavigateToResource resource="dashboard" />
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
