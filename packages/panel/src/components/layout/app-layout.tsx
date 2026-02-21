import { cn } from "@/lib/utils";
import { useLogout } from "@refinedev/core";
import { Bot, LogOut, LayoutDashboard, ScrollText } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button";

const navItems = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Logs", path: "/logs", icon: ScrollText },
];

export function AppLayout() {
  const location = useLocation();
  const { mutate: logout } = useLogout();

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="bg-card flex w-56 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <Bot className="text-primary h-6 w-6" />
          <span className="text-sm font-semibold">cos-tool-bot</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                location.pathname === item.path
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
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
