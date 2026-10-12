import { route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("docs/sitemap.xml", "routes/sitemap.ts"),
  route("docs/robots.txt", "routes/robots.ts"),
  route("docs/search.json", "routes/search.ts"),
  route("docs/*", "routes/docs.tsx"),
] satisfies RouteConfig;
