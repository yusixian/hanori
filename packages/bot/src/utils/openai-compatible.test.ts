import { createServer } from "node:http";
import { once } from "node:events";
import { Agent, Dispatcher1Wrapper } from "undici";
import { stepCountIs, streamText, tool } from "ai";
import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStreamingUsageCompatibleFetch,
  createUsageAwareOpenAICompatible,
} from "./openai-compatible.js";

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

describe("model transport timeouts", () => {
  it("waits within the configured deadline after a completed tool without replaying it", async () => {
    let requests = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const defaultTransport = new Dispatcher1Wrapper(
      new Agent().compose(
        (dispatch) => (options, handler) => dispatch({ ...options, bodyTimeout: 40 }, handler),
      ),
    );
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta: unknown, finishReason: string | null = null) => {
        response.write(
          `data: ${JSON.stringify({
            id: "fixture-response",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      if (requests === 1) {
        emit({
          tool_calls: [
            {
              index: 0,
              id: "fixture-call",
              type: "function",
              function: { name: "read_transcript", arguments: "{}" },
            },
          ],
        });
        emit({}, "tool_calls");
        response.end("data: [DONE]\n\n");
      } else {
        emit({ role: "assistant" });
        timers.push(
          setTimeout(() => {
            emit({ content: "完整的视频总结" });
            emit({}, "stop");
            response.end("data: [DONE]\n\n");
          }, 1_500),
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const execute = vi.fn().mockResolvedValue({ text: "完整字幕" });
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const request = {
        ...init,
        dispatcher:
          (init as (RequestInit & { dispatcher?: Dispatcher1Wrapper }) | undefined)?.dispatcher ??
          defaultTransport,
      };
      return globalThis.fetch(input, request as unknown as RequestInit);
    };
    const provider = createUsageAwareOpenAICompatible({
      name: "fixture",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      fetch: fetchImpl,
    });
    try {
      const result = streamText({
        model: provider("fixture-model"),
        prompt: "总结视频",
        tools: { read_transcript: tool({ inputSchema: jsonSchema({ type: "object" }), execute }) },
        stopWhen: stepCountIs(2),
        abortSignal: AbortSignal.timeout(5_000),
      });
      let text = "";
      for await (const chunk of result.textStream) text += chunk;
      expect(text).toBe("完整的视频总结");
      expect(execute).toHaveBeenCalledOnce();
      expect(requests).toBe(2);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await defaultTransport.destroy();
    }
  });
});
