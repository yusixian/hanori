import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { BotSkillsPage } from "./skills";

const builtIns = [
  {
    id: "guide-image-prompts",
    name: "guide-image-prompts",
    displayName: "Image Prompt Guide",
    description: "Guide the user",
    summary: "Guide the user",
    source: "image-prompt-skills",
    digest: "abc123",
    resources: [],
    enabled: true,
  },
  {
    id: "prompt-atelier",
    name: "prompt-atelier",
    displayName: "Prompt Atelier",
    description: "Design prompts",
    summary: "Design prompts",
    source: "image-prompt-skills",
    digest: "def456",
    resources: ["references/styles.md"],
    enabled: true,
  },
  {
    id: "tsubaki-prompt-expander",
    name: "tsubaki-prompt-expander",
    displayName: "Tsubaki Prompt Expander",
    description: "Expand prompts",
    summary: "Expand prompts",
    source: "image-prompt-skills",
    digest: "ghi789",
    resources: [],
    enabled: true,
  },
];

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("toggles a bundled Skill and saves the Bot-scoped selection", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) {
      return Response.json({
        ok: true,
        data: { builtIns, customSkills: [] },
        revision: "revision-1",
      });
    }
    const request = JSON.parse(String(init.body)) as { enabledBuiltInIds: string[] };
    expect(request.enabledBuiltInIds).toEqual(["prompt-atelier", "tsubaki-prompt-expander"]);
    return Response.json({
      ok: true,
      data: {
        builtIns: builtIns.map((skill) =>
          skill.id === "guide-image-prompts" ? { ...skill, enabled: false } : skill,
        ),
        customSkills: [],
      },
      revision: "revision-2",
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/bot-1/skills"]}>
      <Routes>
        <Route path="/bots/:botId/skills" element={<BotSkillsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  const toggle = page.getByRole("switch", { name: "Enable or disable Image Prompt Guide" });
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await page.getByRole("button", { name: "Save and apply" }).click();

  await expect.element(page.getByText("Skill configuration saved and applied.")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("creates and saves a custom Skill", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) {
      return Response.json({
        ok: true,
        data: { builtIns, customSkills: [] },
        revision: "revision-1",
      });
    }
    const request = JSON.parse(String(init.body)) as {
      customSkills: Array<{
        name: string;
        displayName: string;
        description: string;
        instructions: string;
        enabled: boolean;
      }>;
    };
    expect(request.customSkills).toHaveLength(1);
    expect(request.customSkills[0]).toMatchObject({
      name: "portrait-director",
      displayName: "Portrait Director",
      description: "Use for portrait image requests.",
      instructions: "# Portrait Director\n\nBuild a portrait prompt.",
      enabled: true,
    });
    return Response.json({
      ok: true,
      data: { builtIns, customSkills: request.customSkills },
      revision: "revision-2",
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/bot-1/skills"]}>
      <Routes>
        <Route path="/bots/:botId/skills" element={<BotSkillsPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await page.getByRole("button", { name: "New Skill" }).click();
  await page.getByLabelText("Skill name").fill("portrait-director");
  await page.getByLabelText("Display name").fill("Portrait Director");
  await page.getByLabelText("Trigger description").fill("Use for portrait image requests.");
  await page
    .getByLabelText("SKILL.md instructions")
    .fill("# Portrait Director\n\nBuild a portrait prompt.");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save and apply" }).click();

  await expect.element(page.getByText("Skill configuration saved and applied.")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
