import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    url: { type: "string" },
    output: { type: "string", default: ".env" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: pnpm setup:env --email owner@example.com --url https://bot.example.com [--output .env]\nCreates a Docker deployment environment without overwriting existing files.\n",
  );
} else {
  if (!values.email || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(values.email)) {
    throw new Error("Provide --email with your owner login email.");
  }
  const origin = new URL(values.url ?? "http://localhost:43100");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(origin.hostname) ||
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
  ) {
    throw new Error("--url must be an HTTPS origin, or a local HTTP origin, without credentials.");
  }
  const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const replacements = {
    DB_PASSWORD: randomBytes(32).toString("hex"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PANEL_PASSWORD: randomBytes(24).toString("hex"),
    MINI_APP_SESSION_SECRET: randomBytes(32).toString("hex"),
    AUTH_OWNER_EMAIL: values.email,
    BETTER_AUTH_URL: origin.origin,
    NSFW_API_URL: "http://nsfw-api:3000",
    // These are not used by Compose, but must not accidentally connect to the dev DB.
    DATABASE_URL: "",
    CODING_WORKER_URL: "",
  };
  const contents = template.replace(/^([A-Z_]+)=.*$/gm, (line, key) =>
    key in replacements ? `${key}=${replacements[key]}` : line,
  );
  const output = resolve(values.output);
  await writeFile(output, contents, { flag: "wx", mode: 0o600 });
  process.stdout.write(
    "Created deployment environment (mode 0600). Read PANEL_PASSWORD locally for first login; keep ENCRYPTION_KEY stable. This file is for Docker, not pnpm dev.\n",
  );
}
