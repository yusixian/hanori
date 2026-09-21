import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_SECURITY_HEADERS } from "../http-policy.js";
import { publicDocsRoutes } from "./public-docs.js";

let root: string;
let app: Hono;
const hydration = 'window.__docs = "ready";';

beforeAll(async () => {
  root = await mkdtemp(".docs-test-");
  await mkdir(`${root}/docs/changelog/v0.2.0`, { recursive: true });
  await mkdir(`${root}/docs/assets`, { recursive: true });
  await writeFile(`${root}/docs/index.html`, "<h1>公开文档</h1>");
  await writeFile(`${root}/docs.data`, "root loader payload");
  await writeFile(
    `${root}/docs/changelog/v0.2.0/index.html`,
    `<h1>v0.2.0</h1><script>${hydration}</script><script src="/docs/assets/app.js"></script>`,
  );
  await writeFile(`${root}/docs/assets/app.js`, "export const ready = true;");
  app = new Hono()
    .route("/", publicDocsRoutes(root))
    .get("/api/private", (c) => c.json({ error: "Unauthorized" }, 401))
    .get("*", (c) => c.text("panel shell"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("public documentation hosting", () => {
  it("serves deep links without a session and permits only the built inline scripts", async () => {
    const response = await app.request("/docs/changelog/v0.2.0/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>v0.2.0</h1>");
    const csp = response.headers.get("Content-Security-Policy");
    const hash = createHash("sha256").update(hydration).digest("base64");
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
  });

  it("redirects the docs root and serves both trailing-slash forms", async () => {
    const redirect = await app.request("/docs");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("Location")).toBe("/docs/");
    for (const path of ["/docs/", "/docs/changelog/v0.2.0"]) {
      expect((await app.request(path)).status).toBe(200);
    }
    const rootData = await app.request("/docs.data");
    expect(await rootData.text()).toBe("root loader payload");
    expect(rootData.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
  });

  it("caches fingerprinted assets and keeps the standard policy on external scripts", async () => {
    const response = await app.request("/docs/assets/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      APP_SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("returns a real 404 for absent documents/assets rather than the panel shell", async () => {
    for (const path of ["/docs/not-found", "/docs/assets/missing.js"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
      expect(await response.text()).not.toContain("panel shell");
    }
    expect(await (await app.request("/login")).text()).toBe("panel shell");
    expect((await app.request("/api/private")).status).toBe(401);
  });
});
