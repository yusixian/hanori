import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Render the existing vector mark; no remote artwork or fonts are downloaded.
const root = new URL("../public/docs/", import.meta.url);
const mark = await readFile(new URL("icon.svg", root), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size] of [
    ["icon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["hanori-logo.png", 512],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>body{margin:0;background:#FBF6F1}svg{display:block;width:100%;height:100%}</style>${mark}`,
    );
    await page.screenshot({ path: fileURLToPath(new URL(`brand/${name}`, root)) });
  }
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;color:#2B1D23;background:#FBF6F1;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}
    main{width:1200px;height:630px;padding:72px 80px;position:relative;overflow:hidden;background:#FBF6F1}
    .line{width:64px;height:6px;border-radius:3px;background:#8A2B50;margin-bottom:34px}
    h1{margin:0;font-size:92px;letter-spacing:-4px;line-height:1.05;font-weight:700}
    .name{margin:14px 0 38px;font-size:38px;letter-spacing:8px;color:#8A2B50}
    h2{margin:0 0 16px;font-size:32px;font-weight:500;letter-spacing:1px}
    p{margin:0;font-size:22px;color:#7B6A71;line-height:1.7}
    .mark{position:absolute;width:330px;height:330px;right:70px;top:135px}
    .footer{position:absolute;left:80px;bottom:54px;font-size:17px;letter-spacing:2px;color:#7B6A71}
  </style><main><div class="line"></div><h1>Hanori</h1><div class="name">花织</div>
  <h2>自托管 Telegram AI 伙伴</h2><p>聊聊日常，留下记忆，也一起创造。<br>Self-hosted. Connected. Yours.</p>
  <div class="mark">${mark}</div><div class="footer">对话 · 记忆 · 工具 · 自动化</div></main></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL("brand/social-card.png", root)) });
} finally {
  await browser.close();
}
