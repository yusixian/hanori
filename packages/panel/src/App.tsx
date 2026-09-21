import { Toaster } from "@/components/ui/sonner";
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { createBrowserRouter, RouterProvider, useLocation } from "react-router";

const AdminPanelApp = lazy(() =>
  import("@/admin-panel-app").then((module) => ({ default: module.AdminPanelApp })),
);
const MiniAppApp = lazy(() =>
  import("@/mini-app/mini-app-app").then((module) => ({ default: module.MiniAppApp })),
);

interface SurfaceChunkErrorBoundaryProps {
  children: ReactNode;
  miniApp: boolean;
}

class SurfaceChunkErrorBoundary extends Component<
  SurfaceChunkErrorBoundaryProps,
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Panel surface failed to load", {
      error: error instanceof Error ? error.name : "UnknownError",
      surface: this.props.miniApp ? "mini-app" : "admin",
      componentStack: info.componentStack,
    });
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main
        className={`surface-failure${this.props.miniApp ? " surface-failure--mini-app" : ""}`}
        role="alert"
      >
        <p className="surface-failure__eyebrow">cos-tool-bot</p>
        <h1>{this.props.miniApp ? "Mini App 无法加载" : "管理面板无法加载"}</h1>
        <p>请检查网络后重新载入页面。</p>
        <button type="button" onClick={() => globalThis.location.reload()}>
          重新载入
        </button>
      </main>
    );
  }
}

function SurfaceRouter() {
  const { pathname } = useLocation();
  const miniApp = pathname.startsWith("/mini-app/");

  return (
    <SurfaceChunkErrorBoundary key={miniApp ? "mini-app" : "admin"} miniApp={miniApp}>
      {miniApp ? <MiniAppApp /> : <AdminPanelApp />}
    </SurfaceChunkErrorBoundary>
  );
}

function AppRoot() {
  return (
    <>
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
    </>
  );
}

const appRouter = createBrowserRouter([{ path: "*", element: <AppRoot /> }]);

export function App() {
  return <RouterProvider router={appRouter} />;
}
