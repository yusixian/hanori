import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { APP_SECURITY_HEADERS, staticCacheControl } from "../http-policy.js";

function documentCsp(html: string): string {
  // Only scripts embedded in our build artifacts are trusted. Keep the admin CSP unchanged.
  const hashes = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (match[1]) {
      hashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
    }
  }
  return APP_SECURITY_HEADERS["Content-Security-Policy"].replace(
    "script-src 'self'",
    `script-src 'self' ${[...hashes].join(" ")}`.trimEnd(),
  );
}

export function publicDocsRoutes(root = "./public") {
  type DocsEnv = { Variables: { documentCsp?: string } };
  const policy: MiddlewareHandler<DocsEnv> = async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(APP_SECURITY_HEADERS)) c.header(name, value);
    const csp = c.get("documentCsp");
    if (csp) c.header("Content-Security-Policy", csp);
    c.header(
      "Cache-Control",
      c.res.status >= 200 && c.res.status < 300
        ? staticCacheControl(c.req.path)
        : "no-cache, no-store, must-revalidate",
    );
  };
  return (
    new Hono<DocsEnv>()
      .use("/robots.txt", policy)
      .get("/robots.txt", serveStatic({ root, path: "docs/robots.txt" }))
      .all("/robots.txt", (c) => c.text("Not found", 404))
      .use("/docs/*", policy)
      // React Router fetches the root loader here when navigating back to /docs.
      .use("/docs.data", policy)
      .get("/docs.data", serveStatic({ root }))
      .all("/docs.data", (c) => c.text("Not found", 404))
      .get("/docs", (c) => c.redirect("/docs/", 308))
      .get(
        "/docs/*",
        serveStatic({
          root,
          onFound: async (path, c) => {
            if (path.endsWith(".html")) {
              c.set("documentCsp", documentCsp(await readFile(path, "utf8")));
            }
          },
        }),
      )
      // Missing docs and assets must never fall through to the authenticated panel's SPA shell.
      .all("/docs/*", (c) =>
        c.html(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>页面未找到 · Hanori</title><main><h1>页面未找到</h1><p>这个文档地址不存在。</p><a href="/docs/">返回文档首页</a></main></html>',
          404,
        ),
      )
  );
}
