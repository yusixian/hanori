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

  test("bot-ai-expanded-execution-limits", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "bot-ai-expanded-execution-limits",
      feature: "Bot AI execution limits",
      severity: "P1",
      steps: [
        "Open Bot AI reply settings",
        "Expand execution settings",
        "Open tools and expand Agent settings",
      ],
      expected: [
        "Concurrent replies default to 32 and accept values up to 128",
        "Sub-agent steps default to 64 and accept values up to 128",
        "Controls remain readable without horizontal overflow on desktop and mobile",
      ],
      allowHttpStatuses: [422],
    });

    await page.goto(`/bots/${botId}/ai?section=replies`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: /Execution & queueing/ }).click();
    await expect(page.getByRole("spinbutton", { name: "Concurrent AI replies" })).toHaveValue("32");
    await expect(page.getByText(/1–128; default 32/)).toBeVisible();
    await acceptance.checkpoint("bot-ai-expanded-execution-limits");

    await page.goto(`/bots/${botId}/ai?section=tools`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: /Agent tools/ }).click();
    await expect(page.getByRole("spinbutton", { name: "Max Sub-agent Steps" })).toHaveValue("64");
    await expect(page.getByText(/1–128; default 64/)).toBeVisible();
    await acceptance.checkpoint("bot-ai-expanded-agent-limits");
  });

  test("bot-ai-compression-provider", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "bot-ai-compression-provider",
      feature: "Conversation compression Provider",
      severity: "P1",
      steps: [
        "Open Bot AI reply settings",
        "Expand conversation history settings",
        "Choose an explicit Provider for compression",
      ],
      expected: [
        "Compression follows the active Provider by default",
        "A dedicated Provider can be selected independently",
        "The control remains readable without horizontal overflow",
      ],
    });

    await page.goto(`/bots/${botId}/ai?section=replies`);
    await page.getByRole("button", { name: /Conversation context/ }).click();
    const provider = page.getByRole("combobox", { name: "Compression Provider" });
    await expect(provider).toHaveText(/Follow active Provider/);
    await provider.click();
    await page.getByRole("option", { name: /Default \(acceptance-model\)/ }).click();
    await expect(provider).toHaveText("Default (acceptance-model)");
    await provider.scrollIntoViewIfNeeded();
    await acceptance.checkpoint("compression-provider-selected");
  });

  test("bot-ai-owner-friendly-controls", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "bot-ai-owner-friendly-controls",
      feature: "Owner-friendly AI access and tool controls",
      severity: "P1",
      steps: [
        "Open private-chat access settings and select allowlist mode",
        "Open Web tools and configure trusted private hosts",
        "Open Image OCR and inspect the model image-size limit",
      ],
      expected: [
        "Private chats default to Everyone and expose the allowlist only in allowlist mode",
        "Trusted private hosts accept one hostname or IP per line",
        "The default per-image main-model limit is 20 MB",
        "Controls remain readable without horizontal overflow",
      ],
    });

    await page.goto(`/bots/${botId}/ai?section=access`);
    await page.getByRole("button", { name: /Private chat access/ }).click();
    const accessMode = page.getByRole("combobox", { name: "Access mode" });
    await expect(accessMode).toHaveText("Everyone");
    await accessMode.click();
    await page.getByRole("option", { name: "Administrators and allowlist" }).click();
    await expect(page.getByPlaceholder("Telegram User ID")).toBeVisible();
    await acceptance.checkpoint("private-chat-allowlist-mode");

    await page.goto(`/bots/${botId}/ai?section=tools`);
    await page.getByRole("button", { name: /Web tools/ }).click();
    await page.getByLabel("Enable Web Tools").check();
    await page
      .getByLabel("Trusted private-network hosts")
      .fill("localhost\n192.168.1.20\n*.home.arpa");
    await expect(page.getByLabel("Trusted private-network hosts")).toHaveValue(
      "localhost\n192.168.1.20\n*.home.arpa",
    );
    await acceptance.checkpoint("trusted-private-hosts");

    await page.getByRole("button", { name: /Image OCR/ }).click();
    const imageLimit = page.getByLabel("Per-image main-model limit (MB)");
    await expect(imageLimit).toHaveAttribute("placeholder", /20/);
    await imageLimit.scrollIntoViewIfNeeded();
    await acceptance.checkpoint("model-image-size-limit");
  });
});
