import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { GenerationLibraryService } from "../services/generation-library-service.js";
import { generationLibraryRoutes } from "./generation-library.js";

function service(overrides: Partial<GenerationLibraryService> = {}) {
  return {
    getSettings: vi.fn(async () => ({
      charactersEnabled: true,
      assetsEnabled: true,
      injectionEnabled: false,
      nsfwEnabled: false,
    })),
    updateSettings: vi.fn(async (_actor, settings) => settings),
    listCharacters: vi.fn(async () => ({ data: [], total: 0 })),
    saveCharacter: vi.fn(async () => ({ id: 1 })),
    deleteCharacter: vi.fn(async () => undefined),
    listAssets: vi.fn(async () => ({ data: [], total: 0 })),
    saveAsset: vi.fn(async () => ({ id: 1 })),
    deleteAsset: vi.fn(async () => undefined),
    getBindings: vi.fn(async () => []),
    setBinding: vi.fn(async () => undefined),
    removeBinding: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as GenerationLibraryService;
}

function routeApp(role: string, library: GenerationLibraryService) {
  return new Hono<{ Variables: AuthVariables }>()
    .onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ ok: false as const, error: error.message }, error.status);
      }
      return c.json({ ok: false as const, error: "Internal Server Error" }, 500);
    })
    .use("*", async (c, next) => {
      c.set("authMember", { role } as AuthVariables["authMember"]);
      await next();
    })
    .route("/api/bots", generationLibraryRoutes(library));
}

describe("generation library panel routes", () => {
  it("allows viewer reads and forwards only the trusted panel actor", async () => {
    const listCharacters = vi.fn(async () => ({ data: [], total: 3 }));
    const library = service({ listCharacters } as Partial<GenerationLibraryService>);
    const response = await routeApp("viewer", library).request(
      "/api/bots/bot-1/generation-library/characters?search=hero&page=2&limit=10&source=original",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: [], total: 3 });
    expect(listCharacters).toHaveBeenCalledWith(
      { botId: "bot-1", source: "panel", isAdmin: false },
      { search: "hero", page: 2, limit: 10, source: "original" },
    );
  });

  it("rejects all panel writes for editor and viewer roles before calling the service", async () => {
    const updateSettings = vi.fn();
    const saveCharacter = vi.fn();
    const saveAsset = vi.fn();
    const setBinding = vi.fn();
    const library = service({
      updateSettings,
      saveCharacter,
      saveAsset,
      setBinding,
    } as Partial<GenerationLibraryService>);
    const app = routeApp("editor", library);

    const responses = await Promise.all([
      app.request("/api/bots/bot-1/generation-library/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          charactersEnabled: true,
          assetsEnabled: true,
          injectionEnabled: false,
          nsfwEnabled: false,
        }),
      }),
      app.request("/api/bots/bot-1/generation-library/characters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "OC",
          aliases: [],
          appearance: "",
          defaultOutfit: "",
          notes: "",
        }),
      }),
      app.request("/api/bots/bot-1/generation-library/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "style",
          type: "style",
          content: "watercolor",
          notes: "",
          safety: "safe",
          pinned: false,
        }),
      }),
      app.request("/api/bots/bot-1/generation-library/bindings/42", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: 1, relation: "representation", isDefault: true }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(saveCharacter).not.toHaveBeenCalled();
    expect(saveAsset).not.toHaveBeenCalled();
    expect(setBinding).not.toHaveBeenCalled();
  });

  it("allows owner writes without accepting actor fields from JSON", async () => {
    const setBinding = vi.fn(async () => undefined);
    const library = service({ setBinding } as Partial<GenerationLibraryService>);
    const app = routeApp("owner", library);

    const rejected = await app.request("/api/bots/bot-1/generation-library/bindings/42", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterId: 1,
        relation: "representation",
        isDefault: true,
        isAdmin: true,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(setBinding).not.toHaveBeenCalled();

    const allowed = await app.request("/api/bots/bot-1/generation-library/bindings/42", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: 1, relation: "representation", isDefault: true }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });
    expect(setBinding).toHaveBeenCalledWith(
      { botId: "bot-1", source: "panel", isAdmin: true },
      42,
      { characterId: 1, relation: "representation", isDefault: true },
    );
  });

  it("validates list filters and resource identifiers before invoking the service", async () => {
    const listAssets = vi.fn();
    const deleteCharacter = vi.fn();
    const library = service({ listAssets, deleteCharacter } as Partial<GenerationLibraryService>);
    const app = routeApp("owner", library);

    const invalidQuery = await app.request(
      "/api/bots/bot-1/generation-library/assets?limit=101&safety=unsafe",
    );
    const invalidId = await app.request(
      "/api/bots/bot-1/generation-library/characters/not-a-number",
      { method: "DELETE" },
    );

    expect(invalidQuery.status).toBe(400);
    expect(invalidId.status).toBe(400);
    expect(listAssets).not.toHaveBeenCalled();
    expect(deleteCharacter).not.toHaveBeenCalled();
  });
});
