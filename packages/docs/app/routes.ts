import { route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("docs/search.json", "routes/search.ts"),
  route("docs/*", "routes/docs.tsx"),
] satisfies RouteConfig;
