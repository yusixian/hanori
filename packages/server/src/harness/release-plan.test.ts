import { describe, expect, it } from "vitest";
import { type ReleaseSnapshot, RELEASE_STATES, renderReleaseCard } from "./release-card.js";
import {
  bumpFor,
  classifyChange,
  computeReleasePlan,
  parseReleaseArgs,
  tagMatches,
  workflowTagPatterns,
} from "./release-plan.js";
import { mergedPull } from "./release-test-fakes.js";
import { observeRelease, prepInstruction } from "./release-track.js";
import { FakeGitHub, TEST_REPO } from "./test-fakes.js";

const HEAD = "b".repeat(40);
const TAG_WORKFLOW = 'name: Release\non:\n  push:\n    tags:\n      - "v*"\n';

function repoWithTag(tag = "v0.17.0") {
  const github = new FakeGitHub();
  github.releases.tags = [
    { name: "nightly", sha: "0".repeat(40) },
    { name: "v0.9.0", sha: "9".repeat(40) },
    { name: tag, sha: "1".repeat(40) },
    { name: "v0.16.2", sha: "2".repeat(40) },
  ];
  github.releases.releases = [
    {
      tag,
      url: `https://github.com/${TEST_REPO}/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
    },
  ];
  return github;
}

function withCommits(github: FakeGitHub, ...messages: string[]) {
  github.releases.commits = messages.map((message, index) => ({
    sha: `${index}`.repeat(40).slice(0, 40),
    message,
  }));
  return github;
}

const plan = (github: FakeGitHub, args = "") =>
  computeReleasePlan(github, {
    repo: TEST_REPO,
    arg: parseReleaseArgs(args)!,
    preferredWorkflow: "release.yml",
  });

describe("release version rules", () => {
  it("classifies conventional titles", () => {
    expect(classifyChange("fix(ui): align")).toBe("fix");
    expect(classifyChange("perf: faster")).toBe("fix");
    expect(classifyChange("feat(harness): /release")).toBe("feat");
    expect(classifyChange("feat!: drop node 20")).toBe("breaking");
    expect(classifyChange("refactor: x", "BREAKING CHANGE: config moved")).toBe("breaking");
    expect(classifyChange("chore(release): v0.17.0")).toBe("other");
    expect(classifyChange("Update readme")).toBe("other");
  });

  it("bumps by change type, with 0.x breaking changes bumping minor", () => {
    const zero = { major: 0, minor: 17, patch: 0 };
    const one = { major: 1, minor: 2, patch: 3 };
    expect(bumpFor("fix", one, null)).toBe("patch");
    expect(bumpFor("feat", one, null)).toBe("minor");
    expect(bumpFor("breaking", one, null)).toBe("major");
    expect(bumpFor("breaking", zero, null)).toBe("minor");
    expect(bumpFor("breaking", zero, "major")).toBe("major");
    expect(bumpFor("other", zero, null)).toBe("patch");
  });

  it("accepts only bump names and stable versions as arguments", () => {
    expect(parseReleaseArgs("")).toEqual({ kind: "auto" });
    expect(parseReleaseArgs(" Minor ")).toEqual({ kind: "bump", bump: "minor" });
    expect(parseReleaseArgs("v1.2.3")).toEqual({
      kind: "version",
      version: { major: 1, minor: 2, patch: 3 },
    });
    expect(parseReleaseArgs("1.2")).toBeNull();
    expect(parseReleaseArgs("1.2.3-rc.1")).toBeNull();
    expect(parseReleaseArgs("minor please")).toBeNull();
  });

  it("detects tag-triggered workflows", () => {
    expect(workflowTagPatterns(TAG_WORKFLOW)).toEqual(["v*"]);
    expect(workflowTagPatterns("on:\n  push:\n    branches: [main]\n")).toBeNull();
    expect(workflowTagPatterns("on: [push, pull_request]\n")).toBeNull();
    expect(workflowTagPatterns("on: {{ broken")).toBeNull();
    expect(tagMatches(["v*"], "v1.0.0")).toBe(true);
    expect(tagMatches(["v*", "!v*-rc*"], "v1.0.0-rc1")).toBe(false);
    expect(tagMatches(["release/*"], "v1.0.0")).toBe(false);
  });

  it("matches GitHub's filter pattern syntax", () => {
    expect(tagMatches(["v[0-9]+.[0-9]+.[0-9]+"], "v1.20.3")).toBe(true);
    expect(tagMatches(["v[0-9]+.[0-9]+.[0-9]+"], "v1.20.3-rc.1")).toBe(false);
    expect(tagMatches(["v[12].[0-9]+.[0-9]+"], "v3.0.0")).toBe(false);
    expect(tagMatches(["vv?1.0.0"], "v1.0.0")).toBe(true);
    expect(tagMatches(["+broken"], "v1.0.0")).toBe(false);
  });
});

describe("computeReleasePlan", () => {
  it("keeps breaking changes from older commits when deduplicating a merged PR", async () => {
    const github = withCommits(repoWithTag("v1.0.0"), "feat!: remove old API", "fix: follow-up");
    github.releases.pullsByCommit["0".repeat(40)] = mergedPull(12, "refactor: update API");
    github.releases.pullsByCommit["1".repeat(40)] = mergedPull(12, "refactor: update API");
    const result = await plan(github);
    expect(result.ok && result.plan).toMatchObject({ highest: "breaking", tag: "v2.0.0" });
    expect(result.ok && result.plan.changes).toHaveLength(1);
  });

  it("proposes the next version from the highest merged PR since the latest semver tag", async () => {
    const github = withCommits(
      repoWithTag(),
      "fix(ui): align (#11)",
      "feat(harness): add /release (#12)",
      "chore: bump deps",
    );
    github.releases.pullsByCommit["0".repeat(40)] = mergedPull(11, "fix(ui): align");
    github.repoFiles = {
      ".github/workflows/release.yml": TAG_WORKFLOW,
      ".github/workflows/ci.yml": "on: [pull_request]\n",
    };

    const result = await plan(github);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(github.releases.compares).toEqual([`v0.17.0...${HEAD}`]);
    expect(result.plan).toMatchObject({
      targetSha: HEAD,
      defaultBranch: "main",
      previous: { tag: "v0.17.0", version: "0.17.0", hasRelease: true },
      version: "0.18.0",
      tag: "v0.18.0",
      bump: "minor",
      highest: "feat",
      commitCount: 3,
      workflows: [{ file: "release.yml", patterns: ["v*"] }],
      releaseKit: null,
    });
    expect(result.plan.changes.map((change) => [change.number, change.title])).toEqual([
      [null, "chore: bump deps"],
      [12, "feat(harness): add /release"],
      [11, "fix(ui): align"],
    ]);
  });

  it("bumps a patch for fixes and applies release-kit's pre-1.0 breaking rule", async () => {
    const fixes = await plan(withCommits(repoWithTag(), "fix: one (#3)"));
    expect(fixes.ok && fixes.plan.tag).toBe("v0.17.1");

    const breaking = withCommits(repoWithTag(), "feat!: new config (#4)");
    const zeroX = await plan(breaking);
    expect(zeroX.ok && zeroX.plan.tag).toBe("v0.18.0");

    breaking.repoFiles = {
      "release-kit.yaml": "versioning:\n  tag: v{version}\n  pre1:\n    breaking: major\n",
      ".release/changes/a.md": "---\nkind: feat\n---\n",
    };
    const kit = await plan(breaking);
    expect(kit.ok && kit.plan).toMatchObject({
      tag: "v1.0.0",
      releaseKit: { breakingPre1: "major", tagTemplate: "v{version}", pendingChanges: 1 },
    });
  });

  it("honours an explicit bump or version and refuses one that is not newer", async () => {
    const github = withCommits(repoWithTag(), "fix: one (#3)");
    const major = await plan(github, "major");
    expect(major.ok && major.plan).toMatchObject({ tag: "v1.0.0", bump: "major" });
    const named = await plan(github, "0.20.0");
    expect(named.ok && named.plan).toMatchObject({ tag: "v0.20.0", bump: null });
    const older = await plan(github, "0.17.0");
    expect(older).toEqual({ ok: false, message: "0.17.0 不高于当前版本 v0.17.0" });
  });

  it("reports no new commits and a missing release on the previous tag", async () => {
    const github = repoWithTag();
    github.releases.releases = [];
    const result = await plan(github);
    expect(result.ok && result.plan).toMatchObject({
      commitCount: 0,
      changes: [],
      previous: { hasRelease: false },
      workflows: [],
    });
  });

  it("reads previous versions through release-kit's tag template", async () => {
    const github = withCommits(repoWithTag(), "fix: one (#3)");
    github.releases.tags.push({ name: "app-v1.2.0", sha: "5".repeat(40) });
    github.repoFiles = { "release-kit.yaml": "versioning:\n  tag: app-v{version}\n" };
    const result = await plan(github);
    expect(result.ok && result.plan).toMatchObject({
      previous: { tag: "app-v1.2.0" },
      tag: "app-v1.2.1",
    });
  });

  it("starts from 0.0.0 with a v prefix when the repo has no semver tag", async () => {
    const github = new FakeGitHub();
    github.commits = [{ sha: "abc1234", message: "feat: first (#1)", author: null, date: null }];
    const result = await plan(github);
    expect(result.ok && result.plan).toMatchObject({ previous: null, tag: "v0.1.0" });
  });
});

function snapshot(overrides: Partial<ReleaseSnapshot> = {}): ReleaseSnapshot {
  return {
    plan: {
      repo: TEST_REPO,
      defaultBranch: "main",
      targetSha: HEAD,
      previous: { tag: "v0.17.0", version: "0.17.0", sha: "1".repeat(40), hasRelease: true },
      version: "0.18.0",
      tag: "v0.18.0",
      bump: "minor",
      highest: "feat",
      changes: Array.from({ length: 18 }, (_, index) => ({
        number: 100 + index,
        title: index === 0 ? "feat: <b>bold</b>" : `fix: change ${index}`,
        kind: index === 0 ? "feat" : "fix",
      })),
      commitCount: 20,
      workflows: [{ file: "release.yml", patterns: ["v*"] }],
      releaseKit: null,
    },
    arg: "",
    prepAt: null,
    taggedAt: null,
    actionsReadable: true,
    run: null,
    release: null,
    note: null,
    ...overrides,
  };
}

const buttons = (card: { keyboard: Array<Array<{ text: string }>> }) =>
  card.keyboard.flat().map((button) => button.text);

describe("release card", () => {
  it("shows versions, tag, target, a bounded PR list, and the workflow", () => {
    const card = renderReleaseCard({
      projectKey: "sandbox",
      state: RELEASE_STATES.planned,
      snapshot: snapshot(),
      approvalId: "a".repeat(22),
    });
    expect(card.html).toContain("<b>🚀 发版计划 · sandbox v0.18.0</b>");
    expect(card.html).toContain("版本：v0.17.0 → <b>v0.18.0</b>（minor · 最高改动 feat）");
    expect(card.html).toContain("Tag：<code>v0.18.0</code> → <code>bbbbbbb</code>");
    expect(card.html).toContain("上个 tag：v0.17.0 @1111111 · 已有 GitHub Release");
    expect(card.html).toContain("<b>改动</b>（18 个 PR · 20 个提交）");
    expect(card.html).toContain("feat: &lt;b&gt;bold&lt;/b&gt;");
    expect(card.html).toContain("…另有 3 项");
    expect(card.html).toContain("发版 workflow：release.yml（push tags: v*）");
    expect(buttons(card)).toEqual(["📝 准备发版", "🏷 确认发布", "🔄 刷新", "✖️ 取消"]);
    for (const button of card.keyboard.flat()) {
      expect(Buffer.byteLength(button.callbackData ?? "")).toBeLessThanOrEqual(64);
    }
  });

  it("asks for the exact tag and full SHA before tagging", () => {
    const card = renderReleaseCard({
      projectKey: "sandbox",
      state: RELEASE_STATES.planned,
      snapshot: snapshot(),
      approvalId: "a".repeat(22),
      confirming: true,
    });
    expect(card.html).toContain(`提交：<code>${HEAD}</code>`);
    expect(card.html).toContain("Tag：<code>v0.18.0</code>（annotated）");
    expect(buttons(card)).toEqual(["✅ 确认打 tag", "返回"]);
  });

  it("offers only refresh and cancel when nothing changed since the last tag", () => {
    const empty = snapshot();
    empty.plan = { ...empty.plan, changes: [], commitCount: 0 };
    const card = renderReleaseCard({
      projectKey: "sandbox",
      state: RELEASE_STATES.planned,
      snapshot: empty,
      approvalId: "a".repeat(22),
    });
    expect(card.html).toContain("⚠️ 上次发版后没有新提交");
    expect(buttons(card)).toEqual(["🔄 刷新", "✖️ 取消"]);
  });

  it("links to Actions when the App cannot read workflow runs", () => {
    const card = renderReleaseCard({
      projectKey: "sandbox",
      state: RELEASE_STATES.building,
      snapshot: snapshot({ actionsReadable: false, taggedAt: "2026-09-24T12:00:00Z" }),
      approvalId: "a".repeat(22),
    });
    expect(card.html).toContain("<b>🟡 构建中 · sandbox v0.18.0</b>");
    expect(card.html).toContain("无 Actions 读权限");
    expect(card.keyboard).toEqual([
      [
        { text: "🔗 Actions", url: `https://github.com/${TEST_REPO}/actions` },
        expect.objectContaining({ text: "🔄 刷新" }),
      ],
    ]);
  });
});

