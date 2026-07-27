import { describe, expect, it } from "vitest";
import { sanitizeOcrErrorForLog } from "./image-ocr.js";

describe("sanitizeOcrErrorForLog", () => {
  it("projects provider errors without persisting response payloads or recursive causes", () => {
    const responseSentinel = "SENSITIVE_RESPONSE_BODY";
    const dataSentinel = "SENSITIVE_REQUEST_DATA";
    const causeSentinel = "SENSITIVE_CAUSE";
    const providerError = Object.assign(new Error("SENSITIVE_TOP_LEVEL_MESSAGE"), {
      statusCode: 429,
      isRetryable: true,
      responseBody: responseSentinel,
      data: { prompt: dataSentinel },
      reason: "SENSITIVE_REASON",
      responseHeaders: { authorization: "SENSITIVE_HEADER" },
      cause: new Error(causeSentinel),
    });

    const projected = sanitizeOcrErrorForLog(providerError);
    const persistedLog = JSON.stringify(projected);

    for (const sentinel of [
      responseSentinel,
      dataSentinel,
      causeSentinel,
      "SENSITIVE_TOP_LEVEL_MESSAGE",
      "SENSITIVE_REASON",
      "SENSITIVE_HEADER",
    ]) {
      expect(persistedLog).not.toContain(sentinel);
    }
    expect(projected).toEqual({
      errorType: "object",
      name: "Error",
      messageLength: "SENSITIVE_TOP_LEVEL_MESSAGE".length,
      statusCode: 429,
      isRetryable: true,
      responseBodyType: "string",
      responseBodyLength: responseSentinel.length,
      dataType: "object",
      dataLength: JSON.stringify({ prompt: dataSentinel }).length,
      reasonType: "string",
      reasonLength: "SENSITIVE_REASON".length,
      causeType: "object",
      causeName: "Error",
      causeMessageLength: causeSentinel.length,
    });
  });

  it("never falls back to serializing unknown values", () => {
    expect(sanitizeOcrErrorForLog("SENSITIVE_PRIMITIVE")).toEqual({ errorType: "string" });
    expect(sanitizeOcrErrorForLog(null)).toEqual({ errorType: "null" });
  });
});
