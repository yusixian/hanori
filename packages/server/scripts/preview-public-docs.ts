import { serve } from "@hono/node-server";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { publicDocsRoutes } from "../src/routes/public-docs.js";

// Preview the real production static handler without booting a database or any Bot.
const root = fileURLToPath(new URL("../../docs/build/client/", import.meta.url));
await access(`${root}/docs/index.html`);
const app = publicDocsRoutes(root);
const port = Number(process.env.DOCS_PREVIEW_PORT ?? 43104);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  console.log(`Public documentation preview: http://127.0.0.1:${port}/docs/`);
});
