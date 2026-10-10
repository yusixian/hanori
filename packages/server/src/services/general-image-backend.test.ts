import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { Database } from "@cos-tool-bot/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotConfiguredGeneralImageBackend } from "./general-image-backend.js";

const { lookupMock, requestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("node:https", () => ({ request: requestMock }));

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
    requestMock.mockReset();
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

function artifactResponse(statusCode: number, headers: IncomingMessage["headers"]) {
  return Object.assign(new PassThrough(), { statusCode, headers });
}

it.each([
  [503, {}, "HTTP 503"],
  [200, { "content-type": "text/html" }, "not a supported image"],
  [200, { "content-type": "image/png", "content-length": "invalid" }, "invalid content length"],
  [
    200,
    { "content-type": "image/png", "content-length": String(20 * 1024 * 1024 + 1) },
    "too large",
  ],
  [302, {}, "redirect is invalid"],
] as const)(
  "closes rejected artifact response %s without draining its body",
  async (status, headers, error) => {
    const response = artifactResponse(status, headers);
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    requestMock.mockImplementation((_options, callback) =>
      Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => callback(response)),
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
    );
    try {
      await expect(
        new BotConfiguredGeneralImageBackend(configuredDb()).create({
          botId: "bot",
          prompt: "image",
        }),
      ).rejects.toThrow(error);
      expect(response.destroyed).toBe(true);
    } finally {
      response.destroy();
      vi.restoreAllMocks();
    }
  },
);

it("closes redirect bodies before following and still validates the downloaded image", async () => {
  const redirect = artifactResponse(302, { location: "/final.png" });
  const image = artifactResponse(200, { "content-type": "image/png" });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const responses = [redirect, image];
  lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  requestMock.mockImplementation((_options, callback) => {
    if (responses[0] === image) expect(redirect.destroyed).toBe(true);
    return Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() => {
          const response = responses.shift();
          callback(response);
          if (response === image) image.end(png);
        }),
    });
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
  );
  try {
    await expect(
      new BotConfiguredGeneralImageBackend(configuredDb()).create({
        botId: "bot",
        prompt: "image",
      }),
    ).resolves.toEqual([{ bytes: png, mimeType: "image/png", source: "resource_link" }]);
    expect(redirect.destroyed).toBe(true);
    expect(image.destroyed).toBe(true);
  } finally {
    redirect.destroy();
    image.destroy();
    vi.restoreAllMocks();
  }
});

it("cancels an artifact download while DNS is pending without issuing HTTPS", async () => {
  const controller = new AbortController();
  const reason = new Error("image task stopped");
  let finishLookup!: (value: unknown[]) => void;
  lookupMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
  );
  requestMock.mockClear();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: [{ url: "https://cdn.example.test/image.png" }] }),
  );
  const task = new BotConfiguredGeneralImageBackend(configuredDb())
    .create({
      botId: "bot",
      prompt: "image",
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf("function"));
    controller.abort(reason);
    const result = await Promise.race([
      task,
      new Promise((resolve) => setTimeout(() => resolve("still waiting for DNS"), 50)),
    ]);
    expect(result).toBe(reason);
    expect(requestMock).not.toHaveBeenCalled();
  } finally {
    finishLookup([]);
    await task;
    vi.restoreAllMocks();
  }
});
