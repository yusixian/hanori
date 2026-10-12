import { expect, test } from "@playwright/test";

const origin = process.env.DOCS_SITE_URL?.trim().replace(/\/$/, "");

test("metadata is present before JavaScript and updates after navigation", async ({
  page,
  request,
}) => {
  const response = await request.get("/docs/");
  const html = await response.text();
  expect(html).toContain('property="og:title"');
  expect(html).toContain('name="twitter:card"');
  await page.goto("/docs/");
  await expect(page).toHaveTitle("Hanori · 花织 — 自托管 Telegram AI 伙伴");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/docs/brand/apple-touch-icon.png",
  );

  if (origin) {
    expect(html).toContain(`href="${origin}/docs/"`);
    expect(html).toContain(`content="${origin}/docs/brand/social-card.png"`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${origin}/docs/`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      `${origin}/docs/brand/social-card.png`,
    );
  } else {
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
  }

  await page
    .getByRole("link", { name: "快速开始", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/docs\/getting-started\/quickstart\/?$/);
  await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "快速开始 · Hanori 文档",
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /首次登录/);
  if (origin) {
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${origin}/docs/getting-started/quickstart`,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      `${origin}/docs/getting-started/quickstart`,
    );
  }
});

test("crawler files and correctly sized brand assets are anonymously accessible", async ({
  request,
}) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const sitemap = await request.get("/docs/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toMatch(/(?:application|text)\/xml/);
  const xml = await sitemap.text();
  if (origin) {
    expect(await robots.text()).toContain(`Sitemap: ${origin}/docs/sitemap.xml`);
    expect(xml).toContain(`<loc>${origin}/docs/</loc>`);
    expect(xml).toContain(`<loc>${origin}/docs/getting-started/quickstart</loc>`);
    expect(xml).not.toContain("/api/");
    expect(xml).not.toContain("/assets/");
  } else {
    expect(xml).not.toContain("<loc>");
    expect(await robots.text()).not.toContain("Sitemap:");
  }
  for (const [name, width, height] of [
    ["social-card.png", 1200, 630],
    ["hanori-logo.png", 512, 512],
    ["apple-touch-icon.png", 180, 180],
    ["icon-32.png", 32, 32],
  ] as const) {
    const image = await request.get(`/docs/brand/${name}`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toContain("image/png");
    const png = await image.body();
    expect(png.readUInt32BE(16)).toBe(width);
    expect(png.readUInt32BE(20)).toBe(height);
  }
});

test("Warp responds to hover and keyboard focus while respecting reduced motion", async ({
  page,
  request,
}) => {
  await page.goto("/docs/");
  const mark = page.locator(".hanori-mark").filter({ visible: true }).first();
  const thread = mark.locator(".hanori-weft");
  await expect(thread).toHaveCSS("transform", "none");
  await mark.hover();
  await expect(thread).toHaveCSS("transform", "matrix(1, 0, 0, 1, 1.8, 0)");
  await page.mouse.move(0, 0);
  await expect(thread).toHaveCSS("transform", "none");
  await page.keyboard.press("Tab");
  const home = mark.locator("xpath=ancestor::a[1]");
  await home.focus();
  await expect(home).toBeFocused();
  await expect(thread).toHaveCSS("transform", "matrix(1, 0, 0, 1, 1.8, 0)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(thread).toHaveCSS("transform", "none");
  await expect(thread).toHaveCSS("transition-duration", "0s");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(thread).toHaveCSS("fill", "rgb(240, 143, 170)");
  const favicon = await request.get("/docs/icon.svg");
  expect(favicon.status()).toBe(200);
  expect(await favicon.text()).not.toMatch(/<style|<animate|<script/);
});
