import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { RootProvider } from "fumadocs-ui/provider/react-router";
import type { Route } from "./+types/root";
import "./styles.css";

const translations = {
  "Close Search(search dialog)(aria-label)": "关闭搜索",
  "Collapse Sidebar(sidebar)(aria-label)": "收起侧边栏",
  "Dark(theme switcher)(aria-label)": "深色",
  "Light(theme switcher)(aria-label)": "浅色",
  "Next Page(pagination)": "下一页",
  "No Headings(table of contents)": "本页没有小标题",
  "No results found(search dialog)": "没有找到相关文档",
  "On this page(table of contents)": "本页内容",
  "Open Search(search trigger)(aria-label)": "搜索文档",
  "Open Sidebar(sidebar)(aria-label)": "打开侧边栏",
  "Previous Page(pagination)": "上一页",
  "Search(search dialog)": "搜索文档",
  "Search(search trigger)": "搜索文档",
  "System(theme switcher)(aria-label)": "跟随系统",
  "Toggle Menu(mobile menu)(aria-label)": "打开菜单",
  "Toggle Theme(theme switcher)(aria-label)": "切换主题",
};

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fff8fb" />
        <link rel="icon" href="/docs/brand/icon-32.png" type="image/png" sizes="32x32" />
        <link rel="icon" href="/docs/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/docs/brand/apple-touch-icon.png" sizes="180x180" />
        <Meta />
        <Links />
      </head>
      <body>
        <RootProvider
          i18n={{ locale: "zh-CN", translations }}
          search={{
            links: [
              ["快速开始", "/docs/getting-started/quickstart"],
              ["版本更新说明", "/docs/changelog"],
            ],
            options: {
              type: "static",
              api: "/docs/search.json",
            },
          }}
          theme={{ defaultTheme: "system", enableSystem: true }}
        >
          {children}
        </RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const detail =
    import.meta.env.DEV && error instanceof Error
      ? error.message
      : notFound
        ? "这个地址可能已经调整，或页面还没有公开。"
        : "页面暂时无法显示，请稍后再试。";

  return (
    <main className="docs-error">
      <span className="docs-error__code">{notFound ? "404" : "错误"}</span>
      <h1>{notFound ? "这页文档不在这里" : "文档加载失败"}</h1>
      <p>{detail}</p>
      <a href="/docs">返回文档首页</a>
    </main>
  );
}
