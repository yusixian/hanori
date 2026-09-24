import { spawnSync } from "node:child_process";

const requiredEnvironment = {
  ADMIN_CHAT_IDS: "[]",
  AUTH_OWNER_EMAIL: "owner@example.test",
  BETTER_AUTH_SECRET: "validation-secret-at-least-32-characters",
  BETTER_AUTH_URL: "https://bot.example.test",
  CODING_WORKER_SECRET: "validation-coding-worker-secret",
  DB_PASSWORD: "validation-db-password",
  ENCRYPTION_KEY: "validation-encryption-key",
  GITHUB_APP_CLIENT_ID: "",
  HARNESS_LODY_BRIDGE_SECRET: "",
  LODY_CLI_TOKEN: "",
  GITHUB_APP_CLIENT_SECRET: "",
  GITHUB_APP_ID: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_APP_SLUG: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  MINI_APP_SESSION_SECRET: "",
  PANEL_PASSWORD: "validation-owner-password",
};

function renderConfig(files, profiles = "") {
  const args = ["compose"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...requiredEnvironment, COMPOSE_PROFILES: profiles },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dokploy = renderConfig(["docker-compose.yml"]);
const services = dokploy.services;
assert(services.app, "Dokploy config is missing app");
assert(services.db, "Dokploy config is missing db");
assert(services["db-backup"], "Dokploy config is missing the database backup gate");
assert(services["nsfw-api"], "Dokploy config is missing nsfw-api");
assert(!services.app.ports, "Dokploy app must not publish a host port");
assert(!services.db.ports, "Dokploy database must not publish a host port");
assert(!services["nsfw-api"].ports, "Dokploy nsfw-api must not publish a host port");
assert(
  services.app.depends_on?.["db-backup"]?.condition === "service_completed_successfully",
  "app must wait for a successful verified database backup",
);
assert(
  services.app.depends_on?.["db-backup"]?.required !== false,
  "database backup must be a required dependency",
);
assert(
  JSON.stringify(services.app.healthcheck?.test).includes("/api/health/ready"),
  "app healthcheck must use the readiness endpoint",
);
for (const volume of ["pgdata", "backups", "botdata", "codeworkspaces", "codegit"]) {
  assert(dokploy.volumes?.[volume], `Dokploy config is missing persistent volume ${volume}`);
}

const coding = renderConfig(["docker-compose.yml"], "coding");
assert(coding.services["coding-worker"], "coding profile is missing coding-worker");
assert(coding.services["coding-egress-proxy"], "coding profile is missing coding-egress-proxy");

assert(!services["lody-bridge"], "lody-bridge must stay behind the harness profile");
const harness = renderConfig(["docker-compose.yml"], "harness");
const bridge = harness.services["lody-bridge"];
assert(bridge, "harness profile is missing lody-bridge");
assert(!bridge.ports, "lody-bridge must not publish a host port");
assert(bridge.build?.target === "lody-bridge", "lody-bridge must build the glibc bridge stage");
assert(harness.networks?.["harness-bridge"]?.internal === true, "harness-bridge must be internal");
assert(
  Object.keys(bridge.networks ?? {})
    .sort()
    .join() === "harness-bridge,harness-egress",
  "lody-bridge must only join the harness networks",
);
assert(
  Object.keys(harness.services.app.networks ?? {}).includes("harness-bridge"),
  "app must reach lody-bridge on the harness-bridge network",
);
assert(harness.volumes?.lodyhome, "lody-bridge needs the persistent lodyhome volume");

const direct = renderConfig(["docker-compose.yml", "docker-compose.direct.yml"]);
assert(direct.services.app.ports?.length === 1, "legacy direct app port mapping is missing");
assert(
  direct.services["nsfw-api"].ports?.length === 1,
  "legacy direct nsfw-api port mapping is missing",
);

process.stdout.write("Dokploy and legacy Compose contracts are valid.\n");
