import { cn } from "@/lib/utils";
import { useLogout } from "@refinedev/core";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Brain,
  LogOut,
  MessageSquare,
  Pencil,
  ScrollText,
  Users,
} from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button";

const globalNavItems = [
  { label: "Bots", path: "/", icon: Bot },
  { label: "Logs", path: "/logs", icon: ScrollText },
];

function isNavActive(itemPath: string, pathname: string) {
  if (itemPath === "/") return pathname === "/" || pathname.startsWith("/bots");
  return pathname.startsWith(itemPath);
}

export function AppLayout() {
  const location = useLocation();
  const { mutate: logout } = useLogout();

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
        { label: "Logs", path: `/bots/${botId}/logs`, icon: ScrollText },
      ]
    : [];

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="bg-card flex w-56 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <Bot className="text-primary h-6 w-6" />
          <span className="text-sm font-semibold">cos-tool-bot</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {isBotContext ? (
            <>
              <Link
                to="/"
                className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Bots
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
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </>
          ) : (
            globalNavItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isNavActive(item.path, location.pathname)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))
          )}
        </nav>

        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => logout()}
          >
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
