import { Toaster } from "@/components/ui/sonner";
import { lazy, Suspense } from "react";
import { BrowserRouter, useLocation } from "react-router";

const AdminPanelApp = lazy(() =>
  import("@/admin-panel-app").then((module) => ({ default: module.AdminPanelApp })),
);
const MiniAppApp = lazy(() =>
  import("@/mini-app/mini-app-app").then((module) => ({ default: module.MiniAppApp })),
);

function SurfaceRouter() {
  const { pathname } = useLocation();
  return pathname.startsWith("/mini-app/") ? <MiniAppApp /> : <AdminPanelApp />;
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense
        fallback={
          <div className="surface-loading" role="status" aria-label="Loading">
            <span />
          </div>
        }
      >
        <SurfaceRouter />
      </Suspense>
      <Toaster />
    </BrowserRouter>
  );
}