describe("release tracking", () => {
  const taggedAt = new Date("2026-09-24T12:00:00Z");
  const run = (status: string, conclusion: string | null, updatedAt = "2026-09-24T12:05:00Z") => ({
    id: 9,
    name: "Release",
    path: ".github/workflows/release.yml",
    headBranch: "v0.18.0",
    event: "push",
    status,
    conclusion,
    url: `https://github.com/${TEST_REPO}/actions/runs/9`,
    updatedAt,
  });
  const at = (minutes: number) => new Date(taggedAt.getTime() + minutes * 60_000);
  const observe = (observation: Parameters<typeof observeRelease>[1]) =>
    observeRelease(snapshot(), observation, taggedAt).state;
  const release = { tag: "v0.18.0", url: "https://x/r", draft: false, prerelease: false };

  it("moves building → published / failed / timed out", () => {
    expect(observe({ release: null, runs: [run("in_progress", null)], now: at(3) })).toBe(
      RELEASE_STATES.building,
    );
    expect(observe({ release, runs: [run("completed", "success")], now: at(6) })).toBe(
      RELEASE_STATES.published,
    );
    expect(observe({ release: null, runs: [run("completed", "failure")], now: at(6) })).toBe(
      RELEASE_STATES.failed,
    );
    expect(observe({ release: null, runs: [run("completed", "success")], now: at(6) })).toBe(
      RELEASE_STATES.building,
    );
    expect(observe({ release: null, runs: [run("completed", "success")], now: at(8) })).toBe(
      RELEASE_STATES.published,
    );
    expect(observe({ release: null, runs: null, now: at(30) })).toBe(RELEASE_STATES.building);
    expect(observe({ release: null, runs: null, now: at(121) })).toBe(RELEASE_STATES.timedOut);
    expect(observe({ release, runs: null, now: at(10) })).toBe(RELEASE_STATES.published);
  });

  it("requires every detected workflow to succeed, using the latest run of each", () => {
    const snap = snapshot();
    snap.plan.workflows.push({ file: "windows.yml", patterns: ["v*"] });
    const mac = run("completed", "success");
    const windows = { ...mac, id: 10, name: "Windows", path: ".github/workflows/windows.yml" };
    const check = (runs: Parameters<typeof observeRelease>[1]["runs"], minutes = 8) =>
      observeRelease(snap, { release: null, runs, now: at(minutes) }, taggedAt);
    expect(check([mac]).state).toBe(RELEASE_STATES.building);
    expect(check([mac, { ...windows, status: "in_progress", conclusion: null }]).state).toBe(
      RELEASE_STATES.building,
    );
    expect(check([mac, { ...windows, conclusion: "failure" }])).toMatchObject({
      state: RELEASE_STATES.failed,
      snapshot: { run: { id: 10, name: "Windows" } },
    });
    const later = { ...windows, updatedAt: at(7).toISOString() };
    expect(check([mac, later]).state).toBe(RELEASE_STATES.building);
    expect(check([mac, later], 10).state).toBe(RELEASE_STATES.published);
    const oldFailure = { ...windows, id: 8, conclusion: "failure" };
    expect(check([oldFailure, mac, windows]).state).toBe(RELEASE_STATES.published);
    const newerPending = { ...windows, id: 11, status: "queued", conclusion: null };
    expect(check([oldFailure, mac, windows, newerPending]).state).toBe(RELEASE_STATES.building);
  });

  it.each(["skipped", "neutral", null])(
    "does not publish a completed run with conclusion %s",
    (conclusion) => {
      expect(observe({ release: null, runs: [run("completed", conclusion)], now: at(8) })).not.toBe(
        RELEASE_STATES.published,
      );
    },
  );

  it("ignores runs of other refs", () => {
    const other = { ...run("completed", "failure"), headBranch: "main" };
    expect(observe({ release: null, runs: [other], now: at(3) })).toBe(RELEASE_STATES.building);
  });

  it("does not let another workflow's run finish the tracking of a detected one", () => {
    const ci = { ...run("completed", "success"), id: 10, path: ".github/workflows/ci.yml" };
    expect(observe({ release: null, runs: [ci], now: at(8) })).toBe(RELEASE_STATES.building);
    expect(observe({ release: null, runs: [ci, run("in_progress", null)], now: at(8) })).toBe(
      RELEASE_STATES.building,
    );
  });
});

describe("prepInstruction", () => {
  it("asks for a chore(release) PR and forbids tagging", () => {
    const text = prepInstruction(snapshot().plan);
    expect(text).toContain("Prepare release v0.18.0 of example-owner/harness-sandbox");
    expect(text).toContain("titled `chore(release): v0.18.0`");
    expect(text).toContain("Do not create or push any git tag");
    expect(text).toContain("- #100 feat: <b>bold</b>");
  });
});
