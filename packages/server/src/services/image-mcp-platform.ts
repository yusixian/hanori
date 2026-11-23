import { pixaiMcpConnections, settings, type Database } from "@cos-tool-bot/database";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ImageMcpConnectionService } from "./image-mcp-connection-service.js";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const SETTING_KEY = "image_mcp_platform";
const PROVIDERS = {
  mcp_pixai: { path: "pixai", connectionId: "default" },
  mcp_openai: { path: "openai-image", connectionId: "openai-image" },
  mcp_gemini: { path: "gemini-image", connectionId: "gemini-image" },
} as const;
export type ImageMcpProvider = keyof typeof PROVIDERS;
const providerIds = Object.keys(PROVIDERS) as ImageMcpProvider[];
const settingsSchema = z.strictObject({
  baseUrl: z.string().max(2048),
  revision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
});

export class ImageMcpPlatformError extends Error {
  constructor(readonly code: "invalid_configuration" | "conflict" | "unavailable") {
    super(code);
  }
}

export function normalizeImageMcpBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) return "";
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !url.hostname
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new ImageMcpPlatformError("invalid_configuration");
  }
}

/** Owns runtime replacements so a saved platform never mutates an in-flight client's endpoint. */
export class ImageMcpPlatformService {
  private current: Partial<Record<ImageMcpProvider, ImageMcpConnectionService>> = {};
  private state = { baseUrl: "", revision: 0 };
  private changing = new Set<ImageMcpProvider>();
  private closed = false;
  private readonly lock = new KeyedAsyncLock();

  constructor(
    private readonly db: Database,
    private readonly createConnection: (
      provider: ImageMcpProvider,
      endpoint?: string,
    ) => ImageMcpConnectionService,
    private readonly legacyEndpoints: Partial<Record<ImageMcpProvider, string>> = {},
  ) {}

  async initialize(): Promise<void> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTING_KEY))
      .limit(1);
    if (row) {
      const parsed = settingsSchema.parse(JSON.parse(row.value));
      this.state = { ...parsed, baseUrl: normalizeImageMcpBaseUrl(parsed.baseUrl) };
    }
    for (const provider of providerIds) {
      this.current[provider] = this.createConnection(
        provider,
        row
          ? this.endpoint(this.state.baseUrl, provider)
          : this.legacyEndpoints[provider] || undefined,
      );
    }
    await Promise.all(Object.values(this.current).map((service) => service.initialize()));
  }

  connection(provider: ImageMcpProvider): ImageMcpConnectionService | undefined {
    return this.changing.has(provider) || this.closed ? undefined : this.current[provider];
  }

  backend(provider: ImageMcpProvider) {
    const service = this.connection(provider);
    if (!service) return undefined;
    return { adapter: service.adapter, artifacts: service.artifacts, endpoint: service.endpoint };
  }

  getPublic() {
    return { ...this.state };
  }

  async update(input: unknown) {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new ImageMcpPlatformError("invalid_configuration");
    const baseUrl = normalizeImageMcpBaseUrl(parsed.data.baseUrl);
    return this.lock.run("settings", async () => {
      if (this.closed) throw new ImageMcpPlatformError("unavailable");
      if (parsed.data.revision !== this.state.revision) throw new ImageMcpPlatformError("conflict");
      const changed = providerIds.filter(
        (id) => this.current[id]?.endpoint !== this.endpoint(baseUrl, id),
      );
      const replacements = Object.fromEntries(
        changed.map((id) => [id, this.createConnection(id, this.endpoint(baseUrl, id))]),
      );
      const next = { baseUrl, revision: this.state.revision + 1 };
      this.changing = new Set(changed);
      try {
        // Drain old callbacks and token writes before clearing grants in the same transaction as the setting.
        await Promise.all(changed.map((id) => this.current[id]?.close()));
        await this.db.transaction(async (tx) => {
          const value = JSON.stringify(next);
          await tx
            .insert(settings)
            .values({ key: SETTING_KEY, value })
            .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
          if (changed.length) {
            await tx.delete(pixaiMcpConnections).where(
              inArray(
                pixaiMcpConnections.id,
                changed.map((id) => PROVIDERS[id].connectionId),
              ),
            );
          }
        });
        this.current = { ...this.current, ...replacements };
        this.state = next;
      } catch (error) {
        await Promise.allSettled(changed.map((id) => this.current[id]?.initialize()));
        await Promise.allSettled(Object.values(replacements).map((service) => service.close()));
        throw error;
      } finally {
        this.changing.clear();
      }
      return this.getPublic();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.lock.run("settings", async () => {
      await Promise.all(Object.values(this.current).map((service) => service.close()));
    });
  }

  private endpoint(baseUrl: string, provider: ImageMcpProvider): string | undefined {
    return baseUrl ? `${baseUrl}/mcp/${PROVIDERS[provider].path}` : undefined;
  }
}
