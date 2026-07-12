import { sidebarCollapsedAtom, sidebarOpenAtom } from "@/atoms/sidebar";
import { cn } from "@/lib/utils";
import { useLogout } from "@refinedev/core";
import { useAtom } from "jotai";
import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  Bug,
  Database,
  Download,
  FlaskConical,
  FolderOpen,
  ImageIcon,
  HardDrive,
  Timer,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plug,
  Rss,
  ScrollText,
  Settings,
  Users,
  FileText,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button";
import { LanguageSwitcher } from "@/components/language-switcher";

const globalNavItems = [
  { labelKey: "navigation.bots", path: "/", icon: Bot },
  { labelKey: "navigation.usage", path: "/usage", icon: BarChart3 },
  { labelKey: "navigation.data", path: "/data", icon: Database },
  { labelKey: "navigation.backup", path: "/backup", icon: HardDrive },
  { labelKey: "navigation.timers", path: "/timers", icon: Timer },
  { labelKey: "navigation.mcp", path: "/mcp-servers", icon: Plug },
  { labelKey: "navigation.apiTest", path: "/api-test", icon: FlaskConical },
  { labelKey: "navigation.logs", path: "/logs", icon: ScrollText },
] as const;

function isNavActive(itemPath: string, pathname: string) {
  if (itemPath === "/") return pathname === "/" || pathname.startsWith("/bots");
  return pathname.startsWith(itemPath);
}

