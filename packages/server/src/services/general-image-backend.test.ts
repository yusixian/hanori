import type { Database } from "@cos-tool-bot/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfiguredGeneralImageBackend } from "./general-image-backend.js";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

function imageConfigDb(imageGeneration: Record<string, unknown> | undefined) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(async () => [
      {
        aiConfig: {
          webToolsConfig: {
            imageGeneration,
          },
        },
      },
    ]),
  };
  return { select: vi.fn(() => builder) } as unknown as Database;
}

function configuredDb() {
  return imageConfigDb({
    provider: "openai",
    apiKey: "test-secret",
    baseURL: "https://images.example.com/v1",
    model: "gpt-image-test",
    size: "1024x1024",
  });
}

describe("BotConfiguredGeneralImageBackend artifact safety", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
  });

  it("reports whether the Bot has a non-PixAI general image backend", async () => {
    await expect(
      new BotConfiguredGeneralImageBackend(configuredDb()).isConfigured("configured-bot"),
    ).resolves.toBe(true);
    await expect(
      new BotConfiguredGeneralImageBackend(imageConfigDb(undefined)).isConfigured("missing-bot"),
    ).resolves.toBe(false);
    await expect(
      new BotConfiguredGeneralImageBackend(imageConfigDb({ provider: "pixai" })).isConfigured(
        "pixai-bot",
      ),
    ).resolves.toBe(false);
  });

  it("decodes an inline b64 artifact without making a second network request", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await new BotConfiguredGeneralImageBackend(configuredDb()).create({
      botId: "00000000-0000-4000-8000-000000000017",
      prompt: "a lighthouse",
    });

    expect(result).toEqual([{ bytes: png, mimeType: "image/png", source: "inline" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://images.example.com/v1/images/generations"),
    );
  });

  it("rejects an image URL resolving to a private address before downloading it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/artifact.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      new BotConfiguredGeneralImageBackend(configuredDb()).create({
        botId: "00000000-0000-4000-8000-000000000017",
        prompt: "a lighthouse",
      }),
    ).rejects.toThrow("resolves to a private address");

    expect(lookupMock).toHaveBeenCalledWith("cdn.example.test", {
      all: true,
      verbatim: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a hexadecimal IPv4-mapped private address", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/artifact.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    lookupMock.mockResolvedValue([{ address: "::ffff:a9fe:0101", family: 6 }]);

    await expect(
      new BotConfiguredGeneralImageBackend(configuredDb()).create({
        botId: "00000000-0000-4000-8000-000000000017",
        prompt: "a lighthouse",
      }),
    ).rejects.toThrow("resolves to a private address");
  });
});
