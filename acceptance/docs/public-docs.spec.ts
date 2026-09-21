import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("public release deep links render and hydrate on desktop and mobile", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/docs/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.screenshot({ path: info.outputPath("docs-home.png"), fullPage: true });

  await page.goto("/docs/changelog/v0.2.0/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("v0.2.0");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("v0.2.0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("release.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("release titles and navigation stay concise", async ({ page }, info) => {
  await page.goto("/docs/changelog/v0.10.1/");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("v0.10.1");
  await expect(page.getByText("对话加载与删除恢复", { exact: true })).toBeVisible();
  await page.reload();
  await expect(title).toHaveText("v0.10.1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("release-v0.10.1.png"), fullPage: true });
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  }
  await expect(
    page.getByRole("link", { name: "全部版本", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.2.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.3.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.4.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.5.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.5.1", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.6.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.7.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.8.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.9.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.9.1", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.10.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.10.1", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "版本更新说明", exact: true })).toHaveCount(0);
});

test("management guides are searchable and readable on desktop and mobile", async ({
  page,
}, info) => {
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").fill("管理面板导航");
  await dialog.getByRole("button", { name: "Docs 使用指南 管理面板导航", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/guides\/panel-navigation\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("管理面板导航");
  await expect(page.getByRole("heading", { name: "从 Bot 进入全局管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "检索和清理日志" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "查看与清理对话" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "查看用量与统计范围" })).toBeVisible();
  await expect(page.getByText("全部 Bot 对比", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /^浏览与管理 Bot/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("panel-navigation-guide.png"), fullPage: true });
  await page.goto("/docs/guides/ai-chat/");
  await expect(page.getByRole("heading", { level: 2, name: /^保存设置与保留草稿/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("ai-settings-guide.png"), fullPage: true });
});

test("avatar guidance exposes privacy and recovery limits", async ({ page }, info) => {
  await page.goto("/docs/guides/generation-library/");
  await expect(page.getByRole("heading", { level: 3, name: /^从缓存头像整理外貌/ })).toBeVisible();
  await expect(page.getByText("cache_unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("分析头像与保存角色是两步。", { exact: true })).toBeVisible();
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("avatar-guide.png"), fullPage: true });
  await page.goto("/docs/guides/privacy-memory/");
  await expect(page.getByRole("heading", { level: 2, name: /^AI 读取缓存头像/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: /^在面板查看与清理对话/ }),
  ).toBeVisible();
  await expect(page.getByText("已删除，但未能刷新页面数据", { exact: true })).toBeVisible();
});

test("all prerendered pages and local documentation links resolve without a session", async ({
  request,
}) => {
  const root = resolve(import.meta.dirname, "../../packages/docs/build/client/docs");
  const entries = await readdir(root, { recursive: true });
  const links = new Set<string>(["/docs/", "/docs/changelog/", "/docs/changelog/v0.2.0/"]);
  for (const entry of entries.filter((entry) => entry.endsWith("index.html"))) {
    links.add(`/docs/${entry.slice(0, -"index.html".length)}`);
    const html = await readFile(resolve(root, entry), "utf8");
    for (const match of html.matchAll(/href="(\/docs(?:\/[^"#?]*)?)(?:[?#][^"]*)?"/g)) {
      links.add(match[1]!);
    }
  }
  expect(links.size).toBeGreaterThan(15);
  for (const url of links) {
    const response = await request.get(url);
    expect(response.status(), url).toBe(200);
  }
  const missing = await request.get("/docs/this-page-does-not-exist");
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain("页面未找到");
});

test("search, navigation and theme controls work with the production CSP", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("input").fill("隐私");
  await expect(dialog.getByText("隐私、历史与记忆", { exact: true })).toBeVisible();
  await dialog.getByText("隐私、历史与记忆", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("隐私、历史与记忆");
  await expect(
    page.getByRole("heading", { level: 2, name: /^在面板维护档案与记忆/ }),
  ).toBeVisible();
  await expect(page.getByText("刷新列表", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: /^筛选记忆/ })).toBeVisible();
  await expect(page.getByText("清除筛选", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("record-management-guide.png"), fullPage: true });
  await page.locator('a[href="/docs"]').filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("cos-tool-bot 文档");

  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  }
  await page.getByRole("button", { name: "深色", exact: true }).filter({ visible: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: info.outputPath("docs-dark.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the panel link leaves the documentation router", async ({ page, baseURL }, info) => {
  await page.route(`${baseURL}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Panel entry</h1>" }),
  );
  await page.goto("/docs/");
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  }
  await page.getByRole("link", { name: "管理面板", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "Panel entry" })).toBeVisible();
});
