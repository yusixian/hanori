import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { PromptVersions } from "./prompt-versions";
import type { PromptSnapshot, PromptVersion } from "@cos-tool-bot/shared";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  working: vi.fn(),
  detail: vi.fn(),
  save: vi.fn(),
  activate: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/lib/client", () => ({
  client: {
    api: {
      bots: {
        ":botId": {
          "prompt-versions": {
            $get: api.list,
            $post: api.save,
            working: { $get: api.working },
            preview: { $post: api.preview },
            activate: { $post: api.activate },
            ":id": { $get: api.detail, $delete: api.remove },
          },
        },
      },
    },
  },
}));
const response = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
const snapshot: PromptSnapshot = {
  systemPrompt: "",
  behavioralPrompt: "A thoughtful, concise guide.",
  groupBehavioralPrompt: "Speak when useful.",
  maxInjectionBytes: 20480,
  files: [
    { name: "IDENTITY.md", content: "A friendly guide with practical advice.", enabled: true },
  ],
  skills: [
    {
      id: "fixture",
      name: "research",
      displayName: "Research",
      description: "Find trustworthy sources",
      summary: "Find trustworthy sources",
      instructions: "Read the reference before researching.",
      resources: { "reference.md": "Prefer primary sources." },
      source: "custom",
      digest: "fixture",
      enabled: true,
    },
  ],
};
const previews = {
  private: { fullPrompt: "Synthetic private preview", estimatedTokens: 120, sections: [] },
  group: { fullPrompt: "Synthetic group preview", estimatedTokens: 140, sections: [] },
};
const original: PromptVersion = {
  id: "original",
  botId: "bot",
  name: "Original",
  description: "Synthetic baseline",
  applicationVersion: "fixture-sha",
  createdAt: "2026-11-11T00:00:00Z",
  snapshot,
  previews,
};
let versions: PromptVersion[], activeId: string | null;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  vi.clearAllMocks();
  versions = [structuredClone(original)];
  activeId = null;
  api.list.mockImplementation(async () =>
    response({
      activeId,
      versions: versions.map(({ snapshot: _, previews, ...version }) => ({
        ...version,
        privateTokens: previews.private.estimatedTokens,
        groupTokens: previews.group.estimatedTokens,
      })),
    }),
  );
  api.working.mockImplementation(async () => response({ snapshot, activeId }));
  api.detail.mockImplementation(async ({ param }: { param: { id: string } }) =>
    response(versions.find((version) => version.id === param.id)),
  );
  api.save.mockImplementation(
    async ({ json }: { json: { name: string; description: string; snapshot: PromptSnapshot } }) => {
      const version = { ...original, ...json, id: "candidate" };
      versions.push(version);
      return response(version);
    },
  );
  api.activate.mockImplementation(async ({ json }: { json: { id: string | null } }) => {
    activeId = json.id;
    return response({ activeId });
  });
  api.remove.mockImplementation(async ({ param }: { param: { id: string } }) => {
    versions = versions.filter((version) => version.id !== param.id);
    return response(undefined);
  });
  api.preview.mockImplementation(async () => response(previews));
});
async function select(label: string, option: string) {
  await page.getByLabelText(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function capture() {
  for (const width of [1440, 390]) {
    await page.viewport(width, width === 1440 ? 900 : 844);
    document.querySelector("[data-scroll]")?.scrollTo(0, 0);
    await page.screenshot({ path: `__screenshots__/prompt-versions-${width}-top.png` });
    page
      .getByRole("button", { name: "Compare preview", exact: true })
      .element()
      .scrollIntoView({ block: "center" });
    await page.screenshot({ path: `__screenshots__/prompt-versions-${width}-draft.png` });
  }
}
test("edits a separate draft, saves without enabling, compares two versions and restores", async () => {
  render(
    <div data-scroll className="h-screen overflow-auto p-4">
      <PromptVersions botId="bot" />
    </div>,
  );
  await page.getByRole("button", { name: "Manage versions" }).click();
  await page.getByRole("button", { name: "Replace draft from source" }).click();
  await page.getByLabelText("Version name", { exact: true }).fill("Concise candidate");
  await page.getByLabelText("General behavior", { exact: true }).fill("Warm and concise.");
  await page.getByLabelText("New Markdown filename", { exact: true }).fill("REFERENCE.md");
  await page.getByRole("button", { name: "Add reference file" }).click();
  await page.getByText("REFERENCE.md · On-demand reference", { exact: true }).click();
  await page
    .getByLabelText("Content REFERENCE.md", { exact: true })
    .fill("Additional synthetic background.");
  await page.getByRole("button", { name: "Save as new version (do not enable)" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("active version has not changed");
  expect(api.activate).not.toHaveBeenCalled();
  expect(snapshot.files).toHaveLength(1);
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({
      json: expect.objectContaining({
        snapshot: expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ name: "REFERENCE.md", enabled: false }),
          ]),
        }),
      }),
    }),
  );
  await page.getByRole("button", { name: "Replace draft from source" }).click();
  await select("Compare against", "Original");
  await page.getByRole("button", { name: "Compare preview", exact: true }).click();
  await expect
    .element(page.getByText("Content differences against comparison source (2)", { exact: true }))
    .toBeVisible();
  await capture();
  await page.getByRole("button", { name: "Enable / restore this version" }).click();
  await expect
    .element(page.getByRole("button", { name: "Delete version", exact: true }))
    .toBeDisabled();
  await select("Version source", "Original");
  await page.getByRole("button", { name: "Enable / restore this version" }).click();
  expect(activeId).toBe("original");
  await select("Version source", "Concise candidate");
  await page.getByRole("button", { name: "Delete version", exact: true }).click();
  expect(versions.map((version) => version.id)).toEqual(["original"]);
});
