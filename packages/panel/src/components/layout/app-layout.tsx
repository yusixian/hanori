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
  Rss,
  ScrollText,
  Users,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button";

const globalNavItems = [
  { label: "Bots", path: "/", icon: Bot },
  { label: "Usage", path: "/usage", icon: BarChart3 },
  { label: "Data", path: "/data", icon: Database },
  { label: "Backup", path: "/backup", icon: HardDrive },
  { label: "Timers", path: "/timers", icon: Timer },
  { label: "API Test", path: "/api-test", icon: FlaskConical },
  { label: "Logs", path: "/logs", icon: ScrollText },
];

function isNavActive(itemPath: string, pathname: string) {
  if (itemPath === "/") return pathname === "/" || pathname.startsWith("/bots");
  return pathname.startsWith(itemPath);
}

export function AppLayout() {
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
        { label: "Overview", path: `/bots/${botId}`, icon: Bot },
        { label: "Edit", path: `/bots/${botId}/edit`, icon: Pencil },
        { label: "AI Settings", path: `/bots/${botId}/ai`, icon: Brain },
        { label: "Conversations", path: `/bots/${botId}/conversations`, icon: MessageSquare },
        { label: "Profiles", path: `/bots/${botId}/profiles`, icon: Users },
        { label: "Memories", path: `/bots/${botId}/memories`, icon: BookOpen },
        { label: "RSS", path: `/bots/${botId}/rss`, icon: Rss },
        { label: "Generations", path: `/bots/${botId}/generations`, icon: ImageIcon },
        { label: "Files", path: `/bots/${botId}/files`, icon: FolderOpen },
        { label: "Export", path: `/bots/${botId}/export`, icon: Download },
        { label: "Logs", path: `/bots/${botId}/logs`, icon: ScrollText },
      ]
    : [];

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Mobile top bar */}
      <header className="bg-card z-30 flex items-center gap-2 border-b px-3 py-2 md:hidden">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          aria-label="打开菜单"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <Bot className="text-primary h-5 w-5" />
        <span className="text-sm font-semibold">cos-tool-bot</span>
      </header>

      {/* Overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "bg-card fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-hidden border-r transition-all duration-200 ease-in-out md:static md:z-auto md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "md:w-14" : "md:w-56",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-4">
          {collapsed ? (
            <Button
              variant="ghost"
              size="sm"
              className="mx-auto hidden md:flex"
              onClick={() => setCollapsed(false)}
              title="Expand sidebar"
              aria-label="展开侧栏"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Bot className="text-primary h-6 w-6 shrink-0" />
                <span className="text-sm font-semibold whitespace-nowrap">cos-tool-bot</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="hidden shrink-0 md:flex"
                onClick={() => setCollapsed(true)}
                title="Collapse sidebar"
                aria-label="收起侧栏"
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
            aria-label="关闭菜单"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {isBotContext ? (
            <>
              <Link
                to="/"
                title="Back to Bots"
                className={cn(
                  "text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  collapsed && "md:justify-center",
                )}
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "md:hidden")}>Back to Bots</span>
              </Link>
              <div className="mx-3 my-1 border-t" />
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
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                      collapsed && "md:justify-center",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className={cn(collapsed && "md:hidden")}>{item.label}</span>
                  </Link>
                );
              })}
            </>
          ) : (
            globalNavItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                title={item.label}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isNavActive(item.path, location.pathname)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                  collapsed && "md:justify-center",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "md:hidden")}>{item.label}</span>
              </Link>
            ))
          )}
        </nav>

        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn("w-full", collapsed ? "md:justify-center" : "justify-start")}
            onClick={() => logout()}
            title="Logout"
            aria-label="退出登录"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "md:hidden")}>Logout</span>
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1 overflow-auto p-3 sm:p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
