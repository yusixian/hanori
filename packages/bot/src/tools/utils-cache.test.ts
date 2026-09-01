import type { Tool } from "ai";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRequestCache, wrapToolsWithCache, zodToAiSchema } from "./utils.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

describe("wrapToolsWithCache", () => {
  it("allows the enlarged delegation budget and blocks the next call", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = wrapToolsWithCache(
      {
        delegate_task: tool({
          description: "delegate",
          inputSchema: zodToAiSchema(z.object({})),
          execute,
        }),
      },
      createRequestCache(),
    );
    const delegate = tools.delegate_task as Tool as unknown as ExecutableTool;
    const options = { abortSignal: new AbortController().signal };

    for (let index = 0; index < 64; index++) await delegate.execute({}, options);
    await expect(delegate.execute({}, options)).resolves.toMatchObject({ blocked: true });
    expect(execute).toHaveBeenCalledTimes(64);
  });
});
