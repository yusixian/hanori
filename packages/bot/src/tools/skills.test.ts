import { describe, expect, it } from "vitest";
import { resolveBuiltInSkills, resolveBotSkills } from "../skills/catalog.js";
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

it("keeps unrelated custom Skill errors and instructions free of image submission claims", async () => {
  const tools = createSkillTools({
    skills: resolveBotSkills({
      enabledBuiltInIds: [],
      customSkills: [
        {
          id: "custom-rss",
          name: "rss-reader",
          displayName: "RSS",
          description: "Read feeds",
          instructions: "Read the requested RSS feed",
          resources: {},
          enabled: true,
        },
      ],
    }),
    hasImageGeneration: true,
    hasWebSearch: true,
  });
  const loaded = await executeLoadSkill(tools, { skill: "rss-reader" });
  expect(loaded).toMatchObject({ ok: true, imagePreparation: false });
  expect(loaded).not.toHaveProperty("runtime.imageGeneration");
  const missing = await executeLoadSkill(tools, { skill: "rss-reader", resource: "missing.md" });
  expect(missing).toMatchObject({ error: "resource_not_found", imagePreparation: false });
  expect(JSON.stringify(missing)).not.toContain("no image has been submitted");
});

it.each(["rss", "github"])(
  "keeps %s Skill guidance independent of available image tools",
  async (name) => {
    const tools = createSkillTools({
      skills: resolveBotSkills({
        enabledBuiltInIds: [],
        customSkills: [
          {
            id: `custom-${name}`,
            name,
            displayName: name,
            description: "Read the requested feed or repository",
            instructions: "Follow the requested workflow",
            resources: {},
            enabled: true,
          },
        ],
      }),
      hasImageGeneration: true,
      hasWebSearch: true,
    });
    const main = await executeLoadSkill(tools, { skill: name });
    expect(main).toMatchObject({ ok: true, skill: name });
    expect(main).not.toHaveProperty("runtime.imageGeneration");
    const missing = await executeLoadSkill(tools, { skill: name, resource: "missing.md" });
    expect(missing).toMatchObject({ ok: false, error: "resource_not_found", skill: name });
    expect(missing).toHaveProperty("imagePreparation", false);
    expect(missing).toHaveProperty("guidance", expect.not.stringMatching(/image|create_image/));
  },
);
