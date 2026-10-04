import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { vi, type Mock } from "vitest";

/** Exercise the real SDK/adapter without a network request or a provider key. */
export function createOfflineProviderStream(options: {
  error: string | null;
  closeAfterError?: boolean;
  completedTool?: { name: string; input: Record<string, unknown> };
  textBeforeError?: string;
}): { model: LanguageModel; fetch: Mock<typeof globalThis.fetch>; onAbort: Mock<() => void> } {
  const onAbort = vi.fn();
  const encoder = new TextEncoder();
  let requestCount = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const completeTool = requestCount++ === 0 ? options.completedTool : undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (value: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        const chunk = (delta: unknown, finishReason: string | null = null) => ({
          id: "offline-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        if (completeTool) {
          emit(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "offline-tool-call",
                  type: "function",
                  function: {
                    name: completeTool.name,
                    arguments: JSON.stringify(completeTool.input),
                  },
                },
              ],
            }),
          );
          emit(chunk({}, "tool_calls"));
          controller.close();
          return;
        }
        if (options.textBeforeError) emit(chunk({ content: options.textBeforeError }));
        if (options.error) emit({ error: { message: options.error, type: "server_error" } });
        if (options.closeAfterError) {
          controller.close();
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            onAbort();
            controller.error(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  const model = createOpenAICompatible({
    name: "offline-test",
    baseURL: "https://offline.invalid/v1",
    fetch,
  }).chatModel("offline-model");
  return { model, fetch, onAbort };
}