export function AppLayout() {
  const { t } = useTranslation("common");
  const location = useLocation();
  const { mutate: logout } = useLogout();
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);

  // Close sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);

  // Close sidebar on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setSidebarOpen]);

  // Detect bot context from URL
  const botIdMatch = location.pathname.match(/^\/bots\/([^/]+)/);
  const botId = botIdMatch?.[1];
  const isBotContext = botId != null && botId !== "new";

  const botNavItems = botId
    ? [
        { label: t("navigation.overview"), path: `/bots/${botId}`, icon: Bot },
        { label: t("navigation.edit"), path: `/bots/${botId}/edit`, icon: Pencil },
        { label: t("navigation.aiSettings"), path: `/bots/${botId}/ai`, icon: Brain },
        { label: t("navigation.debugger"), path: `/bots/${botId}/debugger`, icon: Bug },
        {
          label: t("navigation.conversations"),
          path: `/bots/${botId}/conversations`,
          icon: MessageSquare,
        },
        { label: t("navigation.profiles"), path: `/bots/${botId}/profiles`, icon: Users },
        { label: t("navigation.memories"), path: `/bots/${botId}/memories`, icon: BookOpen },
        { label: t("navigation.rss"), path: `/bots/${botId}/rss`, icon: Rss },
        { label: t("navigation.chatSummary"), path: `/bots/${botId}/summary`, icon: FileText },
        {
          label: t("navigation.generations"),
          path: `/bots/${botId}/generations`,
          icon: ImageIcon,
        },
        { label: t("navigation.files"), path: `/bots/${botId}/files`, icon: FolderOpen },
        { label: t("navigation.export"), path: `/bots/${botId}/export`, icon: Download },
        { label: t("navigation.logs"), path: `/bots/${botId}/logs`, icon: ScrollText },
      ]
    : [];

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {t("navigation.skipToContent")}
      </a>
      {/* Mobile top bar */}
      <header className="z-30 flex min-h-14 items-center gap-3 border-b border-slate-200/80 bg-white/85 px-3 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1 backdrop-blur-xl md:hidden">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          aria-label={t("navigation.openMenu")}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div className="bg-primary flex size-8 items-center justify-center rounded-xl text-white shadow-[0_6px_14px_rgb(37_99_235/0.24)]">
          <Bot className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">{t("app.name")}</span>
      </header>

      {/* Overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[min(82vw,19rem)] flex-col overflow-hidden border-r border-slate-200/80 bg-white/92 shadow-[14px_0_40px_rgb(15_23_42/0.1)] backdrop-blur-xl transition-[width,transform] duration-200 ease-out md:static md:z-auto md:translate-x-0 md:w-[248px] md:shadow-[8px_0_28px_rgb(15_23_42/0.025)]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "md:w-[76px]" : "md:w-[248px]",
        )}
      >
        {/* Header */}
        <div className="flex h-[80px] items-center justify-between border-b border-slate-200/80 px-4">
          {collapsed ? (
            <Button
              variant="ghost"
              size="sm"
              className="mx-auto hidden md:flex"
              onClick={() => setCollapsed(false)}
              title={t("navigation.expandSidebar")}
              aria-label={t("navigation.expandSidebar")}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="bg-primary flex size-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm">
                  <Bot className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0">
                  <span className="block text-sm font-semibold tracking-tight whitespace-nowrap">
                    {t("app.name")}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {t("app.subtitle")}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="hidden shrink-0 md:flex"
                onClick={() => setCollapsed(true)}
                title={t("navigation.collapseSidebar")}
                aria-label={t("navigation.collapseSidebar")}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </>
          )}
          {/* Mobile close - always visible on mobile */}
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label={t("navigation.closeMenu")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-5">
          {isBotContext ? (
            <>
              <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase">
                {t("navigation.botWorkspace")}
              </p>
              <Link
                to="/"
                title={t("navigation.backToBots")}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-[background-color,color] hover:bg-slate-100 hover:text-foreground",
                  collapsed && "md:justify-center",
                )}
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "md:hidden")}>{t("navigation.backToBots")}</span>
              </Link>
              <div className="mx-3 my-2 border-t" />
              {botNavItems.map((item) => {
                const active =
                  item.path === `/bots/${botId}`
                    ? location.pathname === `/bots/${botId}`
                    : location.pathname.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    className={cn(
                      "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-[background-color,color,box-shadow]",
                      active
                        ? "bg-accent text-accent-foreground shadow-[inset_0_0_0_1px_rgb(37_99_235/0.06)]"
                        : "text-muted-foreground hover:bg-slate-100 hover:text-foreground",
                      collapsed && "md:justify-center",
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className={cn(collapsed && "md:hidden")}>{item.label}</span>
                  </Link>
                );
              })}
            </>
          ) : (
            <>
              <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-slate-400 uppercase">
                {t("navigation.workspace")}
              </p>
              {globalNavItems.map((item) => {
                const label = t(item.labelKey);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={label}
                    className={cn(
                      "group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-[background-color,color,box-shadow]",
                      isNavActive(item.path, location.pathname)
                        ? "bg-accent text-accent-foreground shadow-[inset_0_0_0_1px_rgb(37_99_235/0.08)]"
                        : "text-muted-foreground hover:bg-slate-100 hover:text-foreground",
                      collapsed && "md:justify-center",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg transition-[background-color,color]",
                        isNavActive(item.path, location.pathname)
                          ? "bg-white text-primary shadow-sm"
                          : "bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-slate-700",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className={cn(collapsed && "md:hidden")}>{label}</span>
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        <div className="border-t border-slate-200/80 bg-slate-50/60 p-3">
          <LanguageSwitcher
            className={cn("mb-2 block", collapsed && "md:hidden")}
            selectClassName="w-full"
          />
          <Link
            to="/settings"
            title={t("navigation.settings")}
            className={cn(
              "mb-1 flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-[background-color,color] hover:bg-slate-100 hover:text-foreground",
              collapsed && "md:justify-center",
              isNavActive("/settings", location.pathname) && "bg-accent text-accent-foreground",
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "md:hidden")}>{t("navigation.settings")}</span>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className={cn("w-full", collapsed ? "md:justify-center" : "justify-start")}
            onClick={() => logout()}
            title={t("navigation.logout")}
            aria-label={t("navigation.logout")}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "md:hidden")}>{t("navigation.logout")}</span>
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main id="main-content" className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full max-w-[1480px] p-4 sm:p-6 lg:p-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
