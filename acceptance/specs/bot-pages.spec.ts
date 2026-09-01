import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_STATE_PATH, expect, test } from "../fixtures";

test.use({ storageState: AUTH_STATE_PATH });

const RUN_DIR = process.env.ACCEPTANCE_RUN_DIR ?? ".acceptance/runs/local";
const { botId } = JSON.parse(readFileSync(join(RUN_DIR, "seed.json"), "utf8")) as {
  botId: string;
};

const PAGES = [
  { id: "bot-dashboard", path: `/bots/${botId}`, feature: "Bot dashboard", severity: "P0" },
  { id: "bot-edit", path: `/bots/${botId}/edit`, feature: "Bot edit", severity: "P1" },
  { id: "bot-ai-settings", path: `/bots/${botId}/ai`, feature: "Bot AI settings", severity: "P1" },
  {
    id: "bot-governance",
    path: `/bots/${botId}/governance`,
    feature: "Usage and image governance",
    severity: "P1",
  },
  {
    id: "bot-conversations",
    path: `/bots/${botId}/conversations`,
    feature: "Bot conversations",
    severity: "P1",
  },
  { id: "bot-profiles", path: `/bots/${botId}/profiles`, feature: "Bot profiles", severity: "P2" },
  { id: "bot-memories", path: `/bots/${botId}/memories`, feature: "Bot memories", severity: "P2" },
  {
    id: "bot-generations",
    path: `/bots/${botId}/generations`,
    feature: "Bot generations",
    severity: "P2",
  },
  { id: "bot-files", path: `/bots/${botId}/files`, feature: "Bot files", severity: "P2" },
  { id: "bot-rss", path: `/bots/${botId}/rss`, feature: "Bot RSS", severity: "P2" },
  { id: "bot-summary", path: `/bots/${botId}/summary`, feature: "Bot summary", severity: "P2" },
  { id: "bot-export", path: `/bots/${botId}/export`, feature: "Bot export", severity: "P2" },
  { id: "bot-logs", path: `/bots/${botId}/logs`, feature: "Bot logs", severity: "P1" },
  { id: "bot-debugger", path: `/bots/${botId}/debugger`, feature: "Bot debugger", severity: "P2" },
] as const;

test.describe("bot-scoped pages", () => {
  for (const p of PAGES) {
    test(`${p.id}`, async ({ page, acceptance }, testInfo) => {
      acceptance.meta({
        id: p.id,
        feature: p.feature,
        severity: p.severity,
        steps: ["Log in", `Open ${p.path}`],
        expected: [
          `${p.feature} page renders its content or a deliberate empty state`,
          "No horizontal overflow",
          "No runtime errors",
        ],
        // A bot without AI configuration gets a domain 422 from ai-selection; the
        // page renders the "not configured" state intentionally.
        ...(p.id === "bot-ai-settings" ? { allowHttpStatuses: [422] } : {}),
      });
      const response = await page.goto(p.path);
      expect(response?.status(), `navigation to ${p.path}`).toBeLessThan(400);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("main").first()).toBeVisible();
      if (p.id === "bot-profiles" && testInfo.project.name === "mobile") {
        const addButtonWidth = await page
          .getByRole("button", { name: "Add profile" })
          .evaluate((element) => element.getBoundingClientRect().width);
        const searchButtonWidth = await page
          .getByRole("button", { name: "Search" })
          .evaluate((element) => element.getBoundingClientRect().width);
        expect(
          addButtonWidth,
          "mobile add-profile action uses the available width",
        ).toBeGreaterThan(300);
        expect(searchButtonWidth, "mobile search action uses the available width").toBeGreaterThan(
          300,
        );
      }
      await acceptance.checkpoint(p.id);
    });
  }
});
