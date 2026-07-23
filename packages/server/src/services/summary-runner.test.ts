import { countTokens } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import {
  chunkSummaryMessages,
  newestRowsToChronological,
  SUMMARY_INPUT_TOKEN_BUDGET,
  summarizeBoundedChunks,
} from "./summary-runner.js";

describe("summary source selection", () => {
  it("restores newest-first limited rows to chronological order", () => {
    const newestLimitedRows = [
      { id: 2001, content: "newest" },
      { id: 2000, content: "middle" },
      { id: 1999, content: "oldest selected" },
    ];

    expect(newestRowsToChronological(newestLimitedRows).map((row) => row.id)).toEqual([
      1999, 2000, 2001,
    ]);
  });

  it("splits long windows into bounded chronological chunks", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      userName: `User ${index}`,
      content: `message-${index} ${"long content ".repeat(500)}`,
      meta: null,
    }));
    const chunks = chunkSummaryMessages(messages, -100, 2_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => countTokens(chunk) <= 2_000)).toBe(true);
    expect(chunks.join("\n")).toContain("message-0");
    expect(chunks.join("\n")).toContain("message-39");
  });

  it("bounds a single oversized formatted message", () => {
    const chunks = chunkSummaryMessages(
      [
        {
          userName: "User",
          content: "very long content ".repeat(2_000),
          meta: null,
        },
      ],
      -100,
      100,
    );

    expect(chunks).toHaveLength(1);
    expect(countTokens(chunks[0]!)).toBeLessThanOrEqual(100);
  });

  it("keeps the production input budget bounded", () => {
    expect(SUMMARY_INPUT_TOKEN_BUDGET).toBe(24_000);
  });

  it("summarizes every chunk and performs a final bounded merge", async () => {
    const calls: string[] = [];
    const callModel = async (_system: string, content: string) => {
      calls.push(content);
      return calls.length <= 2 ? `summary-${calls.length}` : "merged";
    };

    await expect(summarizeBoundedChunks(["chunk-a", "chunk-b"], "system", callModel)).resolves.toBe(
      "merged",
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("summary-1");
    expect(calls[2]).toContain("summary-2");
  });

  it("rejects the whole summary when any chunk fails", async () => {
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 2) throw new Error("chunk failed");
      return "partial";
    };

    await expect(
      summarizeBoundedChunks(["chunk-a", "chunk-b"], "system", callModel),
    ).rejects.toThrow("chunk failed");
  });
});
