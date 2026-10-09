import type { Database } from "@cos-tool-bot/database";
import type { ImageProviderRoute, ImageGovernanceConfig } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  DEFAULT_IMAGE_GOVERNANCE_CONFIG,
  ImageGenerationService,
} from "./image-generation-service.js";
import {
  ACTOR,
  createDependencies,
  query,
  generationRow,
} from "./image-generation-service-test-fakes.js";
function fixture() {
  const deps = createDependencies();
  const config: ImageGovernanceConfig = structuredClone(DEFAULT_IMAGE_GOVERNANCE_CONFIG);
  config.generalRouteMode = "semantic_auto";
  for (const route of config.routes) {
    route.enabled = true;
    route.backends = (["mcp_pixai", "mcp_openai", "mcp_gemini"] as const).map((backendId) => ({
      backendId,
      enabled: true,
      defaultPresetKey: `${backendId}-default`,
      allowedPresetKeys: [`${backendId}-default`],
    }));
  }
  const makeAdapter = (provider: ImageProviderRoute) => ({
    getCapabilities: vi.fn().mockResolvedValue({
      presetsRequired: false,
      connection: { defaultModel: "supplier-default", parameterNotes: "supports wide images" },
      dynamicParameters: ["size", "quality"],
    }),
    listPresets: vi
      .fn()
      .mockResolvedValue([
        { key: `${provider}-default`, name: provider, autoApproval: { eligible: true } },
      ]),
    prepareGeneration: vi
      .fn()
      .mockResolvedValue({ planId: `${provider}-plan`, approvalRequired: false, value: {} }),
    startGeneration: vi.fn().mockRejectedValue(new Error("defer")),
    getGenerationDetails: vi.fn(),
    waitForGeneration: vi.fn().mockRejectedValue(new Error("defer")),
  });
  const pixai = makeAdapter("mcp_pixai"),
    gpt = makeAdapter("mcp_openai"),
    gemini = makeAdapter("mcp_gemini");
  const rows: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn((projection?: Record<string, unknown>) =>
      projection && "config" in projection ? query([{ config }]) : query(rows),
    ),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        if ("provider" in value) rows.push({ ...generationRow(), ...value });
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          const row = rows.at(-1) ?? {};
          const next = { ...values };
          if (next.providerMetadata instanceof SQL) {
            const patch = new PgDialect().sqlToQuery(next.providerMetadata).params[0] as string;
            next.providerMetadata = { ...(row.providerMetadata as object), ...JSON.parse(patch) };
          }
          Object.assign(row, next);
        }),
      })),
    })),
  } as unknown as Database;
  const service = new ImageGenerationService({
    db,
    pixai: pixai as never,
    artifacts: deps.artifacts as never,
    usageGovernor: deps.usageGovernor as never,
    logger: deps.logger as never,
    backends: {
      mcp_openai: {
        adapter: gpt as never,
        artifacts: deps.artifacts as never,
        endpoint: "https://mcp.example.com/mcp/openai-image",
      },
      mcp_gemini: {
        adapter: gemini as never,
        artifacts: deps.artifacts as never,
        endpoint: "https://mcp.example.com/mcp/gemini-image",
      },
    },
  });
  return { service, config, deps, pixai, gpt, gemini, rows };
}
describe("independent image provider selection", () => {
  it("allows native providers without presets and forwards dynamic parameters", async () => {
    const { service, config, gpt, gemini, rows } = fixture();
    for (const route of config.routes)
      for (const binding of route.backends!) {
        delete binding.defaultPresetKey;
        binding.allowedPresetKeys = [];
      }
    gpt.listPresets.mockResolvedValue([]);
    gemini.listPresets.mockResolvedValue([]);
    await service.create(ACTOR, {
      purpose: "general_image",
      parameters: { model: "supplier-gpt", size: "2048x1152", quality: "high" },
      prompt: "wide cat",
    });
    expect(gpt.prepareGeneration).toHaveBeenCalledWith({
      prompt: "wide cat",
      model: "supplier-gpt",
      size: "2048x1152",
      quality: "high",
    });
    expect(rows[0]?.presetKey).toBeUndefined();
    await service.create(ACTOR, {
      purpose: "anime_illustration",
      backendId: "mcp_gemini",
      parameters: { aspectRatio: "16:9", imageSize: "2K" },
      prompt: "wide bird",
    });
    expect(gemini.prepareGeneration).toHaveBeenCalledWith({
      prompt: "wide bird",
      aspectRatio: "16:9",
      imageSize: "2K",
    });
    expect((await service.listRoutes(ACTOR))[0]?.backendCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backendId: "mcp_gemini",
          presetsRequired: false,
          connection: expect.objectContaining({ parameterNotes: "supports wide images" }),
        }),
      ]),
    );
  });
  it("rejects malformed and cross-protocol dynamic parameters before reserving usage", async () => {
    const { service, deps, gpt } = fixture();
    for (const parameters of [{ size: "broken" }, { aspectRatio: "16:9" }]) {
      expect(
        await service.create(ACTOR, { purpose: "general_image", prompt: "a cat", parameters }),
      ).toMatchObject({ accepted: false, reason: "invalid_request" });
    }
    expect(
      await service.create(ACTOR, {
        purpose: "anime_illustration",
        prompt: "a cat",
        parameters: { size: "2048x1152" },
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_request" });
    expect(deps.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(gpt.prepareGeneration).not.toHaveBeenCalled();
  });
  it("defaults anime to PixAI and general images to GPT with their own presets", async () => {
    const { service, pixai, gpt, gemini, rows } = fixture();
    await service.create(ACTOR, { purpose: "anime_illustration", prompt: "a cat" });
    await service.create(ACTOR, { purpose: "general_image", prompt: "a photo" });
    expect(pixai.prepareGeneration).toHaveBeenCalledWith({
      presetKey: "mcp_pixai-default",
      prompt: "a cat",
    });
    expect(gpt.prepareGeneration).toHaveBeenCalledWith({
      presetKey: "mcp_openai-default",
      prompt: "a photo",
    });
    expect(gemini.prepareGeneration).not.toHaveBeenCalled();
    expect(rows[1]?.providerMetadata).toMatchObject({
      backendId: "mcp_openai",
      endpoint: "https://mcp.example.com/mcp/openai-image",
      planId: "mcp_openai-plan",
    });
  });
  it("explicit Gemini and GPT override one request without modifying defaults", async () => {
    const { service, config, pixai, gpt, gemini } = fixture();
    await service.create(ACTOR, {
      purpose: "anime_illustration",
      backendId: "mcp_gemini",
      prompt: "a cat",
    });
    await service.create(ACTOR, {
      purpose: "anime_illustration",
      backendId: "mcp_openai",
      prompt: "a dog",
    });
    expect(gemini.prepareGeneration).toHaveBeenCalledWith({
      presetKey: "mcp_gemini-default",
      prompt: "a cat",
    });
    expect(gpt.prepareGeneration).toHaveBeenCalledWith({
      presetKey: "mcp_openai-default",
      prompt: "a dog",
    });
    expect(pixai.prepareGeneration).not.toHaveBeenCalled();
    expect(config.routes[0]?.defaultBackendId).toBe("mcp_pixai");
    await service.create(ACTOR, { purpose: "anime_illustration", prompt: "a bird" });
    expect(pixai.prepareGeneration).toHaveBeenCalledOnce();
  });
  it("rejects disabled providers, foreign presets, and unsupported controls before reservation", async () => {
    const { service, config, deps, gpt } = fixture();
    config.routes[0]!.backends!.find((row) => row.backendId === "mcp_openai")!.enabled = false;
    expect(
      await service.create(ACTOR, {
        purpose: "anime_illustration",
        backendId: "mcp_openai",
        prompt: "a cat",
      }),
    ).toMatchObject({ accepted: false, reason: "provider_unavailable" });
    expect(
      await service.create(ACTOR, {
        purpose: "general_image",
        backendId: "mcp_openai",
        prompt: "a cat",
        presetKey: "mcp_gemini-default",
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_request" });
    expect(
      await service.create(ACTOR, {
        purpose: "general_image",
        backendId: "mcp_openai",
        prompt: "a cat",
        seed: 42,
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_request" });
    expect(deps.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(gpt.prepareGeneration).not.toHaveBeenCalled();
  });
  it("exposes all available suppliers simultaneously and filters preset lists per provider", async () => {
    const { service } = fixture();
    const routes = await service.listRoutes(ACTOR, { includePresets: false });
    expect(routes[0]?.availableBackends).toEqual(["mcp_pixai", "mcp_openai", "mcp_gemini"]);
    expect(await service.listPresets(ACTOR, "anime_illustration", "mcp_gemini")).toEqual([
      expect.objectContaining({ key: "mcp_gemini-default", provider: "mcp_gemini" }),
    ]);
  });
  it("recovers the persisted provider even after the purpose default changes", async () => {
    const { service, config, gpt, gemini, pixai, rows } = fixture();
    rows.push(
      generationRow({
        provider: "mcp_gemini",
        providerMetadata: {
          backendId: "mcp_gemini",
          endpoint: "https://mcp.example.com/mcp/gemini-image",
          planId: "gemini-plan",
        },
        state: "queued",
      }),
    );
    config.routes[0]!.defaultBackendId = "mcp_openai";
    await service.recoverPending();
    expect(gemini.waitForGeneration).toHaveBeenCalledWith("operation-1", 10000);
    expect(gpt.waitForGeneration).not.toHaveBeenCalled();
    expect(pixai.waitForGeneration).not.toHaveBeenCalled();
  });
  it("freezes recovery if the original endpoint has been replaced", async () => {
    const { service, gpt, gemini, deps, rows } = fixture();
    rows.push(
      generationRow({
        provider: "mcp_gemini",
        providerMetadata: {
          endpoint: "https://old.example.com/mcp/gemini-image",
          planId: "gemini-plan",
        },
        state: "queued",
      }),
    );
    await service.recoverPending();
    expect(rows[0]).toMatchObject({
      state: "attention_required",
      errorCode: "ORIGINAL_CONNECTION_UNAVAILABLE",
    });
    expect(gemini.startGeneration).not.toHaveBeenCalled();
    expect(gemini.waitForGeneration).not.toHaveBeenCalled();
    expect(gpt.startGeneration).not.toHaveBeenCalled();
    expect(deps.usageGovernor.refund).not.toHaveBeenCalled();
  });
});
