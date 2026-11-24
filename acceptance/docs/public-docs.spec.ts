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
  await page.goto("/docs/changelog/v0.17.0/");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("v0.17.0");
  await expect(page.getByText("一键让停下的会话继续", { exact: true })).toBeVisible();
  await page.reload();
  await expect(title).toHaveText("v0.17.0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("release-v0.17.0.png"), fullPage: true });
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
  await expect(
    page.getByRole("link", { name: "v0.11.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.11.1", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.12.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.14.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.14.1", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.14.2", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.15.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "v0.16.0", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "版本更新说明", exact: true })).toHaveCount(0);
});

for (const { version, theme, status = "" } of [
  { version: "v0.28.1", theme: "语录父预览与布局" },
  { version: "v0.29.1", theme: "群友印象回顾与生图确认修复（未发布候选）", status: "未发布候选" },
  { version: "v0.29.0", theme: "模型重试与备用模型" },
  { version: "v0.28.0", theme: "语录贴纸与配色" },
  { version: "v0.27.1", theme: "Telegram 内容接收补漏" },
  { version: "v0.27.0", theme: "媒体上下文与局部引用" },
  { version: "v0.26.1", theme: "自定义总结格式优先级" },
  { version: "v0.26.0", theme: "范围受限的总结工具与预览" },
  { version: "v0.22.0", theme: "视频工具与可编辑消息" },
  { version: "v0.18.0", theme: "更新 Lody CLI 与模型列表" },
  { version: "v0.19.0", theme: "自动发现模型与显式配置" },
  { version: "v0.19.1", theme: "授权期间保留 MCP 连接状态" },
  { version: "v0.20.0", theme: "插件市场、统一检索与 Bot 运行诊断", status: "阶段记录" },
  { version: "v0.20.1", theme: "运行可靠性与架构维护（待发布）", status: "候选记录" },
  { version: "v0.21.0", theme: "插件、生图与自动化更新" },
  { version: "v0.21.1", theme: "仓库发现与诊断可靠性（未发布候选）", status: "未发布候选" },
]) {
  test(`${version} supports anonymous deep links, navigation and search`, async ({
    page,
  }, info) => {
    await page.goto("/docs/changelog/");
    const label = status
      ? `${version}（${status}）：${theme.replace(/（(?:待发布|未发布候选)）$/, "")}`
      : `${version}：${theme}`;
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(version);
    await expect(page.getByText(theme, { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 2, name: /^(使用与升级|升级注意事项)/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`release-${version}.png`), fullPage: true });
    await page.goto("/docs/");
    await page
      .getByRole("button", { name: /搜索文档/ })
      .filter({ visible: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input").fill(version);
    await dialog
      .getByRole("button", { name: new RegExp(version.replaceAll(".", "\\.")) })
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/docs/changelog/${version.replaceAll(".", "\\.")}/?$`),
    );
  });
}

test("the first search click opens the dialog when client scripts load late", async ({ page }) => {
  let resumeScripts!: () => void;
  const scriptsPaused = new Promise<void>((resolve) => {
    resumeScripts = resolve;
  });
  await page.route("**/*.js", async (route) => {
    await scriptsPaused;
    await route.continue();
  });
  const search = page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first();
  try {
    await page.goto("/docs/", { waitUntil: "commit" });
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(search).toBeHidden();
    await expect(page.getByRole("button", { name: "打开侧边栏", exact: true })).toBeHidden();
  } finally {
    resumeScripts();
  }
  await search.click();
  await expect(page.getByRole("dialog").locator("input")).toBeVisible();
});

test("JEV tuning guide is searchable and explains independent thresholds", async ({
  page,
}, info) => {
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").fill("群聊行为与参与控制");
  await dialog
    .getByRole("button", { name: "Docs 使用指南 群聊行为与参与控制", exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/guides\/group-behavior\/?$/);
  await expect(page.getByRole("heading", { name: "配置接话门槛与偏好" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "直接招呼置信度", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "延续对话置信度", exact: true })).toBeVisible();
  await expect(
    page.getByText("置信度不是回复概率，也不是实测准确率。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "经常不接话时怎么调" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("jev-tuning-guide.png"), fullPage: true });
});

test("unified search guide can be found and reopened without authentication", async ({ page }) => {
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").fill("统一检索");
  await dialog.getByRole("button", { name: "Docs 使用指南 统一检索", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/guides\/search\/?$/);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("统一检索");
  await expect(page.getByRole("heading", { name: "排查与回退" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
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

test("generation record guide supports search, deep links and recovery instructions", async ({
  page,
}, info) => {
  await page.goto("/docs/");
  await page
    .getByRole("button", { name: /搜索文档/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").fill("生成记录与问题恢复");
  await dialog
    .getByRole("button", { name: "Docs 使用指南 生成记录与问题恢复", exact: true })
    .click();
  await expect(page).toHaveURL(/\/docs\/guides\/generation-records\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("生成记录与问题恢复");
  await expect(page.getByRole("heading", { level: 2, name: /^删除与核对结果/ })).toBeVisible();
  await expect(page.getByText("刷新并核对", { exact: true })).toBeVisible();
  await expect(page.getByText("已删除，但未能刷新页面数据", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: /^加载失败时/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("generation-records-guide.png"), fullPage: true });
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
  await expect(page.getByText("清空此 Bot 的全部对话", { exact: true })).toBeVisible();
  await expect(page.getByText(/搜索覆盖当前 Bot 的全部会话/)).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hanori 文档");

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
