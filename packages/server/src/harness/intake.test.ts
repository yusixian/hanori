import { describe, expect, it } from "vitest";
import { acceptsPullRequest } from "./intake.js";

const github = {
  acceptPullRequests: "harness-only",
  branchPrefix: "harness/",
  labelPrefix: "harness:",
  trustedAuthors: ["example-owner"],
};
const repo = "example-owner/koyori";
const pr = { headRepo: repo, headRef: "harness/fix-1", author: "someone", labels: [] as string[] };

describe("acceptsPullRequest", () => {
  it("accepts same-repo harness branches", () => {
    expect(acceptsPullRequest(github, repo, pr)).toBe(true);
  });

  it("accepts trusted authors on other same-repo branches", () => {
    expect(acceptsPullRequest(github, repo, { ...pr, headRef: "fix/x", author: "example-owner" })).toBe(
      true,
    );
  });

  it("rejects fork PRs even on a harness-looking branch", () => {
    expect(acceptsPullRequest(github, repo, { ...pr, headRepo: "stranger/koyori" })).toBe(false);
  });

  it("rejects untrusted same-repo branches without the prefix", () => {
    expect(acceptsPullRequest(github, repo, { ...pr, headRef: "fix/x" })).toBe(false);
  });

  it("accepts any PR carrying the track label", () => {
    expect(
      acceptsPullRequest(github, repo, {
        ...pr,
        headRepo: "stranger/koyori",
        labels: ["harness:track"],
      }),
    ).toBe(true);
  });

  it("accepts everything when configured to", () => {
    expect(
      acceptsPullRequest({ ...github, acceptPullRequests: "all" }, repo, {
        ...pr,
        headRepo: null,
      }),
    ).toBe(true);
  });
});
