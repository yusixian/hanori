import { describe, expect, it } from "vitest";
import { repoPolicySchema } from "./config/schema.js";
import {
  detectTestWeakening,
  evaluateContract,
  extractFirstImage,
  hasSection,
  summarizeChecks,
} from "./contract.js";

const policy = repoPolicySchema.parse({ contract: { uiPaths: ["src/**/*.tsx"] } });
const green = summarizeChecks(
  [{ id: 1, name: "ci", status: "completed", conclusion: "success" }],
  [],
);

describe("summarizeChecks", () => {
  it("keeps only the newest run per name", () => {
    const summary = summarizeChecks(
      [
        { id: 1, name: "test", status: "completed", conclusion: "failure" },
        { id: 2, name: "test", status: "completed", conclusion: "success" },
        { id: 3, name: "lint", status: "completed", conclusion: "skipped" },
      ],
      [],
    );
    expect(summary).toMatchObject({ state: "success", total: 2, passed: 2, failed: 0 });
  });

  it("reports failure before pending", () => {
    const summary = summarizeChecks(
      [
        { id: 1, name: "a", status: "in_progress", conclusion: null },
        { id: 2, name: "b", status: "completed", conclusion: "timed_out" },
      ],
      [{ context: "deploy", state: "pending" }],
    );
    expect(summary.state).toBe("failure");
    expect(summary.failedNames).toEqual(["b"]);
  });

  it("treats missing required checks as pending", () => {
    const summary = summarizeChecks(
      [{ id: 1, name: "lint", status: "completed", conclusion: "success" }],
      [],
      ["lint", "test"],
    );
    expect(summary.state).toBe("pending");
    expect(summary.missingRequired).toEqual(["test"]);
  });

  it("returns none when nothing reported", () => {
    expect(summarizeChecks([], []).state).toBe("none");
  });
});

describe("PR body parsing", () => {
  it("extracts the first markdown or HTML image", () => {
    expect(
      extractFirstImage(
        'text\n<img width="300" src="https://example.com/b.png">\n![shot](https://example.com/a.png)',
      ),
    ).toBe("https://example.com/b.png");
    expect(extractFirstImage('![a](https://example.com/a.png "title")')).toBe(
      "https://example.com/a.png",
    );
    expect(extractFirstImage("![a](http://insecure.example/a.png)")).toBeNull();
    expect(extractFirstImage(null)).toBeNull();
  });

  it("finds sections by heading or bold line in either language", () => {
    const body = "## Summary\n\n### 验证\n- ok\n\n**Review:**\ndone";
    expect(hasSection(body, "verify")).toBe(true);
    expect(hasSection(body, "review")).toBe(true);
    expect(hasSection("## Verification", "verify")).toBe(true);
    expect(hasSection("verify the thing", "verify")).toBe(false);
  });
});

describe("evaluateContract", () => {
  it("lists missing sections and screenshots for UI changes", () => {
    const result = evaluateContract({
      policy,
      body: "## Summary",
      files: [{ filename: "src/App.tsx", status: "modified" }],
      checks: green,
      bodyEditedAt: null,
      lastPushAt: null,
    });
    expect(result.touchesUi).toBe(true);
    expect(result.missing).toEqual(["PR 描述缺少「验证」「审查」", "改到 UI 但没有截图"]);
    expect(result.items.find((item) => item.key === "ci")!.ok).toBe(true);
    const fragment = result.items.find((item) => item.key === "releaseFragment");
    expect(fragment).toMatchObject({ ok: false, blocking: false });
  });

  it("is satisfied by a complete body", () => {
    const result = evaluateContract({
      policy,
      body: "## 验证\nok\n## 审查\nok\n![s](https://example.com/s.png)",
      files: [
        { filename: "src/App.tsx", status: "modified" },
        { filename: ".release/changes/save.md", status: "added" },
      ],
      checks: green,
      bodyEditedAt: null,
      lastPushAt: null,
    });
    expect(result.missing).toEqual([]);
    expect(result.items.every((item) => item.ok)).toBe(true);
  });

  it("flags evidence that predates the latest push", () => {
    const result = evaluateContract({
      policy,
      body: "## 验证\nok",
      files: [],
      checks: green,
      bodyEditedAt: new Date("2026-09-24T10:00:00Z"),
      lastPushAt: new Date("2026-09-24T11:00:00Z"),
    });
    expect(result.flags).toContain("证据之后又有新提交");
  });

  it("detects deleted tests and new skips", () => {
    expect(
      detectTestWeakening([
        { filename: "src/a.test.ts", status: "removed" },
        { filename: "src/b.ts", status: "modified", patch: "@@\n+  it.skip('x', () => {})" },
        { filename: "src/c.ts", status: "modified", patch: "@@\n-  it.skip('x', () => {})" },
      ]),
    ).toEqual(["删除了测试 src/a.test.ts", "src/b.ts 新增了 skip"]);
  });
});
