import { describe, expect, it } from "vitest";
import { CiDetector, awaitRegistration } from "./ci-expectation.js";
import { summarizeChecks } from "./contract.js";
import { FakeGitHub, TEST_REPO } from "./test-fakes.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const none = summarizeChecks([], []);
const window = (lastPushAgoMs: number | null, expected: boolean) => ({
  expected,
  lastPushAt: lastPushAgoMs === null ? null : new Date(NOW.getTime() - lastPushAgoMs),
  now: NOW,
  graceMs: 60_000,
  timeoutMs: 600_000,
});

describe("awaitRegistration", () => {
  it("holds every PR without checks for the grace period after a push", () => {
    const held = awaitRegistration(none, window(10_000, false));
    expect(held.checks).toMatchObject({ state: "pending", awaitingRegistration: true });
    expect(held.recheckAt).toEqual(new Date(NOW.getTime() + 50_000));
    expect(awaitRegistration(none, window(61_000, false))).toEqual({
      checks: none,
      recheckAt: null,
    });
  });

  it("waits up to the registration timeout when the repo runs CI on pull requests", () => {
    expect(awaitRegistration(none, window(5 * 60_000, true)).checks.state).toBe("pending");
    expect(awaitRegistration(none, window(11 * 60_000, true)).checks.state).toBe("none");
  });

  it("leaves reported checks and untracked pushes alone", () => {
    const running = summarizeChecks(
      [{ id: 1, name: "ci", status: "queued", conclusion: null }],
      [],
    );
    expect(awaitRegistration(running, window(1_000, true)).checks).toBe(running);
    expect(awaitRegistration(none, window(null, true)).checks).toBe(none);
  });
});

describe("CiDetector", () => {
  it("expects CI only from workflows that react to pull requests, cached per repo", async () => {
    const github = new FakeGitHub();
    const detector = new CiDetector();
    const ttl = 30 * 60_000;
    github.repoFiles = {
      ".github/workflows/release.yml": "on:\n  push:\n    tags: ['v*']\n",
      ".github/workflows/README.md": "pull_request",
    };
    expect(await detector.expected(github, TEST_REPO, "main", ttl, NOW)).toBe(false);

    github.repoFiles[".github/workflows/ci.yaml"] = "on: [push, pull_request]\n";
    expect(await detector.expected(github, TEST_REPO, "main", ttl, NOW)).toBe(false);
    const later = new Date(NOW.getTime() + ttl);
    expect(await detector.expected(github, TEST_REPO, "main", ttl, later)).toBe(true);
    expect(github.fileReads).not.toContain(".github/workflows/README.md");
  });

  it("treats a repo without a workflows directory as having no CI", async () => {
    const detector = new CiDetector();
    expect(await detector.expected(new FakeGitHub(), TEST_REPO, "main", 1, NOW)).toBe(false);
  });
});
