import { createHash } from "node:crypto";

const rootFiles = new Set([
  ".gitleaks.toml",
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".npmrc",
  ".node-version",
  ".oxfmtrc.json",
  ".prettierignore",
  "Dockerfile",
  "LICENSE",
  "oxlint.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
  "harness.example.yaml",
  "docker-compose.yml",
  "docker-compose.direct.yml",
  "docker-compose.dev.yml",
]);
const reviewedFixtures = new Set([
  "packages/server/src/harness/__fixtures__/lody-machine-list.txt",
  "packages/server/src/harness/__fixtures__/lody-session-show.txt",
  "packages/server/src/harness/__fixtures__/lody-session-history.txt",
]);
const runtimeScripts = new Set([
  "init-env.mjs",
  "init-env.test.mjs",
  "smoke-deployment.mjs",
  "smoke-deployment.test.mjs",
  "update-production.sh",
  "update-production.test.mjs",
  "check-dokploy-compose.mjs",
  "write-deployment-version.mjs",
  "dev-mini-app.sh",
]);
const packages = "(?:shared|database|bot|server|panel|docs|coding-worker)";
const sourcePath = new RegExp(`^packages/${packages}/(?:src|scripts|app|content|public|drizzle)/`);
const packageFile = new RegExp(`^packages/${packages}/[^/]+$`);
const safeExtensions =
  /\.(?:[cm]?[jt]sx?|json|ya?ml|sql|mdx?|snap|css|html|svg|sh|conf|png|webp|jpe?g|ico|woff2?|ttf)$/i;

export function isPublicPath(path) {
  if (
    path
      .split("/")
      .some((part) =>
        /^(?:\.|\.\.|\.git|node_modules|dist|build|\.source|\.react-router|__screenshots__|\.vitest-attachments|\$OUT)$/.test(
          part,
        ),
      ) ||
    /(?:^|\/)(?:\.env(?!\.example$)|deployment-version|harness\.(?:ya?ml)$)/.test(path) ||
    /packages\/docs\/content\/docs\/changelog\/v[^/]+\.mdx$/.test(path)
  )
    return false;
  if (rootFiles.has(path)) return true;
  if (reviewedFixtures.has(path)) return true;
  if (path.startsWith("scripts/")) return runtimeScripts.has(path.slice(8));
  if (/^docs\/releases\/v\d+\.\d+\.\d+\.md$/.test(path)) return true;
  return (
    safeExtensions.test(path) &&
    (sourcePath.test(path) ||
      packageFile.test(path) ||
      path.startsWith("infrastructure/") ||
      path.startsWith("acceptance/"))
  );
}

// Exact synthetic tokens used by existing diagnostic tests, never a whole-file exemption.
const syntheticBotTokens = new Set([
  "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG",
  "123456789:telegram_bot_secret_1234567890",
]);
const syntheticUrls = new Map([
  [
    "packages/bot/src/tools/rss.test.ts",
    new Set([
      "https://reader:password@example.com",
      "https://other-user:other-password@other.example",
    ]),
  ],
  ["scripts/init-env.test.mjs", new Set(["https://user:secret@bot.example.com"])],
]);
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "provider-token",
    /\b(?:sk-[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  ],
  ["telegram-token", /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["lark-personal-id", /\bou_[a-f0-9]{25,}\b/g],
  ["local-home", /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//g],
  ["credential-in-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:'"`]+:[^\s/@'"`]+@[^\s/'"`]+/gi],
  ["owner-metadata", /example-owner|cosine\.ren|example-compose/gi],
];

export function scanPublicFile(path, data) {
  const text = data.toString("utf8");
  const findings = [];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (
        rule === "telegram-token" &&
        /\.test\.[cm]?[jt]sx?$/.test(path) &&
        syntheticBotTokens.has(match[0])
      )
        continue;
      if (rule === "local-home" && ["/home/node/", "/home/squid/"].includes(match[0])) continue;
      if (rule === "credential-in-url" && syntheticUrls.get(path)?.has(match[0])) continue;
      if (
        rule === "credential-in-url" &&
        path === "docker-compose.yml" &&
        match[0] === "postgresql://bot:${DB_PASSWORD}@db:5432"
      )
        continue;
      if (
        rule === "credential-in-url" &&
        /\.test\.[cm]?[jt]sx?$/.test(path) &&
        match[0] === "postgresql://test:test@localhost:5432"
      )
        continue;
      // Explicit public/local fixtures, not a general exemption for connection strings.
      if (
        rule === "credential-in-url" &&
        /:\/\/bot:password@(?:localhost|127\.0\.0\.1|db|[^/]+\.test):/.test(match[0])
      )
        continue;
      findings.push({ path, line: text.slice(0, match.index).split("\n").length, rule });
    }
  }
  return findings;
}

export function sanitizePublicFile(path, data) {
  if (data.includes(0)) return data;
  let text = data.toString("utf8");
  if (path === "package.json") {
    const pkg = parsePublicJson(text, path);
    delete pkg.scripts["public:export"];
    delete pkg.scripts["public:check"];
    delete pkg.scripts["public:sync"];
    text = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  if (path === "docker-compose.yml" || path === "scripts/check-dokploy-compose.mjs") {
    text = text.replaceAll("example-compose", "app-proxy");
  }
  if (path === "scripts/dev-mini-app.sh") {
    text = text.replace("https://tg-test.example.invalid", "");
  }
  if (path.startsWith("docs/releases/")) {
    // Keep released behavior, remove private links rather than invent public PR numbers.
    text = text.replace(/\[([^\]]+)\]\(https:\/\/github\.com\/example-owner\/[^)]+\)/g, "$1");
  }
  if (/\.(?:test\.[cm]?[jt]sx?|test\.ts\.snap)$/.test(path) || path.endsWith("/test-fakes.ts")) {
    text = text.replace(/example-owner/gi, (name) =>
      name === name.toLowerCase()
        ? "demo-org"
        : name === name.toUpperCase()
          ? "DEMO-ORG"
          : "Demo-Org",
    );
  }
  if (path === ".env.example") {
    text = text.replace(
      "docs/GITHUB_APP.md",
      "packages/docs/content/docs/integrations/github-pi.mdx",
    );
  }
  if (path === "harness.example.yaml") {
    text = text.replace(
      "docs/design/dev-harness-config.md",
      "packages/docs/content/docs/integrations/dev-harness.mdx",
    );
    text = text.replaceAll("example-owner", "example-owner");
  }
  return Buffer.from(text);
}

export function fileHash(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function parsePublicJson(data, path) {
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`Invalid JSON in ${path}; contents are not printed.`);
  }
}
