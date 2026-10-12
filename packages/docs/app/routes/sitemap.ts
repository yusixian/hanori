import { source } from "@/lib/source.server";
import { docsOrigin, docsSitemap } from "@/lib/seo.server";

export function loader() {
  return new Response(
    docsSitemap(
      docsOrigin(),
      source.getPages().map((page) => page.url),
    ),
    {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    },
  );
}
