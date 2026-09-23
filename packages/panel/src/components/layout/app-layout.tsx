import { sidebarCollapsedAtom, sidebarOpenAtom } from "@/atoms/sidebar";
import { LanguageSwitcher } from "@/components/language-switcher";
import { authClient } from "@/lib/auth-client";
import { BeforeLogoutProvider, useBeforeLogout } from "./before-logout";
import { cn } from "@/lib/utils";
import { useLogout } from "@refinedev/core";
import { toast } from "sonner";
import { useAtom } from "jotai";
import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  Bug,
  ChevronDown,
  Database,
  Download,
  FileText,
  FlaskConical,
  FolderOpen,
  HardDrive,
  ImageIcon,
  Library,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plug,
  Rss,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "../ui/button";

interface GlobalNavItem {
  labelKey: string;
  path: string;
  icon: LucideIcon;
  aliases?: readonly string[];
  external?: boolean;
}

interface BotNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  aliases?: readonly string[];
}

const globalNavGroups: readonly {
  labelKey: string;
  items: readonly GlobalNavItem[];
}[] = [
  {
    labelKey: "navigation.globalGroups.workspace",
    items: [
      { labelKey: "navigation.bots", path: "/", icon: Bot, aliases: ["bot"] },
      { labelKey: "navigation.usage", path: "/usage", icon: BarChart3 },
      { labelKey: "navigation.timers", path: "/timers", icon: Timer, aliases: ["schedule"] },
    ],
  },
  {
    labelKey: "navigation.globalGroups.dataAndIntegrations",
    items: [
      { labelKey: "navigation.data", path: "/data", icon: Database },
      { labelKey: "navigation.backup", path: "/backup", icon: HardDrive },
      { labelKey: "navigation.mcp", path: "/mcp-servers", icon: Plug, aliases: ["server"] },
      { labelKey: "navigation.apiTest", path: "/api-test", icon: FlaskConical, aliases: ["api"] },
    ],
  },
  {
    labelKey: "navigation.globalGroups.operations",
    items: [{ labelKey: "navigation.logs", path: "/logs", icon: ScrollText }],
  },
];

const settingsNavItem = {
  labelKey: "navigation.settings",
  path: "/settings",
  icon: Settings,
  aliases: ["preferences"],
} as const;

const externalNavItems = [
  {
    labelKey: "navigation.documentation",
    path: "/docs/",
    icon: BookOpen,
    aliases: ["guide", "help"],
    external: true,
  },
  {
    labelKey: "navigation.changelog",
    path: "/docs/changelog/",
    icon: FileText,
    aliases: ["release", "updates"],
    external: true,
  },
] as const;

function isPathActive(itemPath: string, pathname: string) {
  if (itemPath === "/") return pathname === "/";
  if (/^\/bots\/[^/]+$/.test(itemPath)) return pathname === itemPath;
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

function matchesNavigation(
  query: string,
  label: string,
  path: string,
  aliases?: readonly string[],
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [label, path, ...(aliases ?? [])].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

function useMobileViewport() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 767px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function accountInitials(name: string | null | undefined, email: string | null | undefined) {
  const parts = name?.trim().split(/\s+/).filter(Boolean);
  if (parts?.length) {
    return (
      parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : parts[0]!.slice(0, 2)
    ).toLocaleUpperCase();
  }
  return email?.trim().slice(0, 1).toLocaleUpperCase() || null;
}

function GroupLabel({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <p
      className={cn(
        "px-2 pt-3 pb-1 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase first:pt-0",
        hidden && "md:hidden",
      )}
    >
      {children}
    </p>
  );
}

function NavigationLink({
  item,
  label,
  active,
  collapsed,
}: {
  item: Pick<GlobalNavItem, "path" | "icon" | "external">;
  label: string;
  active: boolean;
  collapsed: boolean;
}) {
  const className = cn(
    "group flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-sm font-medium transition-[background-color,color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-9",
    active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
    collapsed && "md:justify-center md:px-0",
  );
  const content = (
    <>
      <item.icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-blue-600" : "text-slate-400 group-hover:text-slate-600",
        )}
      />
      <span className={cn("truncate", collapsed && "md:hidden")}>{label}</span>
    </>
  );

  if (item.external) {
    return (
      <a href={item.path} title={label} aria-label={label} className={className}>
        {content}
      </a>
    );
  }

  return (
    <Link
      to={item.path}
      title={label}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {content}
    </Link>
  );
}

