import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import type { ImageMcpConnectionService } from "./image-mcp-connection-service.js";
import { ImageMcpPlatformService, normalizeImageMcpBaseUrl } from "./image-mcp-platform.js";

function fixture(stored?: string) {
  let value = stored;
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => (value === undefined ? [] : [{ value }])),
  };
  const write = vi.fn(async (input: { set: { value: string } }) => {
    value = input.set.value;
  });
  const remove = vi.fn(async () => {});
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: write })) })),
    delete: vi.fn(() => ({ where: remove })),
  };
  const db = {
    select: vi.fn(() => query),
    transaction: vi.fn(async (run) => run(tx)),
  } as unknown as Database;
  const factory = vi.fn(
    (_provider: string, endpoint?: string) =>
      ({
        endpoint,
        initialize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }) as unknown as ImageMcpConnectionService,
  );
  const service = new ImageMcpPlatformService(db, factory, {
    mcp_pixai: "https://mcp.example.com/mcp/pixai",
  });
  return { service, factory, db, write, remove, stored: () => value };
}

describe("image MCP platform configuration", () => {
  it.each(["mcp.example.com", " https://mcp.example.com/ "])(
    "accepts a single platform address: %s",
    (input) => expect(normalizeImageMcpBaseUrl(input)).toBe("https://mcp.example.com"),
  );

  it.each([
    "http://mcp.example.com",
    "https://user:secret@mcp.example.com",
    "https://mcp.example.com/mcp/pixai",
    "https://mcp.example.com/?key=secret",
    "https://mcp.example.com/#fragment",
    "not a host",
    "ftp://mcp.example.com",
  ])("rejects invalid platform addresses without exposing them: %s", (input) => {
    expect(() => normalizeImageMcpBaseUrl(input)).toThrow("invalid_configuration");
  });

  it("applies one GUI setting to all providers and preserves the unchanged PixAI grant", async () => {
    const { service, factory, remove, stored } = fixture();
    await service.initialize();
    const pixai = service.connection("mcp_pixai");
    await service.update({ baseUrl: "mcp.example.com", revision: 0 });
    expect(service.getPublic()).toEqual({ baseUrl: "https://mcp.example.com", revision: 1 });
    expect(service.connection("mcp_pixai")).toBe(pixai);
    expect(pixai!.close).not.toHaveBeenCalled();
    expect(service.connection("mcp_openai")?.endpoint).toBe(
      "https://mcp.example.com/mcp/openai-image",
    );
    expect(service.connection("mcp_gemini")?.endpoint).toBe(
      "https://mcp.example.com/mcp/gemini-image",
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(JSON.parse(stored()!)).toEqual(service.getPublic());
    expect(factory).toHaveBeenCalledTimes(5);
  });

  it("loads saved GUI configuration instead of legacy environment URLs after restart", async () => {
    const { service } = fixture(
      JSON.stringify({ baseUrl: "https://new.example.com", revision: 3 }),
    );
    await service.initialize();
    expect(service.connection("mcp_pixai")?.endpoint).toBe("https://new.example.com/mcp/pixai");
    expect(service.getPublic().revision).toBe(3);
  });

  it("keeps an explicitly cleared platform disabled after restart", async () => {
    const { service } = fixture(JSON.stringify({ baseUrl: "", revision: 1 }));
    await service.initialize();
    expect(service.connection("mcp_pixai")?.endpoint).toBeUndefined();
    expect(service.connection("mcp_openai")?.endpoint).toBeUndefined();
  });

  it("does not swap connections when persistence fails", async () => {
    const { service, db } = fixture();
    await service.initialize();
    const previous = service.connection("mcp_pixai");
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.update({ baseUrl: "new.example.com", revision: 0 })).rejects.toThrow();
    expect(service.connection("mcp_pixai")).toBe(previous);
    expect(previous!.initialize).toHaveBeenCalledTimes(2);
    expect(service.getPublic()).toEqual({ baseUrl: "", revision: 0 });
  });

  it("rejects a stale tab without changing the current platform", async () => {
    const { service } = fixture();
    await service.initialize();
    await service.update({ baseUrl: "new.example.com", revision: 0 });
    await expect(service.update({ baseUrl: "old.example.com", revision: 0 })).rejects.toThrow(
      "conflict",
    );
    expect(service.getPublic().baseUrl).toBe("https://new.example.com");
  });

  it("blocks new authorization while old clients drain and clears only changed grants", async () => {
    const { service, remove } = fixture();
    await service.initialize();
    const previous = service.connection("mcp_pixai")!;
    let finish!: () => void;
    vi.mocked(previous.close).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const saving = service.update({ baseUrl: "new.example.com", revision: 0 });
    await vi.waitFor(() => expect(previous.close).toHaveBeenCalled());
    expect(service.connection("mcp_pixai")).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    finish();
    await saving;
    expect(service.connection("mcp_pixai")).not.toBe(previous);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("keeps an unchanged provider available while other providers are being configured", async () => {
    const { service } = fixture();
    await service.initialize();
    const pixai = service.connection("mcp_pixai")!;
    const openai = service.connection("mcp_openai")!;
    let finish!: () => void;
    vi.mocked(openai.close).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const saving = service.update({ baseUrl: "mcp.example.com", revision: 0 });
    await vi.waitFor(() => expect(openai.close).toHaveBeenCalled());
    expect(service.connection("mcp_pixai")).toBe(pixai);
    expect(pixai.close).not.toHaveBeenCalled();
    finish();
    await saving;
  });
});
