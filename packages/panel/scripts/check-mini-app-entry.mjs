import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entryPath = fileURLToPath(new URL("../index.html", import.meta.url));
const entry = await readFile(entryPath, "utf8");
const telegramSdk = 'src="https://telegram.org/js/telegram-web-app.js"';
const appEntry = 'src="/src/main.tsx"';

assert.equal(
  entry.split(telegramSdk).length - 1,
  1,
  "index.html must load the official Telegram Mini App SDK exactly once",
);
assert.ok(
  entry.indexOf(telegramSdk) < entry.indexOf(appEntry),
  "Telegram Mini App SDK must load before the application entry",
);

console.log("Telegram Mini App entry contract passed");
