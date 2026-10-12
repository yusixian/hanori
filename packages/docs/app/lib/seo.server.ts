export function docsOrigin(value = process.env.DOCS_SITE_URL): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "DOCS_SITE_URL must be an HTTPS origin without credentials, path, query or fragment.",
    );
  }
  return url.origin;
}

export function docsUrl(origin: string, path: string): string {
  return new URL(path === "/docs" || path === "/docs/" ? "/docs/" : path.replace(/\/$/, ""), origin)
    .href;
}

export function docsSitemap(origin: string | null, paths: string[]): string {
  const urls = origin ? [...new Set(paths.map((path) => docsUrl(origin, path)))].sort() : [];
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `\n  <url><loc>${escape(url)}</loc></url>`).join("")}\n</urlset>\n`;
}

export function docsRobots(origin: string | null): string {
  return (
    "User-agent: *\nDisallow: /api/\nDisallow: /mini-app/\n" +
    (origin ? `Sitemap: ${origin}/docs/sitemap.xml\n` : "")
  );
}
