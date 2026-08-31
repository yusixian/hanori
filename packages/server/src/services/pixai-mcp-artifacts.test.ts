import { describe, expect, it, vi } from "vitest";
import { PixaiMcpArtifactError, PixaiMcpArtifactReader } from "./pixai-mcp-artifacts.js";

const artifactUrl = "https://mcp.aistine.com/api/artifacts/11111111-1111-4111-8111-111111111111";

function reader(fetchFn: typeof fetch, maxBytes = 1024) {
  return new PixaiMcpArtifactReader({
    endpoint: "https://mcp.aistine.com/mcp/pixai",
    authProvider: {
      tokens: async () => ({ access_token: "access-secret", token_type: "Bearer" }),
    },
    fetch: fetchFn,
    maxBytes,
  });
}

describe("PixaiMcpArtifactReader", () => {
  it("decodes bounded inline image data", () => {
    const result = reader(vi.fn()).readInline({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/webp",
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    expect(result).toMatchObject({ mimeType: "image/webp", source: "inline" });
  });

  it("rejects cross-origin, query-bearing, and non-artifact links before fetching", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const artifactReader = reader(fetchFn);
    const invalidUris = [
      "https://evil.example/api/artifacts/11111111-1111-4111-8111-111111111111",
      `${artifactUrl}?download=1`,
      "https://mcp.aistine.com/api/artifacts/not-a-uuid",
    ];
    for (const uri of invalidUris) {
      await expect(
        artifactReader.download({ type: "resource_link", uri, name: "result" }),
      ).rejects.toEqual(new PixaiMcpArtifactError("INVALID_URI"));
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow a cross-origin redirect or expose the bearer token in errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://evil.example/api/artifacts/22222222-2222-4222-8222-222222222222",
        },
      }),
    );
    const artifactReader = reader(fetchFn);

    await expect(
      artifactReader.download({ type: "resource_link", uri: artifactUrl, name: "result" }),
    ).rejects.toEqual(new PixaiMcpArtifactError("INVALID_URI"));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0]?.[1]?.headers)).not.toContain("access-secret");
  });

  it("enforces response MIME and streaming size limits", async () => {
    const wrongMime = reader(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("hello", { headers: { "content-type": "text/plain" } })),
    );
    await expect(
      wrongMime.download({ type: "resource_link", uri: artifactUrl, name: "result" }),
    ).rejects.toEqual(new PixaiMcpArtifactError("UNSUPPORTED_MIME_TYPE"));

    const oversized = reader(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/png" },
        }),
      ),
      3,
    );
    await expect(
      oversized.download({ type: "resource_link", uri: artifactUrl, name: "result" }),
    ).rejects.toEqual(new PixaiMcpArtifactError("TOO_LARGE"));
  });

  it("sanitizes credential-store failures", async () => {
    const artifactReader = new PixaiMcpArtifactReader({
      endpoint: "https://mcp.aistine.com/mcp/pixai",
      authProvider: {
        tokens: async () => {
          throw new Error("access-secret refresh-secret");
        },
      },
      fetch: vi.fn(),
    });

    await expect(
      artifactReader.download({ type: "resource_link", uri: artifactUrl, name: "result" }),
    ).rejects.toEqual(new PixaiMcpArtifactError("AUTHORIZATION_REQUIRED"));
    await expect(
      artifactReader.download({ type: "resource_link", uri: artifactUrl, name: "result" }),
    ).rejects.not.toThrow(/secret/);
  });
});
