import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { toToolLogValue, wrapToolsWithLogging } from "./tool-log.js";

it("marks denied image admissions as failed and correlates accepted tasks without exposing the prompt in diagnostics", async () => {
  const onDiagnostic = vi.fn();
  const tools = wrapToolsWithLogging(
    {
      create_image: {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ accepted: false, reason: "provider_unavailable" })
          .mockResolvedValueOnce({
            accepted: true,
            generation: {
              id: "generation-1",
              providerOperationId: "operation-1",
              deliveryState: "pending",
              prompt: "PRIVATE",
            },
          }),
      } as unknown as Tool,
    },
    { onDiagnostic },
  );
  await tools.create_image!.execute!({ prompt: "PRIVATE" }, { toolCallId: "call-1", messages: [] });
  expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "failed" }));
  await tools.create_image!.execute!({ prompt: "PRIVATE" }, { toolCallId: "call-2", messages: [] });
  expect(onDiagnostic).toHaveBeenLastCalledWith(
    expect.objectContaining({
      outcome: "succeeded",
      generationId: "generation-1",
      providerOperationId: "operation-1",
      deliveryState: "pending",
    }),
  );
  expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("PRIVATE");
});

describe("toToolLogValue", () => {
  it("summarizes inline media while preserving ordinary data fields", () => {
    expect(
      toToolLogValue({
        inlineData: { mimeType: "image/png", data: "aW1hZ2U=" },
        inline_data: { mime_type: "image/jpeg", data: "cGhvdG8=" },
        result: { data: "useful diagnostic text" },
      }),
    ).toEqual({
      inlineData: { mimeType: "image/png", data: "[binary inline data: 8 chars]" },
      inline_data: { mime_type: "image/jpeg", data: "[binary inline data: 8 chars]" },
      result: { data: "useful diagnostic text" },
    });
  });

  it("preserves tool queries and structured results", () => {
    expect(
      toToolLogValue({
        query: "博丽灵梦",
        limit: 8,
        result: { tags: [{ name: "hakurei_reimu", postCount: 42_000 }] },
      }),
    ).toEqual({
      query: "博丽灵梦",
      limit: 8,
      result: { tags: [{ name: "hakurei_reimu", postCount: 42_000 }] },
    });
  });

  it("redacts credential fields and bearer values", () => {
    expect(
      toToolLogValue({
        query: "safe",
        apiKey: "secret-key",
        nested: { authorization: "Bearer abc.def", cookie: "session=secret" },
        note: "request used Bearer visible-token",
      }),
    ).toEqual({
      query: "safe",
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
      note: "request used Bearer [REDACTED]",
    });
  });

  it("keeps diagnostic token counters", () => {
    expect(toToolLogValue({ maxTokens: 4096, tokenCount: 123 })).toEqual({
      maxTokens: 4096,
      tokenCount: 123,
    });
  });

  it("normalizes circular and binary values for JSON storage", () => {
    const value: Record<string, unknown> = { bytes: new Uint8Array(12) };
    value["self"] = value;

    expect(toToolLogValue(value)).toEqual({
      bytes: { type: "Uint8Array", byteLength: 12 },
      self: "[Circular]",
    });
  });
});

