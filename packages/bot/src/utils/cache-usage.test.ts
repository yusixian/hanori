import { describe, expect, it } from "vitest";
import { extractCacheTokenUsage } from "./cache-usage.js";

describe("extractCacheTokenUsage", () => {
  it("keeps an explicitly reported zero as an observed cache miss", () => {
    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: { prompt_tokens_details: { cached_tokens: 0 } },
      }),
    ).toEqual({ cacheReadTokens: 0 });
  });

  it("treats an adapter default of zero without raw evidence as unknown", () => {
    expect(extractCacheTokenUsage({ inputTokenDetails: { cacheReadTokens: 0 } })).toEqual({});
  });

  it("keeps positive normalized cache usage when raw usage is unavailable", () => {
    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 128, cacheWriteTokens: 64 },
      }),
    ).toEqual({ cacheReadTokens: 128, cacheWriteTokens: 64 });
  });

  it("reads New API compatible cache read and write details from raw usage", () => {
    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: {
          prompt_tokens_details: {
            cached_tokens: 256,
            cache_write_tokens: 32,
          },
        },
      }),
    ).toEqual({ cacheReadTokens: 256, cacheWriteTokens: 32 });
  });

  it("aggregates raw cache usage across every model step", () => {
    expect(
      extractCacheTokenUsage({ inputTokenDetails: { cacheReadTokens: 384 } }, [
        { raw: { prompt_tokens_details: { cached_tokens: 128 } } },
        { raw: { prompt_tokens_details: { cached_tokens: 256 } } },
      ]),
    ).toEqual({ cacheReadTokens: 384 });
  });

  it("keeps multi-step cache usage unknown when any step omitted the field", () => {
    expect(
      extractCacheTokenUsage({ inputTokenDetails: { cacheReadTokens: 128 } }, [
        { raw: { prompt_tokens_details: { cached_tokens: 128 } } },
        { raw: {} },
      ]),
    ).toEqual({});
  });
});
