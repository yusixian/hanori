import { describe, expect, it } from "vitest";
import { DEFAULT_PREFER_SKILLS } from "./config/schema.js";
import type { DirectoryEntry } from "./github.js";
import { inferRepoPolicy, readRepoFacts, type RepoFacts } from "./infer.js";
import { FakeGitHub, TEST_REPO } from "./test-fakes.js";

function files(...names: string[]): DirectoryEntry[] {
  return names.map((name) => ({ name, type: name.includes(".") ? "file" : "dir" }));
}

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { root: [], packageJson: null, projectSwift: null, repoSkills: [], ...overrides };
}

function pkg(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

describe("inferRepoPolicy for JavaScript repos", () => {
  it("joins lint, typecheck, and test with the lockfile's package manager", () => {
    const policy = inferRepoPolicy(
      facts({
        root: files("package.json", "pnpm-lock.yaml"),
        packageJson: pkg({
          scripts: { lint: "oxlint .", typecheck: "tsc -b", test: "vitest", "test:e2e": "pw" },
          dependencies: { react: "19", vite: "7" },
        }),
      }),
      "site",
    );
    expect(policy).toEqual({
      kind: "web",
      verify: { quick: "pnpm lint && pnpm typecheck && pnpm test", acceptance: "pnpm test:e2e" },
    });
  });

  it("prefers the packageManager field and skips npm's placeholder test", () => {
    const policy = inferRepoPolicy(
      facts({
        root: files("package.json", "package-lock.json"),
        packageJson: pkg({
          packageManager: "bun@1.2.0",
          scripts: { test: 'echo "Error: no test specified" && exit 1', check: "biome check" },
        }),
      }),
      "tool",
    );
    expect(policy.verify).toEqual({ full: "bun run check" });
  });

  it("detects electron, libraries, and plain servers", () => {
    const kind = (value: Record<string, unknown>, root = files("package.json", "yarn.lock")) =>
      inferRepoPolicy(facts({ root, packageJson: pkg(value) }), "x").kind;
    expect(kind({ devDependencies: { electron: "38" }, scripts: { "test:desktop": "x" } })).toBe(
      "electron",
    );
    expect(kind({ exports: { ".": "./dist/index.js" }, devDependencies: { vite: "7" } })).toBe(
      "library",
    );
    expect(kind({ bin: "cli.js", dependencies: { next: "15" } })).toBe("web");
    expect(kind({ dependencies: { hono: "4" } })).toBe("service");
    expect(kind({ dependencies: { hono: "4", react: "19" } })).toBe("web");
  });

  it("uses yarn and npm script syntax", () => {
    const quick = (root: DirectoryEntry[]) =>
      (
        inferRepoPolicy(facts({ root, packageJson: pkg({ scripts: { lint: "x" } }) }), "x")
          .verify as { quick: string }
      ).quick;
    expect(quick(files("package.json", "yarn.lock"))).toBe("yarn lint");
    expect(quick(files("package.json"))).toBe("npm run lint");
  });
});

describe("inferRepoPolicy for other ecosystems", () => {
  it("builds Tuist projects through the generated workspace", () => {
    const policy = inferRepoPolicy(
      facts({
        root: files("Package.swift", "Project.swift", "Tuist.swift", "MoePeek.xcodeproj"),
        projectSwift: 'let project = Project(\n  name: "MoePeek",\n  targets: []\n)',
      }),
      "moepeek",
    );
    expect(policy).toEqual({
      kind: "native",
      verify: {
        quick:
          "tuist install && tuist generate --no-open && xcodebuild -workspace MoePeek.xcworkspace -scheme MoePeek -configuration Debug build",
        full: "xcodebuild test -workspace MoePeek.xcworkspace -scheme MoePeek",
      },
    });
  });

  it("falls back to the repo name when Project.swift has no readable name", () => {
    const policy = inferRepoPolicy(facts({ root: files("Tuist.swift") }), "MoePeek");
    expect((policy.verify as { full: string }).full).toBe(
      "xcodebuild test -workspace MoePeek.xcworkspace -scheme MoePeek",
    );
  });

  it("covers SwiftPM, Cargo, Go, and unknown repos", () => {
    const infer = (...names: string[]) => inferRepoPolicy(facts({ root: files(...names) }), "x");
    expect(infer("Package.swift")).toEqual({
      kind: "library",
      verify: { quick: "swift build && swift test" },
    });
    expect(infer("Cargo.toml")).toEqual({ kind: "library", verify: { quick: "cargo test" } });
    expect(infer("go.mod")).toEqual({ kind: "service", verify: { quick: "go test ./..." } });
    expect(infer("App.xcodeproj")).toEqual({ kind: "native" });
    expect(infer("pyproject.toml", "README.md")).toEqual({});
  });
});

describe("repo-defined skills", () => {
  it("drops default skills the repo defines itself", () => {
    const policy = inferRepoPolicy(facts({ repoSkills: ["oneshot"] }), "koyori");
    expect(policy.prompts).toEqual({
      preferSkills: DEFAULT_PREFER_SKILLS.filter((skill) => skill !== "oneshot"),
    });
  });

  it("reads only the listings and SKILL.md files it needs", async () => {
    const github = new FakeGitHub();
    github.repoFiles = {
      "package.json": pkg({ scripts: { lint: "x" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9",
      ".agents/skills/oneshot/SKILL.md": "# oneshot",
      ".agents/skills/custom/SKILL.md": "# custom",
      ".claude/skills/gh-stack/README.md": "not a skill",
      "src/index.ts": "",
    };
    const result = await readRepoFacts(github, TEST_REPO, "main");
    expect(result.repoSkills).toEqual(["oneshot"]);
    expect(github.fileReads).toEqual([
      "package.json",
      ".agents/skills/oneshot/SKILL.md",
      ".claude/skills/gh-stack/SKILL.md",
    ]);
    expect(inferRepoPolicy(result, "koyori")).toMatchObject({
      verify: { quick: "pnpm lint" },
      prompts: { preferSkills: expect.not.arrayContaining(["oneshot"]) },
    });
  });
});
