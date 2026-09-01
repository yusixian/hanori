import type { ImageGenerationActor, ImageGenerationPort } from "@cos-tool-bot/shared";
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
      listRoutes: vi.fn(),
      listPresets: vi.fn(),
      get: vi.fn(),
      findByDeliveryMessage: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ImageGenerationPort;
    const tools = createImageGenerationTools({ port, getActor: () => actor });

    await (tools.create_image as Tool as unknown as ExecutableTool).execute(
      {
        purpose: "general_image",
        routingIntent: "explicit",
        prompt: "a realistic product photograph",
        presetKey: "general-default",
        seed: 7,
      },
      { abortSignal: new AbortController().signal },
    );

    expect(create).toHaveBeenCalledWith(actor, {
      purpose: "general_image",
      routingIntent: "explicit",
      prompt: "a realistic product photograph",
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
    const port = { findByDeliveryMessage } as unknown as ImageGenerationPort;
    const tools = createImageGenerationTools({
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
