import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOT_SKILL_IDS,
  buildSkillsCatalogPrompt,
  listBuiltInSkills,
  resolveBotSkills,
  resolveBuiltInSkills,
} from "./catalog.js";

describe("built-in Skill catalog", () => {
  it("enables the three bundled image-prompt Skills by default", () => {
    expect(DEFAULT_BOT_SKILL_IDS).toEqual([
      "guide-image-prompts",
      "prompt-atelier",
      "tsubaki-prompt-expander",
    ]);
    expect(resolveBuiltInSkills().map((skill) => skill.name)).toEqual(DEFAULT_BOT_SKILL_IDS);
  });

  it("merges enabled custom Skills without allowing them to shadow built-ins", () => {
    const custom = {
      id: "custom-1",
      name: "my-skill",
      displayName: "My Skill",
      description: "Custom workflow",
      instructions: "Do the custom workflow.",
      resources: { "notes.md": "Reference" },
      enabled: true,
    };
    expect(
      resolveBotSkills({ enabledBuiltInIds: [], customSkills: [custom] }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["my-skill"]);
    expect(
      resolveBotSkills({
        enabledBuiltInIds: [],
        customSkills: [{ ...custom, name: "prompt-atelier" }],
      }),
    ).toEqual([]);
  });

  it("treats an explicit empty selection as disabled and ignores unknown ids", () => {
    expect(resolveBuiltInSkills([])).toEqual([]);
    expect(
      resolveBuiltInSkills(["unknown", "prompt-atelier", "prompt-atelier"]).map((s) => s.id),
    ).toEqual(["prompt-atelier"]);
  });

  it("publishes resources and only concise descriptions in the static prompt", () => {
    const summaries = listBuiltInSkills();
    expect(summaries.find((skill) => skill.id === "prompt-atelier")?.resources).toEqual([
      "references/examples.md",
      "references/inspiration-deck.md",
      "references/styles.md",
      "references/vocabulary.md",
    ]);
    const prompt = buildSkillsCatalogPrompt(resolveBuiltInSkills())!;
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("prompt-atelier");
    expect(prompt).toContain("调用 /draw 时，表示实际出图");
    expect(prompt).toContain("pixai-image 等生图工具名均映射为 create_image");
    expect(prompt).not.toContain("六要素解剖");
  });
});
