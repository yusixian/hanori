import { describe, expect, it, vi } from "vitest";
import { createStreamingUsageCompatibleFetch } from "./openai-compatible.js";

const requestInit: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "example-model",
    stream: true,
    stream_options: { include_usage: true },
  }),
};

function requestBody(fetchMock: ReturnType<typeof vi.fn>, call: number) {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("createStreamingUsageCompatibleFetch", () => {
  it("retries without streaming usage and remembers an incompatible endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "unknown field stream_options" } }), {
          status: 400,
        }),
      )
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const compatibleFetch = createStreamingUsageCompatibleFetch(fetchMock);

    await expect(
      compatibleFetch("https://provider.example/v1/chat/completions", requestInit),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      compatibleFetch("https://provider.example/v1/chat/completions", requestInit),
    ).resolves.toMatchObject({ status: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock, 0)).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(requestBody(fetchMock, 1)).not.toHaveProperty("stream_options");
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("stream_options");
  });

  it("does not retry unrelated provider errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 400 }),
      );
    const compatibleFetch = createStreamingUsageCompatibleFetch(fetchMock);

    const response = await compatibleFetch(
      "https://provider.example/v1/chat/completions",
      requestInit,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves other stream options during fallback", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "include_usage is unsupported" } }), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const compatibleFetch = createStreamingUsageCompatibleFetch(fetchMock);

    await compatibleFetch("https://provider.example/v1/chat/completions", {
      ...requestInit,
      body: JSON.stringify({
        model: "example-model",
        stream: true,
        stream_options: { include_usage: true, custom_option: "keep" },
      }),
    });

    expect(requestBody(fetchMock, 1)).toMatchObject({
      stream_options: { custom_option: "keep" },
    });
  });
});
