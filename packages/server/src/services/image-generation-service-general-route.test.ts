import type { Database } from "@cos-tool-bot/database";
import type { GeneralImageRouteMode, ImageGenerationAdmission } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_GOVERNANCE_CONFIG,
  ImageGenerationService,
} from "./image-generation-service.js";
import {
  ACTOR,
  createDependencies,
  generationRow,
  query,
} from "./image-generation-service-test-fakes.js";

function outcome(admission: ImageGenerationAdmission) {
  return admission.accepted ? "accepted" : admission.reason;
}

function createService(
  routeEnabled: boolean,
  mode: GeneralImageRouteMode,
  backendConfigured: boolean,
) {
  const dependencies = createDependencies();
  const config = structuredClone(DEFAULT_IMAGE_GOVERNANCE_CONFIG);
  config.generalRouteMode = mode;
  config.routes.find((route) => route.purpose === "general_image")!.enabled = routeEnabled;
  const generation = generationRow({
    provider: "general_backend",
    purpose: "general_image",
    presetKey: "general-default",
    state: "preparing",
  });
  const db = {
    select: vi.fn((projection?: Record<string, unknown>) =>
      projection && "config" in projection ? query([{ config }]) : query([generation]),
    ),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })),
  } as unknown as Database;
  const generalBackend = {
    isConfigured: vi.fn().mockResolvedValue(backendConfigured),
    create: vi.fn(),
  };
  const service = new ImageGenerationService({
    db,
    usageGovernor: dependencies.usageGovernor as never,
    pixai: dependencies.pixai as never,
    artifacts: dependencies.artifacts as never,
    generalBackend,
    logger: dependencies.logger as never,
  });
  return { service, isConfigured: generalBackend.isConfigured };
}

describe("general image route availability", () => {
  it.each<
    [
      routeEnabled: boolean,
      mode: GeneralImageRouteMode,
      backendConfigured: boolean,
      available: boolean,
      lookupsPerCall: number,
      semanticCreate: ReturnType<typeof outcome>,
    ]
  >([
    [true, "off", true, false, 0, "disabled"],
    [true, "off", false, false, 0, "disabled"],
    [true, "explicit_only", true, true, 1, "not_allowed"],
    [true, "explicit_only", false, false, 1, "disabled"],
    [true, "semantic_auto", true, true, 1, "accepted"],
    [true, "semantic_auto", false, false, 1, "disabled"],
    [false, "off", true, false, 0, "disabled"],
    [false, "off", false, false, 0, "disabled"],
    [false, "explicit_only", true, false, 0, "disabled"],
    [false, "explicit_only", false, false, 0, "disabled"],
    [false, "semantic_auto", true, false, 0, "disabled"],
    [false, "semantic_auto", false, false, 0, "disabled"],
  ])(
    "agrees across listRoutes, listPresets and create (route enabled: %s, mode: %s, backend configured: %s)",
    async (routeEnabled, mode, backendConfigured, available, lookupsPerCall, semanticCreate) => {
      const { service, isConfigured } = createService(routeEnabled, mode, backendConfigured);
      const backendLookups: number[] = [];
      const run = async <T>(operation: () => Promise<T>) => {
        isConfigured.mockClear();
        const result = await operation();
        backendLookups.push(isConfigured.mock.calls.length);
        return result;
      };

      const routes = await run(() => service.listRoutes(ACTOR, { includePresets: false }));
      const presets = await run(() => service.listPresets(ACTOR, "general_image"));
      const explicit = await run(() =>
        service.create(ACTOR, {
          purpose: "general_image",
          routingIntent: "explicit",
          prompt: "a lighthouse",
        }),
      );
      const semantic = await run(() =>
        service.create(ACTOR, {
          purpose: "general_image",
          routingIntent: "semantic",
          prompt: "a lighthouse",
        }),
      );
      await run(() =>
        service.create(ACTOR, {
          purpose: "anime_illustration",
          prompt: "a lighthouse",
          presetKey: "unlisted",
        }),
      );

      expect({
        listRoutes: routes.find((route) => route.purpose === "general_image")?.enabled,
        listPresets: presets.some((preset) => preset.key === "general-default"),
        explicitCreate: outcome(explicit),
        semanticCreate: outcome(semantic),
        backendLookups,
      }).toEqual({
        listRoutes: available,
        listPresets: available,
        explicitCreate: available ? "accepted" : "disabled",
        semanticCreate,
        backendLookups: [lookupsPerCall, lookupsPerCall, lookupsPerCall, lookupsPerCall, 0],
      });
    },
  );
});
