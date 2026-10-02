import "@/style.css";
import { i18n } from "@/i18n";
import type { PluginConfigPublic, PluginManifest } from "@cos-tool-bot/shared";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { PluginConfigForm, type PluginConfigFormProps } from "./config-form";

const manifest: PluginManifest = {
  apiVersion: 1,
  id: "example.search",
  name: "Example search",
  version: "1.0.0",
  description: "Synthetic test plugin",
  author: "Test",
  config: [
    { key: "title", label: "Title", type: "string", required: true },
    { key: "notes", label: "Notes", type: "text" },
    { key: "ratio", label: "Ratio", type: "number", min: 0, max: 1, default: 0 },
    { key: "limit", label: "Limit", type: "integer", min: 1, max: 10 },
    { key: "enabled", label: "Enabled", type: "boolean", default: false },
    {
      key: "region",
      label: "Region",
      type: "select",
      options: [
        { value: "cn", label: "China" },
        { value: "us", label: "United States" },
      ],
    },
    { key: "cookie", label: "Cookie", type: "text", secret: true, required: true },
  ],
};
const empty: PluginConfigPublic = { values: {}, configuredSecrets: [] };

function props(overrides: Partial<PluginConfigFormProps> = {}): PluginConfigFormProps {
  return {
    manifest,
    configuration: empty,
    scopeKey: "bot-1/example.search",
    revision: 1,
    onSave: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 900);
});

test("configures all field types and preserves false and zero defaults", async () => {
  const input = props();
  render(<PluginConfigForm {...input} />);
  await expect.element(page.getByLabelText("Ratio")).toHaveValue("0");
  await expect.element(page.getByRole("checkbox", { name: "Enabled" })).not.toBeChecked();
  await page.getByLabelText("Title").fill("Music search");
  await page.getByLabelText("Notes").fill("Two lines\nSecond line");
  await page.getByLabelText("Ratio").fill("0.5");
  await page.getByLabelText("Limit").fill("3");
  await page.getByRole("checkbox", { name: "Enabled" }).click();
  await page.getByRole("combobox", { name: "Region" }).selectOptions("cn");
  await page.getByLabelText("Cookie").fill("synthetic-cookie");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenCalledWith({
    values: {
      title: "Music search",
      notes: "Two lines\nSecond line",
      ratio: 0.5,
      limit: 3,
      enabled: true,
      region: "cn",
    },
    secrets: { cookie: "synthetic-cookie" },
  });
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByRole("status")).toHaveTextContent("Configuration saved.");
});

test("allows incomplete drafts and leaves saved secrets untouched when blank", async () => {
  const input = props({ configuration: { values: {}, configuredSecrets: ["cookie"] } });
  render(<PluginConfigForm {...input} />);
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByLabelText("Cookie")).toHaveAttribute("type", "password");
  await expect
    .element(page.getByLabelText("Cookie"))
    .toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenCalledWith({ values: { ratio: 0, enabled: false } });
});

test("explicit clearing can be canceled, replaced or saved without leaking the secret", async () => {
  const input = props({ configuration: { values: {}, configuredSecrets: ["cookie"] } });
  render(<PluginConfigForm {...input} />);
  await page.getByRole("button", { name: "Clear saved secret" }).click();
  await expect.element(page.getByLabelText("Cookie")).toBeDisabled();
  await expect
    .element(page.getByText("The saved secret will be cleared when you save."))
    .toBeVisible();
  await page.getByRole("button", { name: "Cancel clearing" }).click();
  await expect.element(page.getByLabelText("Cookie")).toBeEnabled();
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenLastCalledWith({ values: { ratio: 0, enabled: false } });
  await page.getByLabelText("Cookie").fill("synthetic-replacement");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenLastCalledWith({
    values: { ratio: 0, enabled: false },
    secrets: { cookie: "synthetic-replacement" },
  });
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await page.getByRole("button", { name: "Clear saved secret" }).click();
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenLastCalledWith({
    values: { ratio: 0, enabled: false },
    secrets: { cookie: null },
  });
  await expect.element(page.getByText("No secret is saved.")).toBeVisible();
});

test("a failed save keeps the draft and retry clears new secrets only after success", async () => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic-private-secret"))
    .mockResolvedValue(undefined);
  render(<PluginConfigForm {...props({ onSave })} />);
  await page.getByLabelText("Title").fill("Edited title");
  await page.getByLabelText("Cookie").fill("synthetic-private-secret");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Configuration could not be saved. Your changes are kept; try again.");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("synthetic-private-secret");
  expect(document.body.textContent).not.toContain("synthetic-private-secret");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.element(page.getByRole("status")).toBeVisible();
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByLabelText("Title")).toHaveValue("Edited title");
  expect(onSave).toHaveBeenCalledTimes(2);
});

test("rejects incomplete, nonfinite, fractional integer and out-of-bounds numeric input", async () => {
  const input = props();
  render(<PluginConfigForm {...input} />);
  for (const invalid of ["-", "1e", "Infinity", "0x10", "2"]) {
    await page.getByLabelText("Ratio").fill(invalid);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect.element(page.getByLabelText("Ratio")).toHaveAttribute("aria-invalid", "true");
    expect(input.onSave).not.toHaveBeenCalled();
  }
  await page.getByLabelText("Ratio").fill("0");
  await page.getByLabelText("Limit").fill("1.5");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.element(page.getByLabelText("Limit")).toHaveAttribute("aria-invalid", "true");
  const errorId = page.getByLabelText("Limit").element().getAttribute("aria-describedby");
  expect(document.getElementById(errorId!)?.textContent).toBe(
    "Enter a valid value for this field.",
  );
  await expect.element(page.getByLabelText("Limit")).toHaveFocus();
  expect(input.onSave).not.toHaveBeenCalled();
});

