import { expect, it, vi } from "vitest";
import { systemDiagnosticsRoutes, type DiagnosticChecks } from "./system-diagnostics.js";
import { RuntimeHealth } from "../runtime-health.js";

const secret = "sensitive-canary";
const runtime = new RuntimeHealth("a".repeat(40));
const base = {
  database: async () => true,
  migrationsReady: true,
  panelPasswordPresent: true,
  independentMiniAppSecret: false,
};
const routes = (checks: DiagnosticChecks) =>
  systemDiagnosticsRoutes(
    `https://user:${secret}@panel.test/path/${secret}?token=${secret}`,
    runtime,
    checks,
  );

it("returns only the origin, normalized protocols and status of each configured probe", async () => {
  const app = routes({
    ...base,
    coding: async () => {
      throw Error(`postgres://user:${secret}@db`);
    },
    media: async () => false,
    quote: async () => true,
  });
  const result = await app.request("/diagnostics", {
    headers: { "x-forwarded-proto": secret, authorization: `Bearer ${secret}` },
  });
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  const body = await result.json();
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(body).toMatchObject({
    data: {
      version: "a".repeat(40),
      databaseReady: true,
      migrationsReady: true,
      authOrigin: "https://panel.test",
      httpsOrigin: true,
      requestProtocol: "http",
      forwardedProtocol: "unknown",
      protocolMatches: false,
      panelPasswordPresent: true,
      independentMiniAppSecret: false,
      integrations: {
        "coding-worker": "unavailable",
        "media-worker": "unavailable",
        "nsfw-api": "disabled",
        "quote-worker": "reachable",
      },
    },
  });
});

it.each([
  [undefined, false],
  ["https, http", true],
  ["http", false],
] as const)("checks forwarded scheme %s", async (header, matches) => {
  const result = await routes(base).request("/diagnostics", {
    headers: header ? { "x-forwarded-proto": header } : {},
  });
  expect(await result.json()).toHaveProperty("data.protocolMatches", matches);
});

it("bounds the response even if a probe fails to settle after cancellation", async () => {
  const quote = vi.fn((_signal: AbortSignal) => new Promise<boolean>(() => {}));
  const result = await routes({ ...base, quote, database: async () => false }).request(
    "/diagnostics",
  );
  expect(quote.mock.calls[0]?.[0].aborted).toBe(true);
  expect(await result.json()).toMatchObject({
    data: {
      databaseReady: false,
      integrations: { "quote-worker": "unavailable" },
    },
  });
});
