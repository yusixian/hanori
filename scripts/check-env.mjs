import { readFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";

const usage = "Usage: pnpm deploy:env:check [--file <path>] [--mode <docker|local>] [--help]";
const options = {
  file: { type: "string", default: ".env" },
  mode: { type: "string", default: "docker" },
  help: { type: "boolean" },
};

const placeholders = new Set([
  "change-me",
  "changeme",
  "password",
  "change-me-to-a-random-secret-at-least-32-characters",
]);
const githubAppKeys = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
];
const workerSecrets = [
  ["coding", "CODING_WORKER_SECRET"],
  ["media", "MEDIA_WORKER_SECRET"],
];

function isConfigured(value) {
  return Boolean(value) && !placeholders.has(value.toLowerCase());
}

function isWebOrigin(value) {
  // Inspect the original input before URL normalization can hide paths or credentials.
  if (!/^https?:\/\/[^/\s\\@?#]+\/?$/i.test(value)) return false;
  const url = URL.parse(value);
  if (!url) return false;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.(?:\d+\.){2}\d+$/.test(url.hostname);
  return url.protocol === "https:" || loopback;
}

function check(env, mode) {
  const errors = [];
  const warnings = [];
  const value = (name) => env[name]?.trim() ?? "";
  const configured = (name) => isConfigured(value(name));

  if (!configured("BETTER_AUTH_SECRET") || value("BETTER_AUTH_SECRET").length < 32) {
    errors.push("BETTER_AUTH_SECRET needs an independent random value of at least 32 characters.");
  }
  if (!configured("ENCRYPTION_KEY")) {
    errors.push(
      "ENCRYPTION_KEY needs the existing key on upgrades or a new random key on first setup.",
    );
  }
  if (!isWebOrigin(value("BETTER_AUTH_URL"))) {
    errors.push(
      "BETTER_AUTH_URL needs an HTTPS origin or loopback HTTP origin without a path, query, fragment, or credentials.",
    );
  }
  if (
    !/^[A-Z0-9_%+-]+(?:\.[A-Z0-9_%+-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,}$/i.test(
      value("AUTH_OWNER_EMAIL"),
    )
  ) {
    errors.push("AUTH_OWNER_EMAIL needs a valid email address for the owner login.");
  }

  if (githubAppKeys.some((name) => value(name)) && !githubAppKeys.every(configured)) {
    errors.push(
      "Set all five GitHub App variables to real values, or clear them all (" +
        githubAppKeys.join(", ") +
        ").",
    );
  }
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? "";
  // An unquoted multiline PEM is parsed as its first line only.
  if (/[\r\n]/.test(privateKey) || /^-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(privateKey.trim())) {
    errors.push(
      "GITHUB_APP_PRIVATE_KEY needs one unquoted or single-quoted line with literal \\n separators.",
    );
  }

  const profiles = value("COMPOSE_PROFILES")
    .split(",")
    .map((profile) => profile.trim());
  for (const [profile, name] of workerSecrets) {
    if (profiles.includes(profile) && !configured(name)) {
      errors.push(
        "Set " +
          name +
          " to an independent random value when COMPOSE_PROFILES includes " +
          profile +
          ".",
      );
    }
  }

  if (mode === "docker") {
    if (!configured("DB_PASSWORD")) {
      errors.push(
        "DB_PASSWORD needs the existing database password on upgrades or a new URL-safe random password on first setup.",
      );
    }
    if (Object.hasOwn(env, "PANEL_PASSWORD")) {
      warnings.push(
        "Remove PANEL_PASSWORD from the environment file after the first successful owner login.",
      );
    }
  } else if (!configured("DATABASE_URL")) {
    errors.push("DATABASE_URL needs the PostgreSQL connection URL for local development.");
  }

  for (const error of errors) console.error("ERROR: " + error);
  for (const warning of warnings) console.error("WARNING: " + warning);
  if (errors.length > 0) {
    console.error("Environment check failed. Update the settings above and rerun the check.");
    return 1;
  }
  console.log("Environment check passed (" + mode + ").");
  return 0;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options }));
  } catch {
    console.error("ERROR: Invalid arguments.\n" + usage);
    return 1;
  }
  if (values.help) {
    console.log(usage + "\nChecks .env in Docker mode by default.");
    return 0;
  }
  if (values.mode !== "docker" && values.mode !== "local") {
    console.error("ERROR: Use --mode docker or --mode local.");
    return 1;
  }

  let env;
  try {
    env = parseEnv(await readFile(values.file, "utf8"));
  } catch {
    console.error(
      "ERROR: Cannot read the environment file. Check the path, permissions, and dotenv syntax.",
    );
    return 1;
  }
  return check(env, values.mode);
}

process.exitCode = await main();