test("blank numeric and select values explicitly clear their saved values", async () => {
  const input = props({
    configuration: { values: { limit: 4, region: "us" }, configuredSecrets: [] },
  });
  render(<PluginConfigForm {...input} />);
  await page.getByLabelText("Limit").fill("");
  await page.getByRole("combobox", { name: "Region" }).selectOptions("");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenCalledWith({
    values: { ratio: 0, limit: null, enabled: false, region: null },
  });
  await expect.element(page.getByLabelText("Limit")).toHaveValue("");
  await expect.element(page.getByRole("status")).toBeVisible();
});

test("clearing a defaulted number explains the reset and displays its default after saving", async () => {
  const input = props({ configuration: { values: { ratio: 0.8 }, configuredSecrets: [] } });
  render(<PluginConfigForm {...input} />);
  await page.getByLabelText("Ratio").fill("");
  await expect
    .element(page.getByText("Saving an empty value resets this field to its default: 0."))
    .toBeVisible();
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenCalledWith({ values: { ratio: null, enabled: false } });
  await expect.element(page.getByLabelText("Ratio")).toHaveValue("0");
});

test("same revision rerenders preserve drafts and bot, version and revision changes reset them", async () => {
  const input = props();
  const view = await render(<PluginConfigForm {...input} />);
  await page.getByLabelText("Title").fill("Unsaved title");
  await page.getByLabelText("Cookie").fill("synthetic-bot-one-secret");
  await view.rerender(<PluginConfigForm {...input} configuration={{ ...empty }} />);
  await expect.element(page.getByLabelText("Title")).toHaveValue("Unsaved title");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("synthetic-bot-one-secret");
  await view.rerender(<PluginConfigForm {...input} scopeKey="bot-2/example.search" />);
  await expect.element(page.getByLabelText("Title")).toHaveValue("");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await page.getByLabelText("Cookie").fill("synthetic-bot-two-secret");
  await view.rerender(
    <PluginConfigForm
      {...input}
      scopeKey="bot-2/example.search"
      revision={2}
      configuration={{ values: { title: "Confirmed" }, configuredSecrets: ["cookie"] }}
    />,
  );
  await expect.element(page.getByLabelText("Title")).toHaveValue("Confirmed");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await page.getByLabelText("Title").fill("Version one draft");
  await view.rerender(<PluginConfigForm {...input} manifest={{ ...manifest, version: "2.0.0" }} />);
  await expect.element(page.getByLabelText("Title")).toHaveValue("");
});

test("saving disables the form and a late response cannot overwrite a different bot", async () => {
  let finish!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const input = props({ onSave });
  const view = await render(<PluginConfigForm {...input} />);
  await page.getByLabelText("Cookie").fill("synthetic-pending-secret");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect.element(page.getByLabelText("Title")).toBeDisabled();
  await view.rerender(<PluginConfigForm {...input} scopeKey="bot-2/example.search" />);
  await page.getByLabelText("Title").fill("Bot two draft");
  finish();
  await expect.element(page.getByLabelText("Title")).toHaveValue("Bot two draft");
  await expect.element(page.getByLabelText("Cookie")).toHaveValue("");
  await expect.element(page.getByRole("button", { name: "Save configuration" })).toBeEnabled();
});

test("supports an empty manifest and the externally disabled state", async () => {
  const input = props({ manifest: { ...manifest, config: [] }, disabled: true });
  const view = await render(<PluginConfigForm {...input} />);
  await expect.element(page.getByText("This plugin has no configuration fields.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  await view.rerender(<PluginConfigForm {...input} disabled={false} />);
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(input.onSave).toHaveBeenCalledWith({ values: {} });
});

test("keyboard entry submits and long cookie/metadata fit a narrow screen as plain text", async () => {
  await page.viewport(320, 844);
  const input = props({
    manifest: {
      ...manifest,
      config: [
        {
          key: "cookie",
          label: "Cookie",
          type: "text",
          secret: true,
          description: "<script>synthetic</script>" + "x".repeat(500),
        },
      ],
    },
  });
  render(<PluginConfigForm {...input} />);
  await userEvent.tab();
  await expect.element(page.getByLabelText("Cookie")).toHaveFocus();
  await userEvent.keyboard("synthetic-cookie");
  await page.getByLabelText("Cookie").fill("synthetic-cookie=" + "x".repeat(8000));
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Save configuration" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toBeVisible();
  expect(input.onSave).toHaveBeenCalledTimes(1);
  expect(document.querySelector("form script")).toBeNull();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

test("renders failures and field guidance in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  render(
    <PluginConfigForm
      {...props({
        onSave: vi.fn(async () => {
          throw new Error("synthetic-secret");
        }),
      })}
    />,
  );
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("配置保存失败。已保留修改，请重试。");
  await expect.element(page.getByText("尚未保存密钥。")).toBeVisible();
});
