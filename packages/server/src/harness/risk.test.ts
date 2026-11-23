import { describe, expect, it } from "vitest";
import { repoPolicySchema } from "./config/schema.js";
import { assessRisk, globToRegExp, matchesAny } from "./risk.js";

const risk = repoPolicySchema.parse({}).risk;
const file = (filename: string, extra: Record<string, unknown> = {}) => ({
  filename,
  status: "modified",
  ...extra,
});

describe("globToRegExp", () => {
  it.each([
    ["docs/**", "docs/guide/intro.md", true],
    ["docs/**", "src/docs/a.md", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "packages/a/README.md", true],
    ["*.md", "packages/a/README.md", false],
    ["apps/**/src/**/*.tsx", "apps/site/src/app.tsx", true],
    ["apps/**/src/**/*.tsx", "apps/site/src/pages/a/b.tsx", true],
    ["scripts/package-*", "scripts/package-mac.sh", true],
    ["**/locales/**", "packages/panel/src/i18n/locales/en.json", true],
    [".github/workflows/release*.yml", ".github/workflows/release-preview.yml", true],
    ["src/{a,b}.ts", "src/b.ts", true],
    ["src/?.ts", "src/ab.ts", false],
  ])("%s matches %s → %s", (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });

  it("treats a trailing slash as the whole directory", () => {
    expect(matchesAny("vendor/x/y.js", ["vendor/"])).toBe(true);
  });
});

describe("assessRisk", () => {
  it("uses the highest tier across files", () => {
    const result = assessRisk([file("docs/a.md"), file("src/logic.ts")], risk);
    expect(result.tier).toBe("T2");
  });

  it("marks documentation-only changes as T0", () => {
    expect(assessRisk([file("docs/a.md"), file("README.md")], risk).tier).toBe("T0");
  });

  it.each([
    ".github/hanori-policy.yml",
    ".cos/harness.yml",
    ".github/workflows/ci.yml",
    "release-kit.yaml",
  ])("fixes %s at T3 even when a lower rule matches", (path) => {
    const permissive = { ...risk, T0: ["**"] };
    const result = assessRisk([file(path)], permissive);
    expect(result.tier).toBe("T3");
    expect(result.files[0]!.rule).toBe("fixed");
  });

  it("counts the old path of a rename", () => {
    const result = assessRisk(
      [file("docs/policy.yml", { status: "renamed", previousFilename: ".cos/harness.yml" })],
      risk,
    );
    expect(result.tier).toBe("T3");
  });

  it("applies policy T1 and T3 rules", () => {
    const custom = { ...risk, T1: ["src/components/**"], T3: ["migrations/**"] };
    expect(assessRisk([file("src/components/Button.tsx")], custom).tier).toBe("T1");
    expect(assessRisk([file("migrations/0001.sql")], custom).tier).toBe("T3");
  });

  it("falls back to the policy default for an empty diff", () => {
    expect(assessRisk([], risk).tier).toBe("T2");
  });
});
