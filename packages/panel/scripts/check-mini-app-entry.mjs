import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entryPath = fileURLToPath(new URL("../index.html", import.meta.url));
const adapterPath = fileURLToPath(new URL("../src/mini-app/telegram-adapter.ts", import.meta.url));
const entry = await readFile(entryPath, "utf8");
const adapter = await readFile(adapterPath, "utf8");
const telegramSdkUrl = "https://telegram.org/js/telegram-web-app.js";
const appEntry = 'src="/src/main.tsx"';

assert.equal(
  entry.includes(telegramSdkUrl),
  false,
  "index.html must not load the Telegram SDK on admin routes",
);
assert.ok(entry.includes(appEntry), "index.html must load the application entry");
assert.equal(
  adapter.split(telegramSdkUrl).length - 1,
  1,
  "the Mini App adapter must lazy-load the official Telegram SDK exactly once",
);

console.log("Telegram Mini App entry contract passed");
