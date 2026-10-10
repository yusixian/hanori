import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { DbLogger } from "./db-logger.js";

function pinoMock() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("DbLogger", () => {
  it("persists and emits the same redacted structured diagnostic", async () => {
    const values = vi.fn(async () => undefined);
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Database;
    const pino = pinoMock();
    const error = Object.assign(new Error("Bearer live.secret"), {
      statusCode: 401,
      name: "Provider token=synthetic-token",
      apiKey: "live-key",
    });

    await new DbLogger(db, pino, "00000000-0000-4000-8000-000000000001").error(
      "request token=live-token failed",
      { error, inputTokens: 42, payload: Buffer.from("binary") },
    );

    const expectedMessage = "request token=[REDACTED] failed";
    const expectedMeta = {
      error: expect.objectContaining({
        name: "Provider token=[REDACTED]",
        message: "Bearer [REDACTED]",
        stack: expect.stringContaining("Bearer [REDACTED]"),
        statusCode: 401,
        apiKey: "[REDACTED]",
      }),
      inputTokens: 42,
      payload: { type: "Buffer", byteLength: 6 },
    };
    expect(pino.error).toHaveBeenCalledWith(expectedMeta, expectedMessage);
    expect(values).toHaveBeenCalledWith({
      level: "error",
      message: expectedMessage,
      meta: expectedMeta,
      botId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("redacts the database failure before writing it to stderr", async () => {
    const dbError = new Error("Bearer database.secret");
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw dbError;
        }),
      })),
    } as unknown as Database;
    const pino = pinoMock();

    await new DbLogger(db, pino).info("safe");

    expect(pino.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Bearer [REDACTED]" }),
      "Failed to write log to database",
    );
  });
});
