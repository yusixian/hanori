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

  it("extracts cache read and write details when raw usage preserves them", () => {
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

  it("uses DeepSeek cache hits after the existing raw field precedence", () => {
    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: {
          prompt_tokens_details: {
            cached_tokens: 256,
          },
          prompt_cache_hit_tokens: 512,
        },
      }),
    ).toEqual({ cacheReadTokens: 256 });

    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: { prompt_cache_hit_tokens: 512 },
      }),
    ).toEqual({ cacheReadTokens: 512 });

    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: {
          prompt_tokens_details: { cached_tokens: 0 },
          prompt_cache_hit_tokens: 512,
        },
      }),
    ).toEqual({ cacheReadTokens: 0 });

    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: { prompt_cache_hit_tokens: 0 },
      }),
    ).toEqual({ cacheReadTokens: 0 });
  });

  it("skips invalid cache fields and keeps read and write observations independent", () => {
    expect(
      extractCacheTokenUsage({
        raw: {
          prompt_tokens_details: {
            cached_tokens: -1,
            cache_write_tokens: "invalid",
          },
          prompt_cache_hit_tokens: 96,
          cache_write_input_tokens: 24,
        },
      }),
    ).toEqual({ cacheReadTokens: 96, cacheWriteTokens: 24 });

    expect(
      extractCacheTokenUsage({
        raw: { prompt_tokens_details: { cache_write_tokens: 0 } },
      }),
    ).toEqual({ cacheWriteTokens: 0 });

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "96"]) {
      expect(
        extractCacheTokenUsage({
          inputTokenDetails: { cacheReadTokens: 0 },
          raw: { prompt_cache_hit_tokens: invalid },
        }),
      ).toEqual({});
    }

    expect(
      extractCacheTokenUsage({
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: {},
      }),
    ).toEqual({});
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

  it("keeps an independently observed write total when a read field is missing", () => {
    expect(
      extractCacheTokenUsage({ inputTokenDetails: { cacheReadTokens: 0 } }, [
        { raw: { prompt_tokens_details: { cached_tokens: 128, cache_write_tokens: 32 } } },
        { raw: { prompt_tokens_details: { cache_write_tokens: 64 } } },
      ]),
    ).toEqual({ cacheWriteTokens: 96 });
  });

  it("aggregates observed zero and positive values across multiple steps", () => {
    expect(
      extractCacheTokenUsage({ inputTokenDetails: { cacheReadTokens: 0 } }, [
        { raw: { prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } },
        { raw: { prompt_tokens_details: { cached_tokens: 128, cache_write_tokens: 64 } } },
      ]),
    ).toEqual({ cacheReadTokens: 128, cacheWriteTokens: 64 });
  });

  it("keeps a fully observed multi-step miss distinct from unknown usage", () => {
    expect(
      extractCacheTokenUsage({}, [
        { raw: { prompt_tokens_details: { cached_tokens: 0 } } },
        { raw: { prompt_cache_hit_tokens: 0 } },
      ]),
    ).toEqual({ cacheReadTokens: 0 });
  });
});
