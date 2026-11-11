import { useState } from "react";
import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test } from "vitest";
import type { AgentExecutionConfig } from "@cos-tool-bot/shared";
import { TaskAgentFields } from "./task-agent-fields";
import "@/style.css";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
function Harness() {
  const [config, setConfig] = useState<AgentExecutionConfig>({});
  return (
    <section className="mx-auto max-w-3xl space-y-4 p-6">
      <h1>Scheduled task Agent defaults</h1>
      <TaskAgentFields
        config={config}
        providers={[{ id: "provider-a", label: "Task provider", defaultModel: "task-model" }]}
        onUpdate={(updates) => setConfig((previous) => ({ ...previous, ...updates }))}
      />
      <output className="sr-only">{JSON.stringify(config)}</output>
    </section>
  );
}
test("distinguishes inherited tools from explicit no-tools and saves independent provider overrides", async () => {
  render(<Harness />);
  await page.getByLabelText("No tools").click();
  await expect.element(page.getByRole("status")).toHaveTextContent('"toolNames":[]');
  await page.getByLabelText("No tools").click();
  await expect.element(page.getByRole("status")).toHaveTextContent("{}");
  await page.getByLabelText("Provider", { exact: true }).click();
  await page.getByRole("option", { name: "Task provider" }).click();
  await page.getByLabelText("Model", { exact: true }).fill("task-model");
  await page
    .getByLabelText("Agent instructions")
    .fill("Produce a concise report from the approved task scope.");
  await page
    .getByLabelText("Allowed tools (comma separated)")
    .fill("read_task_history, web_search");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent('"toolNames":["read_task_history","web_search"]');
  for (const width of [1440, 390]) {
    await page.viewport(width, width === 1440 ? 900 : 844);
    await page.getByRole("heading").element();
    await page.screenshot({ path: `__screenshots__/task-agent-defaults-${width}.png` });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
});
