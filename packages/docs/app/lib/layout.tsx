import mark from "../../public/docs/icon.svg?raw";
import "./hanori-mark.css";
import { BookOpenText, LayoutDashboard } from "lucide-react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

function Wordmark() {
  return (
    <span className="docs-wordmark">
      <span
        aria-hidden="true"
        className="hanori-mark docs-wordmark__mark"
        // Only the bundled, repository-owned SVG is inserted here.
        dangerouslySetInnerHTML={{ __html: mark }}
      />
      <span className="docs-wordmark__text">
        <strong>Hanori</strong>
        <small>花织 · 使用文档</small>
      </span>
    </span>
  );
}

export const layoutOptions: BaseLayoutProps = {
  nav: {
    title: <Wordmark />,
    url: "/docs",
    transparentMode: "none",
  },
  links: [
    {
      type: "main",
      text: "开始使用",
      url: "/docs/getting-started",
      icon: <BookOpenText aria-hidden="true" />,
      active: "nested-url",
    },
    {
      type: "custom",
      children: (
        <a className="docs-panel-link" href="/">
          <LayoutDashboard aria-hidden="true" />
          <span>管理面板</span>
        </a>
      ),
    },
  ],
  themeSwitch: {
    mode: "light-dark-system",
  },
  searchToggle: {
    full: {
      className: "docs-search-trigger",
    },
  },
};
