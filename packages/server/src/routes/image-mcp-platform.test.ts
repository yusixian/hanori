import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  ImageMcpPlatformError,
  type ImageMcpPlatformService,
} from "../services/image-mcp-platform.js";
import { imageMcpPlatformRoutes } from "./image-mcp-platform.js";

describe("image MCP platform routes", () => {
  it("returns saved platform settings and does not cache them", async () => {
    const service = {
      getPublic: () => ({ baseUrl: "https://mcp.example.com", revision: 1 }),
    } as ImageMcpPlatformService;
    const app = new Hono().route("/api/image-mcp-platform", imageMcpPlatformRoutes(service));
    const response = await app.request("/api/image-mcp-platform");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: service.getPublic() });
  });

  it.each([
    ["invalid_configuration", 400],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const)("reports %s safely", async (code, status) => {
    const service = {
      update: vi.fn().mockRejectedValue(new ImageMcpPlatformError(code)),
    } as unknown as ImageMcpPlatformService;
    const app = imageMcpPlatformRoutes(service);
    const response = await app.request("/", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "mcp.example.com", revision: 0 }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error: code });
  });

  it("rejects malformed JSON without calling the service", async () => {
    const service = { update: vi.fn() } as unknown as ImageMcpPlatformService;
    const response = await imageMcpPlatformRoutes(service).request("/", {
      method: "PUT",
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });
});
