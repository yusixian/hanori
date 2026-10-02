import { describe, expect, it } from "vitest";
import { resolveBuiltInSkills } from "../skills/catalog.js";
import { createSkillTools } from "./skills.js";

async function executeLoadSkill(
  tools: ReturnType<typeof createSkillTools>,
  input: { skill: string; resource?: string },
) {
  const execute = tools.load_skill?.execute;
  if (!execute) throw new Error("load_skill is unavailable");
  return execute(input, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

describe("load_skill", () => {
  it("loads only enabled Skills", async () => {
    const tools = createSkillTools({
      skills: resolveBuiltInSkills(["prompt-atelier"]),
      hasImageGeneration: true,
      hasWebSearch: false,
    });
    await expect(executeLoadSkill(tools, { skill: "guide-image-prompts" })).resolves.toMatchObject({
      ok: false,
      error: "skill_not_enabled",
    });
    await expect(executeLoadSkill(tools, { skill: "prompt-atelier" })).resolves.toMatchObject({
      ok: true,
      skill: "prompt-atelier",
      runtime: {
        imageGeneration: expect.stringContaining("create_image"),
        webSearch: expect.stringContaining("unavailable"),
      },
    });
    const loaded = await executeLoadSkill(tools, { skill: "prompt-atelier" });
    expect(JSON.stringify(loaded)).toContain("/draw mean actual image generation");
    expect(JSON.stringify(loaded)).toContain("pixai-image");
  });

  it("loads a declared resource without exposing other Skills", async () => {
    const tools = createSkillTools({
      skills: resolveBuiltInSkills(["prompt-atelier"]),
      hasImageGeneration: false,
      hasWebSearch: true,
    });
    await expect(
      executeLoadSkill(tools, {
        skill: "prompt-atelier",
        resource: "references/styles.md",
      }),
    ).resolves.toMatchObject({ ok: true, content: expect.stringContaining("风格配方库") });
    await expect(
      executeLoadSkill(tools, { skill: "prompt-atelier", resource: "../secret" }),
    ).resolves.toMatchObject({ ok: false, error: "resource_not_found" });
    await expect(
      executeLoadSkill(tools, { skill: "prompt-atelier", resource: "toString" }),
    ).resolves.toMatchObject({ ok: false, error: "resource_not_found" });
  });
});

it("supplies bounded host search mappings for both Skill instructions and resources", async () => {
  const tools = createSkillTools({
    skills: resolveBuiltInSkills(["prompt-atelier"]),
    hasImageGeneration: false,
    hasWebSearch: false,
    unifiedSearchEnabled: true,
  });
  await expect(executeLoadSkill(tools, { skill: "prompt-atelier" })).resolves.toMatchObject({
    runtime: {
      webSearch: expect.stringContaining("search(scope=web) is unavailable"),
      retrieval: expect.stringContaining("read_reference"),
    },
  });
  await expect(
    executeLoadSkill(tools, { skill: "prompt-atelier", resource: "references/styles.md" }),
  ).resolves.toMatchObject({
    runtime: { retrieval: expect.stringContaining("These old names are not callable") },
  });
});