describe("unified search log privacy", () => {
  it("keeps ordinary queries but omits signed URLs, metadata, snippets and reference bodies", async () => {
    const { vi } = await import("vitest");
    const { wrapToolsWithLogging } = await import("./tool-log.js");
    const onLog = vi.fn();
    const signedUrl =
      "https://user:private-password@example.com/art?signature=private-signature#private-fragment";
    const tools = wrapToolsWithLogging(
      {
        search: {
          execute: async () => ({
            status: "ok",
            page: 1,
            limit: 1,
            hasMore: false,
            items: [
              {
                id: signedUrl,
                url: signedUrl,
                summary: "private search summary",
                fields: { notes: "private notes" },
                reference: "opaque-reference",
              },
            ],
          }),
        },
        read_reference: {
          execute: async () => ({
            status: "ok",
            reference: "opaque-reference",
            offset: 0,
            hasMore: false,
            source: signedUrl,
            id: signedUrl,
            provider: "builtin.web",
            content: "private reference body",
          }),
        },
      } as unknown as Record<string, import("ai").Tool>,
      { onLog },
    );
    const options = { toolCallId: "test", messages: [] };
    const result = await tools.search!.execute!(
      { scope: "web", query: "Exact_TAG ordinary query" } as never,
      options,
    );
    expect(result).toMatchObject({ status: "ok" });
    await tools.search!.execute!({ scope: "artwork", query: signedUrl } as never, options);
    await expect(
      tools.read_reference!.execute!({ reference: "opaque-reference" } as never, options),
    ).resolves.toMatchObject({ content: "private reference body" });
    const logs = JSON.stringify(onLog.mock.calls);
    expect(logs).toContain("Exact_TAG ordinary query");
    expect(logs).toContain("https://example.com/art");
    expect(logs).toContain("opaque-reference");
    expect(logs).toContain("contentLength");
    for (const value of [
      "private-password",
      "private-signature",
      "private-fragment",
      "private reference body",
      "private search summary",
      "private notes",
    ])
      expect(logs).not.toContain(value);
  });

  it("marks failed search statuses as failed in logs and diagnostics", async () => {
    const { vi } = await import("vitest");
    const { wrapToolsWithLogging } = await import("./tool-log.js");
    const onLog = vi.fn();
    const onDiagnostic = vi.fn();
    const tools = wrapToolsWithLogging(
      {
        search: {
          execute: async () => ({
            status: "forbidden",
            items: [],
            page: 1,
            limit: 1,
            hasMore: false,
          }),
        },
      } as unknown as Record<string, import("ai").Tool>,
      { onLog, onDiagnostic },
    );
    await tools.search!.execute!({ scope: "github", query: "hello" } as never, {
      toolCallId: "test",
      messages: [],
    });
    expect(onLog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          success: false,
          output: expect.objectContaining({ status: "forbidden", itemCount: 0 }),
        }),
      }),
    );
    expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "failed" }));
  });
});

describe("durable GitHub proposal log privacy", () => {
  it("logs bounded metadata while leaving private tool inputs/results available to the authorized call", async () => {
    const { vi } = await import("vitest");
    const { wrapToolsWithLogging } = await import("./tool-log.js");
    const onLog = vi.fn();
    const output = {
      proposals: [
        {
          id: "a".repeat(24),
          title: "private title",
          body: "private body",
          diagnostic: "private diagnostic",
        },
      ],
      cards_sent: 1,
    };
    const tools = wrapToolsWithLogging(
      {
        github_create_issue: {
          execute: async () => ({
            pending_confirmation: true,
            action_id: "a".repeat(24),
            description: "private title",
            error: "private diagnostic",
          }),
        },
        github_pending_issue_proposals: { execute: async () => output },
        github_cancel_issue_proposal: {
          execute: async () => {
            throw new Error("private diagnostic and private body");
          },
        },
      } as unknown as Record<string, import("ai").Tool>,
      { onLog },
    );
    const options = { toolCallId: "call", messages: [] };
    await tools.github_create_issue!.execute!(
      { title: "private title", body: "private body" } as never,
      options,
    );
    expect(await tools.github_pending_issue_proposals!.execute!({} as never, options)).toBe(output);
    await expect(
      tools.github_cancel_issue_proposal!.execute!(
        { proposal_id: "a".repeat(24) } as never,
        options,
      ),
    ).rejects.toThrow("private diagnostic");
    const logs = JSON.stringify(onLog.mock.calls);
    expect(logs).not.toMatch(/private title|private body|private diagnostic/);
    expect(logs).toContain('"bodyLength":12');
    expect(logs).toContain('"proposalCount":1');
    expect(logs).toContain('"privateOutput":true');
  });
});
