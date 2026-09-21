import type {
  ImageGenerationActor,
  ImageGenerationPort,
  ImageRouteCapabilities,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createImageGenerationTools } from "./image-generation.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

describe("create_image routing contract", () => {
  it("forwards the explicit routing intent without changing provider semantics", async () => {
    const actor: ImageGenerationActor = {
      botId: "00000000-0000-4000-8000-000000000017",
      chatId: -100,
      userId: 42,
      chatType: "supergroup",
      isBotAdmin: false,
      isDelegatedGroupAdmin: false,
    };
    const create = vi.fn().mockResolvedValue({ accepted: false, reason: "disabled" });
    const port = {
      create,
      listRoutes: vi.fn().mockResolvedValue([route("general_image", true)]),
      listPresets: vi.fn(),
      get: vi.fn(),
      findByDeliveryMessage: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ImageGenerationPort;
    const tools = await createImageGenerationTools({ port, getActor: () => actor });

    await (tools.create_image as Tool as unknown as ExecutableTool).execute(
      {
        purpose: "general_image",
        routingIntent: "explicit",
        prompt: "a realistic product photograph",
        presetKey: "general-default",
        seed: 7,
        materials: {
          characterIds: [12],
          personTelegramId: 42,
          assetIds: [9],
          excludedAssetIds: [10],
          skipPinned: true,
          skipDefaultOutfit: true,
          safetyMode: "safe",
        },
      },
      { abortSignal: new AbortController().signal },
    );

    expect(create).toHaveBeenCalledWith(actor, {
      purpose: "general_image",
      routingIntent: "explicit",
      prompt: "a realistic product photograph",
      materials: {
        characterIds: [12],
        personTelegramId: 42,
        assetIds: [9],
        excludedAssetIds: [10],
        skipPinned: true,
        skipDefaultOutfit: true,
        safetyMode: "safe",
      },
      presetKey: "general-default",
      seed: 7,
    });
  });

  it("exposes the full same-chat generation context for a replied delivery", async () => {
    const actor: ImageGenerationActor = {
      botId: "00000000-0000-4000-8000-000000000017",
      chatId: -100,
      userId: 99,
      chatType: "supergroup",
      isBotAdmin: false,
      isDelegatedGroupAdmin: false,
    };
    const findByDeliveryMessage = vi.fn().mockResolvedValue({
      id: "generation-1",
      prompt: "hakurei_reimu, shrine",
      negativePrompt: "low quality",
      seed: 42,
      providerDetails: { requestBody: { samplingSteps: 28 } },
    });
    const port = {
      findByDeliveryMessage,
      listRoutes: vi.fn().mockResolvedValue([]),
    } as unknown as ImageGenerationPort;
    const tools = await createImageGenerationTools({
      port,
      getActor: () => actor,
      replyMessageId: 7389,
    });

    await expect(
      (tools.inspect_replied_image_generation as Tool as unknown as ExecutableTool).execute(
        {},
        { abortSignal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      found: true,
      generation: { prompt: "hakurei_reimu, shrine", seed: 42 },
    });
    expect(findByDeliveryMessage).toHaveBeenCalledWith(actor, 7389);
  });
});

function route(
  purpose: ImageRouteCapabilities["purpose"],
  enabled: boolean,
): ImageRouteCapabilities {
  return {
    purpose,
    enabled,
    provider: purpose === "general_image" ? "general_backend" : "mcp_pixai",
    label: purpose,
    useWhen: "Generate an image",
    avoidWhen: "",
    examples: [],
    presets: [],
  };
}

const routingActor: ImageGenerationActor = {
  botId: "00000000-0000-4000-8000-000000000017",
  chatId: -100,
  userId: 42,
  chatType: "supergroup",
  isBotAdmin: false,
  isDelegatedGroupAdmin: false,
};

async function purposeChoices(tool: Tool) {
  const schema = tool.inputSchema as {
    jsonSchema: { properties: { purpose: { enum: string[] } } };
  };
  return (await schema.jsonSchema).properties.purpose.enum;
}

describe("available image routes", () => {
  it("excludes disabled general images from both creation and preset selection", async () => {
    const listRoutes = vi
      .fn()
      .mockResolvedValue([route("anime_illustration", true), route("general_image", false)]);
    const port = { listRoutes } as unknown as ImageGenerationPort;
    const tools = await createImageGenerationTools({ port, getActor: () => routingActor });

    expect(await purposeChoices(tools.create_image!)).toEqual(["anime_illustration"]);
    expect(await purposeChoices(tools.list_image_presets!)).toEqual(["anime_illustration"]);
    expect(listRoutes).toHaveBeenCalledWith(routingActor, { includePresets: false });
  });

  it("refreshes the allowed choices when configuration changes between turns", async () => {
    const listRoutes = vi
      .fn()
      .mockResolvedValueOnce([route("anime_illustration", true), route("general_image", true)])
      .mockResolvedValueOnce([route("anime_illustration", true), route("general_image", false)]);
    const port = { listRoutes } as unknown as ImageGenerationPort;
    const first = await createImageGenerationTools({ port, getActor: () => routingActor });
    const second = await createImageGenerationTools({ port, getActor: () => routingActor });

    expect(await purposeChoices(first.create_image!)).toEqual([
      "anime_illustration",
      "general_image",
    ]);
    expect(await purposeChoices(second.create_image!)).toEqual(["anime_illustration"]);
  });

  it("supports a general-only configuration without exposing the disabled anime route", async () => {
    const port = {
      listRoutes: vi
        .fn()
        .mockResolvedValue([route("anime_illustration", false), route("general_image", true)]),
    } as unknown as ImageGenerationPort;
    const tools = await createImageGenerationTools({ port, getActor: () => routingActor });
    expect(await purposeChoices(tools.create_image!)).toEqual(["general_image"]);
  });

  it("keeps task management but hides creation and presets when no routes are available", async () => {
    const port = {
      listRoutes: vi
        .fn()
        .mockResolvedValue([route("anime_illustration", false), route("general_image", false)]),
    } as unknown as ImageGenerationPort;
    const tools = await createImageGenerationTools({
      port,
      getActor: () => routingActor,
      replyMessageId: 12,
    });

    expect(tools.create_image).toBeUndefined();
    expect(tools.list_image_presets).toBeUndefined();
    expect(tools.get_image_generation).toBeDefined();
    expect(tools.cancel_image_generation).toBeDefined();
    expect(tools.inspect_replied_image_generation).toBeDefined();
  });
});