function SearchField({
  collapsed,
  query,
  setQuery,
  inputRef,
  onCollapsedSearch,
  label,
  placeholder,
  clearLabel,
}: {
  collapsed: boolean;
  query: string;
  setQuery: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onCollapsedSearch: () => void;
  label: string;
  placeholder: string;
  clearLabel: string;
}) {
  if (collapsed) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mx-auto hidden size-10 px-0 md:flex"
        onClick={onCollapsedSearch}
        aria-label={label}
        title={label}
      >
        <Search className="size-4" />
      </Button>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 pr-9 pl-8 text-sm transition-[border-color,background-color,box-shadow] outline-none placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          className="focus-visible:ring-ring absolute top-1/2 right-0.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label={clearLabel}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function AppLayoutContent() {
  const { t } = useTranslation("common");
  const location = useLocation();
  const { mutateAsync: logout, isLoading: logoutPending } = useLogout();
  const { requestLogout } = useBeforeLogout();
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const [query, setQuery] = useState("");
  const [globalOpen, setGlobalOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountUser, setAccountUser] = useState<{ name?: string | null; email?: string | null }>();
  const [focusSearchAfterExpand, setFocusSearchAfterExpand] = useState(false);
  const isMobile = useMobileViewport();
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const languageEscapeEvents = useRef(new WeakSet<KeyboardEvent>());
  const showCollapsed = collapsed && !isMobile;
  const accountName =
    accountUser?.name?.trim() || accountUser?.email?.trim() || t("navigation.accountName");
  const initials = accountInitials(accountUser?.name, accountUser?.email);

  useEffect(() => {
    let active = true;
    void authClient
      .getSession()
      .then(({ data }) => {
        if (active) setAccountUser(data?.user ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const botIdMatch = location.pathname.match(/^\/bots\/([^/]+)/);
  const botId = botIdMatch?.[1];
  const isBotContext = botId != null && botId !== "new";

  const botNavGroups = useMemo(
    () =>
      botId
        ? [
            {
              label: t("navigation.botGroups.frequent"),
              items: [
                { label: t("navigation.overview"), path: `/bots/${botId}`, icon: Bot },
                {
                  label: t("navigation.aiSettings"),
                  path: `/bots/${botId}/ai`,
                  icon: Brain,
                  aliases: ["ai", "model"],
                },
                {
                  label: t("navigation.conversations"),
                  path: `/bots/${botId}/conversations`,
                  icon: MessageSquare,
                  aliases: ["chat"],
                },
              ],
            },
            {
              label: t("navigation.botGroups.contentAndMemory"),
              items: [
                { label: t("navigation.profiles"), path: `/bots/${botId}/profiles`, icon: Users },
                {
                  label: t("navigation.memories"),
                  path: `/bots/${botId}/memories`,
                  icon: BookOpen,
                  aliases: ["memory"],
                },
                {
                  label: t("navigation.generationLibrary"),
                  path: `/bots/${botId}/generation-library`,
                  icon: Library,
                  aliases: ["library"],
                },
                {
                  label: t("navigation.generations"),
                  path: `/bots/${botId}/generations`,
                  icon: ImageIcon,
                  aliases: ["images"],
                },
                { label: t("navigation.files"), path: `/bots/${botId}/files`, icon: FolderOpen },
              ],
            },
            {
              label: t("navigation.botGroups.automation"),
              items: [
                {
                  label: t("navigation.skills"),
                  path: `/bots/${botId}/skills`,
                  icon: Sparkles,
                },
                { label: t("navigation.rss"), path: `/bots/${botId}/rss`, icon: Rss },
                {
                  label: t("navigation.chatSummary"),
                  path: `/bots/${botId}/summary`,
                  icon: FileText,
                  aliases: ["summary"],
                },
              ],
            },
            {
              label: t("navigation.botGroups.managementAndDiagnostics"),
              items: [
                { label: t("navigation.edit"), path: `/bots/${botId}/edit`, icon: Pencil },
                {
                  label: t("navigation.governance"),
                  path: `/bots/${botId}/governance`,
                  icon: ShieldCheck,
                },
                { label: t("navigation.debugger"), path: `/bots/${botId}/debugger`, icon: Bug },
                { label: t("navigation.export"), path: `/bots/${botId}/export`, icon: Download },
                { label: t("navigation.logs"), path: `/bots/${botId}/logs`, icon: ScrollText },
              ],
            },
          ]
        : [],
    [botId, t],
  );

  const allBotItems = useMemo(
    () => botNavGroups.flatMap((group) => group.items) as BotNavItem[],
    [botNavGroups],
  );
  const allGlobalItems = useMemo(
    () =>
      [
        ...globalNavGroups.flatMap((group) => group.items),
        settingsNavItem,
        ...externalNavItems,
      ] as GlobalNavItem[],
    [],
  );
  const filteredBotItems = allBotItems.filter((item) =>
    matchesNavigation(query, item.label, item.path, item.aliases),
  );
  const filteredGlobalItems = allGlobalItems.filter((item) =>
    matchesNavigation(query, t(item.labelKey), item.path, item.aliases),
  );
  const settingsActive = !query.trim() && isPathActive(settingsNavItem.path, location.pathname);

  const handleMobileNavigation = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("a[href]")) setAccountOpen(false);
    if (!isMobile || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!(event.target as Element).closest("a[href]")) return;
    setSidebarOpen(false);
    requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  };

  useEffect(() => {
    setSidebarOpen(false);
    setAccountOpen(false);
    setQuery("");
  }, [location.pathname, setSidebarOpen]);

  useEffect(() => {
    if (isMobile && !sidebarOpen) setAccountOpen(false);
  }, [isMobile, sidebarOpen]);

  useEffect(() => {
    if (showCollapsed) setAccountOpen(false);
  }, [showCollapsed]);

  useEffect(() => {
    if (!accountOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !accountRef.current?.contains(event.target as Node) &&
        !(event.target as Element).closest('[role="listbox"]')
      ) {
        setAccountOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [accountOpen]);

  useEffect(() => {
    if (!accountOpen) return;
    const handleLanguageEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = accountRef.current?.querySelector<HTMLElement>(
        '[role="combobox"][aria-expanded="true"]',
      );
      if (!trigger) return;
      languageEscapeEvents.current.add(event);
      requestAnimationFrame(() => {
        if (trigger.isConnected && trigger.getAttribute("aria-expanded") === "false") {
          trigger.focus();
        }
      });
    };
    document.addEventListener("keydown", handleLanguageEscape, true);
    return () => document.removeEventListener("keydown", handleLanguageEscape, true);
  }, [accountOpen]);

  useEffect(() => {
    if (!focusSearchAfterExpand || collapsed) return;
    searchInputRef.current?.focus();
    setFocusSearchAfterExpand(false);
  }, [collapsed, focusSearchAfterExpand]);

  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    mobileCloseButtonRef.current?.focus();
  }, [isMobile, sidebarOpen]);

  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (languageEscapeEvents.current.has(event) || event.defaultPrevented) return;
        const inSidebar = sidebarRef.current?.contains(event.target as Node);
        if (!inSidebar && !(accountOpen && event.target === document.body)) return;
        event.preventDefault();
        if (accountOpen) {
          setAccountOpen(false);
          accountButtonRef.current?.focus();
          return;
        }
        setSidebarOpen(false);
        mobileMenuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [accountOpen, isMobile, setSidebarOpen, sidebarOpen]);

  useEffect(() => {
    if (!accountOpen || isMobile) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        languageEscapeEvents.current.has(event) ||
        event.defaultPrevented ||
        (!sidebarRef.current?.contains(event.target as Node) && event.target !== document.body)
      )
        return;
      event.preventDefault();
      setAccountOpen(false);
      accountButtonRef.current?.focus();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [accountOpen, isMobile]);

  const renderGlobalGroups = () =>
    globalNavGroups.map((group) => (
      <div key={group.labelKey}>
        <GroupLabel hidden={showCollapsed}>{t(group.labelKey)}</GroupLabel>
        <div className="space-y-0.5">
          {group.items.map((item) => (
            <NavigationLink
              key={item.path}
              item={item}
              label={t(item.labelKey)}
              active={isPathActive(item.path, location.pathname)}
              collapsed={showCollapsed}
            />
          ))}
        </div>
      </div>
    ));

  const renderSearchResults = () => {
    const results = [
      ...(isBotContext
        ? filteredBotItems.map((item) => ({
            ...item,
            external: false,
            scope: t("navigation.searchBotScope"),
          }))
        : []),
      ...filteredGlobalItems.map((item) => ({
        ...item,
        label: t(item.labelKey),
        scope: t("navigation.searchGlobalScope"),
      })),
    ];

    if (!results.length) {
      return (
        <div className="px-2 py-8 text-center">
          <p className="text-sm font-medium text-slate-700">{t("navigation.searchEmpty")}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 h-10 text-blue-700"
            onClick={() => {
              setQuery("");
              searchInputRef.current?.focus();
            }}
          >
            {t("navigation.clearSearch")}
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-0.5" aria-label={t("navigation.searchResults")}>
        {results.map((item) => {
          const active = !item.external && isPathActive(item.path, location.pathname);
          const className = cn(
            "group flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100",
          );
          const content = (
            <>
              <item.icon className="size-4 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                {item.scope}
              </span>
            </>
          );
          return item.external ? (
            <a key={item.path} href={item.path} className={className}>
              {content}
            </a>
          ) : (
            <Link
              key={item.path}
              to={item.path}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              {content}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:top-4 focus:left-4"
      >
        {t("navigation.skipToContent")}
      </a>

      <header className="z-30 flex min-h-14 items-center gap-3 border-b border-slate-200/80 bg-white/85 px-3 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1 backdrop-blur-xl md:hidden">
        <Button
          ref={mobileMenuButtonRef}
          variant="ghost"
          size="sm"
          onClick={() => setSidebarOpen(true)}
          aria-label={t("navigation.openMenu")}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
        >
          <Menu className="size-5" />
        </Button>
        <div className="bg-primary flex size-8 items-center justify-center rounded-xl text-white shadow-[0_6px_14px_rgb(37_99_235/0.24)]">
          <Bot className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">{t("app.name")}</span>
      </header>

      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-[2px] md:hidden"
          onClick={() => {
            setSidebarOpen(false);
            mobileMenuButtonRef.current?.focus();
          }}
          aria-label={t("navigation.closeMenu")}
          tabIndex={-1}
        />
      )}

      <aside
        ref={sidebarRef}
        id="app-sidebar"
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile && sidebarOpen ? true : undefined}
        aria-label={isMobile ? t("navigation.menu") : undefined}
        aria-hidden={isMobile && !sidebarOpen ? true : undefined}
        inert={isMobile && !sidebarOpen ? true : undefined}
        onClick={handleMobileNavigation}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[min(86vw,19rem)] flex-col overflow-hidden border-r border-slate-200/80 bg-white/95 shadow-[14px_0_40px_rgb(15_23_42/0.1)] backdrop-blur-xl transition-[width,transform] duration-200 ease-out md:static md:z-auto md:translate-x-0 md:w-[248px] md:shadow-[8px_0_28px_rgb(15_23_42/0.025)]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "md:w-[68px]" : "md:w-[248px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200/80 px-3">
          {showCollapsed ? (
            <Button
              variant="ghost"
              size="sm"
              className="mx-auto hidden size-10 px-0 md:flex"
              onClick={() => setCollapsed(false)}
              title={t("navigation.expandSidebar")}
              aria-label={t("navigation.expandSidebar")}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="bg-primary flex size-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm">
                  <Bot className="size-4" />
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-sm font-semibold tracking-tight">
                    {t("app.name")}
                  </span>
                  <span className="block truncate text-[10px] text-slate-500">
                    {isBotContext ? t("navigation.botWorkspace") : t("app.subtitle")}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="hidden size-10 shrink-0 px-0 md:flex"
                onClick={() => setCollapsed(true)}
                title={t("navigation.collapseSidebar")}
                aria-label={t("navigation.collapseSidebar")}
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </>
          )}
          <Button
            ref={mobileCloseButtonRef}
            variant="ghost"
            size="sm"
            className="size-10 px-0 md:hidden"
            onClick={() => {
              setSidebarOpen(false);
              mobileMenuButtonRef.current?.focus();
            }}
            aria-label={t("navigation.closeMenu")}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="shrink-0 px-3 pt-3 pb-2" inert={accountOpen}>
          <SearchField
            collapsed={showCollapsed}
            query={query}
            setQuery={setQuery}
            inputRef={searchInputRef}
            label={t("navigation.search")}
            placeholder={t("navigation.searchPlaceholder")}
            clearLabel={t("navigation.clearSearch")}
            onCollapsedSearch={() => {
              setFocusSearchAfterExpand(true);
              setCollapsed(false);
            }}
          />
        </div>

        <nav
          className="flex flex-1 flex-col overflow-y-auto px-3 py-2"
          aria-label={t("navigation.primary")}
          inert={accountOpen}
        >
          {query.trim() ? (
            renderSearchResults()
          ) : isBotContext ? (
            <>
              <div className="mb-2 border-b border-slate-200 pb-2">
                <NavigationLink
                  item={{ path: "/", icon: ArrowLeft }}
                  label={t("navigation.backToBots")}
                  active={false}
                  collapsed={showCollapsed}
                />
              </div>
              <div className="space-y-2">
                {botNavGroups.map((group) => (
                  <div key={group.label}>
                    <GroupLabel hidden={showCollapsed}>{group.label}</GroupLabel>
                    <div className="space-y-0.5">
                      {group.items.map((item) => (
                        <NavigationLink
                          key={item.path}
                          item={item}
                          label={item.label}
                          active={isPathActive(item.path, location.pathname)}
                          collapsed={showCollapsed}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 border-t border-slate-200 pt-2">
                <button
                  type="button"
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    showCollapsed && "md:justify-center md:px-0",
                  )}
                  onClick={() => {
                    if (showCollapsed) setCollapsed(false);
                    setGlobalOpen((open) => !open || showCollapsed);
                  }}
                  aria-expanded={globalOpen}
                  aria-label={t("navigation.globalManagement")}
                  title={t("navigation.globalManagement")}
                >
                  <Database className="size-4 shrink-0 text-blue-600" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-left",
                      showCollapsed && "md:hidden",
                    )}
                  >
                    {t("navigation.globalManagement")}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-slate-400 transition-transform",
                      globalOpen && "rotate-180",
                      showCollapsed && "md:hidden",
                    )}
                  />
                </button>
                {globalOpen && !showCollapsed && (
                  <div className="mt-1 border-l border-blue-100 pl-2">{renderGlobalGroups()}</div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2">{renderGlobalGroups()}</div>
          )}
        </nav>

        <div
          ref={accountRef}
          className="relative shrink-0 border-t border-slate-200/80 bg-slate-50/70 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
        >
          <button
            ref={accountButtonRef}
            type="button"
            className={cn(
              "flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              showCollapsed && "md:justify-center md:px-0",
              accountOpen && "bg-white",
            )}
            onClick={() => {
              if (showCollapsed) setCollapsed(false);
              setAccountOpen((open) => !open);
            }}
            aria-label={t("navigation.account")}
            aria-expanded={accountOpen}
            aria-controls="sidebar-account-menu"
            title={accountName}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
              {initials ?? <UserRound className="size-4" />}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium text-slate-700",
                showCollapsed && "md:hidden",
              )}
            >
              {accountName}
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-slate-400 transition-transform",
                accountOpen && "rotate-180",
                showCollapsed && "md:hidden",
              )}
            />
          </button>
          {accountOpen && (
            <div
              id="sidebar-account-menu"
              role="group"
              aria-label={t("navigation.accountMenu")}
              className="absolute right-2.5 bottom-full left-2.5 max-h-[calc(100dvh-8rem)] space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-[0_-10px_32px_rgb(15_23_42/0.12)]"
            >
              <Link
                to={settingsNavItem.path}
                aria-current={settingsActive ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  settingsActive && "bg-blue-50 text-blue-700",
                )}
              >
                <Settings className="size-4 shrink-0 text-slate-400" />
                {t(settingsNavItem.labelKey)}
              </Link>
              <LanguageSwitcher className="block px-1 py-1" selectClassName="h-10 w-full" />
              {externalNavItems.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  className="focus-visible:ring-ring flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <item.icon className="size-4 shrink-0 text-slate-400" />
                  {t(item.labelKey)}
                </a>
              ))}
              <div className="border-t border-slate-200 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-10 w-full justify-start gap-2.5 px-2.5 text-sm font-medium text-slate-700"
                  disabled={logoutPending}
                  onClick={() => {
                    setAccountOpen(false);
                    if (isMobile) {
                      setSidebarOpen(false);
                      mobileMenuButtonRef.current?.focus();
                    }
                    requestLogout(async () => {
                      try {
                        const result = await logout();
                        if (!result.success) throw result.error ?? new Error("Logout failed");
                      } catch (error) {
                        toast.error(t("auth:errors.operationFailed"));
                        throw error;
                      }
                    });
                  }}
                >
                  <LogOut className="size-4 shrink-0" />
                  {t("navigation.logout")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main id="main-content" className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full max-w-[1480px] p-4 sm:p-6 lg:p-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function AppLayout() {
  return (
    <BeforeLogoutProvider>
      <AppLayoutContent />
    </BeforeLogoutProvider>
  );
}
