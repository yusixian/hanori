import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { data } from "react-router";
import { getMDXComponents } from "@/components/mdx";
import { layoutOptions } from "@/lib/layout";
import { docsOrigin, docsUrl } from "@/lib/seo.server";
import { source } from "@/lib/source.server";
import type { Route } from "./+types/docs";

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params["*"]?.split("/").filter(Boolean) ?? [];
  const page = source.getPage(slugs);

  if (!page) {
    throw data("找不到这个文档页面。", { status: 404 });
  }

  const origin = docsOrigin();
  return {
    canonical: origin ? docsUrl(origin, page.url) : null,
    image: origin ? `${origin}/docs/brand/social-card.png` : null,
    path: page.path,
    tree: await source.serializePageTree(source.pageTree),
    title: page.data.title,
    description: page.data.description,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [{ title: "页面未找到 · Hanori 文档" }, { name: "robots", content: "noindex" }];
  }

  const title =
    loaderData.title === "Hanori 文档"
      ? "Hanori · 花织 — 自托管 Telegram AI 伙伴"
      : `${loaderData.title} · Hanori 文档`;

  const description =
    loaderData.description ?? "Hanori · 花织：自托管 Telegram AI 伙伴的配置、使用与部署指南。";
  const imageAlt = "Hanori · 花织，樱花与笑脸对话气泡标识，自托管 Telegram AI 伙伴";
  return [
    { title },
    { name: "description", content: description },
    { name: "robots", content: "index, follow" },
    { property: "og:site_name", content: "Hanori · 花织" },
    { property: "og:type", content: "website" },
    { property: "og:locale", content: "zh_CN" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { name: "twitter:card", content: loaderData.image ? "summary_large_image" : "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    ...(loaderData.canonical
      ? [
          { tagName: "link" as const, rel: "canonical", href: loaderData.canonical },
          { property: "og:url", content: loaderData.canonical },
        ]
      : []),
    ...(loaderData.image
      ? [
          { property: "og:image", content: loaderData.image },
          { property: "og:image:type", content: "image/png" },
          { property: "og:image:width", content: "1200" },
          { property: "og:image:height", content: "630" },
          { property: "og:image:alt", content: imageAlt },
          { name: "twitter:image", content: loaderData.image },
          { name: "twitter:image:alt", content: imageAlt },
        ]
      : []),
  ];
}

const clientLoader = browserCollections.docs.createClientLoader({
  component({ default: MDX, frontmatter, toc }) {
    return (
      <DocsPage className="docs-page" toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        {frontmatter.description ? (
          <DocsDescription>{frontmatter.description}</DocsDescription>
        ) : null}
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export default function DocsRoute({ loaderData }: Route.ComponentProps) {
  const { tree } = useFumadocsLoader(loaderData);

  return (
    <DocsLayout {...layoutOptions} tree={tree}>
      {clientLoader.useContent(loaderData.path)}
    </DocsLayout>
  );
}
