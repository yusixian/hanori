import { describe, expect, it } from "vitest";
import { buildCacheMetrics } from "./usage.js";

describe("buildCacheMetrics", () => {
  it("calculates token, request, and observation rates with separate denominators", () => {
    expect(
      buildCacheMetrics({
        requestCount: 10,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        cacheObservedRequestCount: 8,
        cacheWriteObservedRequestCount: 4,
        cacheHitRequestCount: 6,
        cacheObservedPromptTokens: 1_000,
      }),
    ).toEqual({
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      cacheObservedRequestCount: 8,
      cacheWriteObservedRequestCount: 4,
      cacheHitRequestCount: 6,
      cacheObservationRate: 0.8,
      cacheTokenHitRate: 0.8,
      cacheRequestHitRate: 0.75,
    });
  });

  it("returns unknown rates when no request exposed cache usage", () => {
    expect(
      buildCacheMetrics({
        requestCount: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheObservedRequestCount: 0,
        cacheWriteObservedRequestCount: 0,
        cacheHitRequestCount: 0,
        cacheObservedPromptTokens: 0,
      }),
    ).toMatchObject({
      cacheObservationRate: 0,
      cacheTokenHitRate: null,
      cacheRequestHitRate: null,
    });
  });

  it("keeps an observed miss distinct from missing data", () => {
    expect(
      buildCacheMetrics({
        requestCount: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheObservedRequestCount: 1,
        cacheWriteObservedRequestCount: 0,
        cacheHitRequestCount: 0,
        cacheObservedPromptTokens: 500,
      }),
    ).toMatchObject({
      cacheObservationRate: 1,
      cacheTokenHitRate: 0,
      cacheRequestHitRate: 0,
    });
  });
});
