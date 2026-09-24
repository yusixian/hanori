import { describe, expect, it } from "vitest";
import { decodeCallback } from "./approvals.js";
import { summarizeChecks } from "./contract.js";
import {
  cardHash,
  determinePrStatus,
  renderPrCard,
  renderPrDetails,
  type PrCardInput,
} from "./pr-card.js";

const APPROVAL = "AbCdEfGhIjKlMnOpQrStUv";

function input(overrides: Partial<PrCardInput> = {}): PrCardInput {
  return {
    repo: "example-owner/koyori",
    number: 124,
    title: "fix(settings): <save> progress",
    url: "https://github.com/example-owner/koyori/pull/124",
    author: "octocat",
    state: "open",
    merged: false,
    draft: false,
    tier: "T1",
    summary: "网络慢时保存按钮显示「保存中」",
    checks: summarizeChecks(
      [{ id: 1, name: "ci", status: "completed", conclusion: "success" }],
      [],
    ),
    contract: { items: [], missing: [], flags: [], touchesUi: false, hasImage: false },
    approvalId: APPROVAL,
    detailsViewed: false,
    imageUrl: null,
    ...overrides,
  };
}

const buttonTexts = (card: ReturnType<typeof renderPrCard>) =>
  card.keyboard.flat().map((button) => button.text);

describe("renderPrCard", () => {
  it("renders a ready card with escaped text and merge controls", () => {
    const card = renderPrCard(input());
    expect(card.html.split("\n")).toEqual([
      "<b>🟢 可以合并 · PR #124 · T1</b>",
      "fix(settings): &lt;save&gt; progress",
      "改了什么：网络慢时保存按钮显示「保存中」",
      "CI：✅ 1/1 通过",
      '<a href="https://github.com/example-owner/koyori/pull/124">example-owner/koyori#124</a> · @octocat',
    ]);
    expect(buttonTexts(card)).toEqual(["✅ 合并", "🔍 详情", "🔗 PR", "🔄 刷新"]);
    const merge = card.keyboard[0]![0]!.callbackData!;
    expect(merge.length).toBeLessThanOrEqual(64);
    expect(decodeCallback(merge)).toEqual({ approvalId: APPROVAL, verb: "merge" });
  });

  it("shows missing contract items and warnings", () => {
    const card = renderPrCard(
      input({
        contract: {
          items: [],
          missing: ["PR 描述缺少「验证」", "改到 UI 但没有截图"],
          flags: ["证据之后又有新提交"],
          touchesUi: true,
          hasImage: false,
        },
      }),
    );
    expect(card.html).toContain("缺少：PR 描述缺少「验证」；改到 UI 但没有截图");
    expect(card.html).toContain("⚠️ 证据之后又有新提交");
  });

  it.each([
    [{ merged: true, state: "closed" as const }, "merged", ["🔗 PR"]],
    [{ state: "closed" as const }, "closed", ["🔗 PR"]],
    [{ draft: true }, "draft", ["🔍 详情", "🔄 刷新", "🔗 PR"]],
    [{ tier: "T3" as const }, "t3", ["🔍 详情", "🔄 刷新", "🔗 在 GitHub 合并"]],
    [{ tier: "T2" as const }, "needs_details", ["🔍 详情（查看后可合并）", "🔗 PR", "🔄 刷新"]],
    [
      { tier: "T2" as const, detailsViewed: true },
      "ready",
      ["✅ 合并", "🔍 详情", "🔗 PR", "🔄 刷新"],
    ],
  ])("maps %o to %s", (overrides, status, buttons) => {
    const card = renderPrCard(input(overrides));
    expect(card.status).toBe(status);
    expect(buttonTexts(card)).toEqual(buttons);
  });

  it("omits the summary line when it would repeat the title", () => {
    for (const summary of [null, "fix(settings): <save> progress"]) {
      const card = renderPrCard(input({ summary }));
      expect(card.html).not.toContain("改了什么");
      expect(card.html.split("\n")[1]).toBe("fix(settings): &lt;save&gt; progress");
    }
  });

  it("escapes check names from GitHub", () => {
    const failing = summarizeChecks(
      [{ id: 1, name: "build <linux> & test", status: "completed", conclusion: "failure" }],
      [],
    );
    expect(renderPrCard(input({ checks: failing })).html).toContain(
      "CI：❌ build &lt;linux&gt; &amp; test 失败",
    );
    const details = renderPrDetails({
      number: 1,
      tier: "T1",
      files: [],
      checks: failing,
      contract: { items: [], missing: [], flags: [], touchesUi: false, hasImage: false },
    });
    expect(details).toContain("build &lt;linux&gt; &amp; test");
    expect(details).not.toContain("<linux>");
  });

  it("blocks merge on failing or pending CI", () => {
    const failing = summarizeChecks(
      [{ id: 1, name: "test", status: "completed", conclusion: "failure" }],
      [],
    );
    expect(determinePrStatus({ ...input(), checks: failing })).toBe("ci_failed");
    const card = renderPrCard(input({ checks: failing }));
    expect(card.html).toContain("CI：❌ test 失败");
    expect(buttonTexts(card)).not.toContain("✅ 合并");
  });

  it("renders the confirmation step and a stable hash", () => {
    const confirming = renderPrCard(input({ confirmingMerge: true }));
    expect(buttonTexts(confirming)).toEqual(["✅ 确认合并", "取消"]);
    expect(cardHash(renderPrCard(input()))).toBe(cardHash(renderPrCard(input())));
    expect(cardHash(confirming)).not.toBe(cardHash(renderPrCard(input())));
  });
});
