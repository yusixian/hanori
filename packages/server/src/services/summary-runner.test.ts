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

  it("splits a single oversized formatted message without losing its tail", () => {
    const chunks = chunkSummaryMessages(
      [
        {
          userName: "User",
          content: "very long content ".repeat(2_000) + "FINAL_TAIL",
          meta: null,
        },
      ],
      -100,
      100,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => countTokens(chunk) <= 100)).toBe(true);
    expect(chunks.join("")).toContain("FINAL_TAIL");
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

it("reduces multiple layers of long summaries while bounding every merge request", async () => {
  const calls: Array<{ tokens: number; cap: number }> = [];
  const result = await summarizeBoundedChunks(
    Array.from({ length: 6 }, (_, i) => `source-${i}`),
    "prompt",
    async (_system, content, cap) => {
      calls.push({ tokens: countTokens(content), cap });
      return "long ".repeat(Math.min(cap, 8000) - 100);
    },
  );
  expect(result).not.toBe("");
  expect(calls.length).toBe(9); // six source chunks, two intermediate merges, one final merge
  expect(calls.every((call) => call.tokens <= SUMMARY_INPUT_TOKEN_BUDGET)).toBe(true);
  expect(calls.slice(6, -1).every((call) => call.cap === 8192)).toBe(true);
  expect(calls.at(-1)?.cap).toBe(16000);
});
it("fails explicitly when model output cannot converge inside the merge budget", async () => {
  let calls = 0;
  await expect(
    summarizeBoundedChunks(["one", "two"], "prompt", async () => {
      calls++;
      return "long ".repeat(16000);
    }),
  ).rejects.toThrow("could not reduce");
  expect(calls).toBe(2);
});
