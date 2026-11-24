import { Hono } from "hono";
import type { RuntimeHealthReader } from "../runtime-health.js";

type Probe = (signal: AbortSignal) => Promise<boolean>;
export interface DiagnosticChecks {
  database: Probe;
  migrationsReady: boolean;
  panelPasswordPresent: boolean;
  independentMiniAppSecret: boolean;
  quote?: Probe;
  media?: Probe;
  coding?: Probe;
  nsfw?: Probe;
}

async function probe(check: Probe | undefined, signal: AbortSignal) {
  if (!check) return "disabled" as const;
  let expire!: () => void;
  const expired = new Promise<false>((resolve) => {
    expire = () => resolve(false);
  });
  signal.addEventListener("abort", expire, { once: true });
  try {
    if (await Promise.race([check(signal), expired])) return "reachable" as const;
  } catch {
    // Transport errors may contain private addresses and credentials.
  } finally {
    signal.removeEventListener("abort", expire);
  }
  return "unavailable" as const;
}

function protocol(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "https" || normalized === "http" ? normalized : "unknown";
}

export function systemDiagnosticsRoutes(
  baseURL: string,
  runtime: RuntimeHealthReader,
  checks?: DiagnosticChecks,
) {
  return new Hono().get("/diagnostics", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!checks) return c.json({ ok: false as const }, 503);
    const deadline = AbortSignal.timeout(1500);
    const [database, quote, media, coding, nsfw] = await Promise.all([
      probe(checks.database, deadline),
      probe(checks.quote, deadline),
      probe(checks.media, deadline),
      probe(checks.coding, deadline),
      probe(checks.nsfw, deadline),
    ]);
    const url = new URL(baseURL);
    const requestProtocol = protocol(new URL(c.req.url).protocol.slice(0, -1));
    const header = c.req.header("x-forwarded-proto");
    const forwardedProtocol = header === undefined ? null : protocol(header.split(",")[0] ?? "");
    const effective = forwardedProtocol ?? requestProtocol;
    const { version, status } = runtime.snapshot();
    const mode = process.env.NODE_ENV;
    return c.json({
      ok: true as const,
      data: {
        version,
        status,
        mode: mode === "production" || mode === "test" ? mode : "development",
        databaseReady: database === "reachable",
        migrationsReady: checks.migrationsReady,
        authOrigin: url.origin,
        requestProtocol,
        forwardedProtocol,
        protocolMatches: effective + ":" === url.protocol,
        panelPasswordPresent: checks.panelPasswordPresent,
        independentMiniAppSecret: checks.independentMiniAppSecret,
        httpsOrigin: url.protocol === "https:",
        integrations: {
          "quote-worker": quote,
          "media-worker": media,
          "coding-worker": coding,
          "nsfw-api": nsfw,
        },
      },
    });
  });
}
