import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { data } from "react-router";
import { getMDXComponents } from "@/components/mdx";
import { layoutOptions } from "@/lib/layout";
import { source } from "@/lib/source.server";
import type { Route } from "./+types/docs";

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params["*"]?.split("/").filter(Boolean) ?? [];
  const page = source.getPage(slugs);

  if (!page) {
    throw data("找不到这个文档页面。", { status: 404 });
  }

  return {
    path: page.path,
    tree: await source.serializePageTree(source.pageTree),
    title: page.data.title,
    description: page.data.description,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [{ title: "页面未找到 · Hanori 文档" }];
  }

  const title =
    loaderData.title === "Hanori 文档" ? loaderData.title : `${loaderData.title} · Hanori 文档`;

  return [{ title }, { name: "description", content: loaderData.description }];
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
