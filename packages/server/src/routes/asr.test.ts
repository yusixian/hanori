import { describe, expect, it, vi } from "vitest";
import { defaultAsrAccounts } from "@cos-tool-bot/shared";
import { AsrSettingsError, type AsrSettingsService } from "../services/asr-settings.js";
import { createAsrRoutes } from "./asr.js";

describe("shared ASR management routes", () => {
  it("returns sanitized service views and passes explicit secret edits to the trusted service", async () => {
    const view = {
      revision: 3,
      accounts: defaultAsrAccounts().map((account) => ({ ...account, configuredSecrets: [] })),
    };
    const service = { getPublic: vi.fn(async () => view), update: vi.fn(async () => view) };
    const app = createAsrRoutes(service as unknown as AsrSettingsService);
    const settings = await app.request("/settings");
    expect(settings.headers.get("Cache-Control")).toBe("no-store");
    expect(await settings.json()).toEqual({ ok: true, data: view });
    const input = {
      revision: 3,
      accounts: [{ provider: "tencent", secrets: { secretKey: null } }],
    };
    const response = await app.request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(input);
  });
  it.each([
    ["conflict", 409],
    ["invalid_configuration", 400],
    ["unreadable_configuration", 503],
  ] as const)("returns bounded %s errors", async (code, status) => {
    const service = {
      update: async () => {
        throw new AsrSettingsError(code);
      },
    };
    const response = await createAsrRoutes(service as unknown as AsrSettingsService).request(
      "/settings",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ ok: false, error: code });
  });
  it("rejects malformed JSON without returning parser details", async () => {
    const service = { update: vi.fn() };
    const response = await createAsrRoutes(service as unknown as AsrSettingsService).request(
      "/settings",
      { method: "PUT", body: "{secret" },
    );
    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: false, error: "invalid_configuration" });
  });
});
