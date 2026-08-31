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
});
