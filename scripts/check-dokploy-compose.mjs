import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  MEDIA_WORKER_SECRET: "validation-media-worker-secret-at-least-32-characters",
  TRAEFIK_DOCKER_NETWORK: process.env.TRAEFIK_DOCKER_NETWORK || "validation-proxy",
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
// Dokploy v0.29.14 injects domain router labels only when the source uses a label list.
const composeSource = readFileSync("docker-compose.yml", "utf8");
assert(
  /^    labels:\n      - traefik\.docker\.network=/m.test(composeSource),
  "Dokploy app labels must use list syntax so domain routers are injected",
);
const services = dokploy.services;
assert(services.app, "Dokploy config is missing app");
assert(services.db, "Dokploy config is missing db");
assert(services["db-backup"], "Dokploy config is missing the database backup gate");
assert(services["nsfw-api"], "Dokploy config is missing nsfw-api");
assert(!services.app.ports, "Dokploy app must not publish a host port");
assert(
  services.app.labels?.["traefik.docker.network"] === requiredEnvironment.TRAEFIK_DOCKER_NETWORK,
  "Dokploy app must pin Traefik to its shared network",
);
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

const quote = services["quote-worker"];
assert(quote && !quote.profiles?.length, "quote-worker must be enabled without a profile");
assert(quote.build?.target === "quote-worker", "quote-worker must build its native renderer image");
assert(
  quote.network_mode === "none" &&
    !Object.keys(quote.networks ?? {}).length &&
    !quote.ports?.length,
  "quote-worker must remain offline",
);
assert(
  quote.read_only && quote.user === "1000:1000",
  "quote-worker must use read-only root and unprivileged UID 1000",
);
assert(
  quote.cap_drop?.includes("ALL") &&
    !quote.cap_add?.length &&
    quote.security_opt?.includes("no-new-privileges:true"),
  "quote-worker must not gain privileges",
);
assert(
  !quote.privileged && !quote.devices?.length && !quote.secrets?.length && !quote.configs?.length,
  "quote-worker must not receive host resources or credentials",
);
assert(
  quote.mem_limit > 0 &&
    quote.mem_limit <= 512 * 1024 * 1024 &&
    quote.cpus > 0 &&
    quote.cpus <= 1 &&
    quote.pids_limit > 0 &&
    quote.pids_limit <= 32,
  "quote-worker resource limits are required",
);
assert(
  Object.keys(quote.environment ?? {}).join() === "QUOTE_WORKER_SOCKET",
  "quote-worker may receive only its Unix socket path",
);
assert(
  quote.environment.QUOTE_WORKER_SOCKET === "/quote-control/worker.sock" &&
    services.app.environment.QUOTE_WORKER_SOCKET === "/quote-control/worker.sock",
  "app and quote-worker socket paths must match",
);
assert(
  quote.volumes?.length === 1 &&
    quote.volumes[0].type === "volume" &&
    quote.volumes[0].source === "quotecontrol" &&
    quote.volumes[0].target === "/quote-control",
  "quote-worker may share only its socket volume",
);
assert(
  services.app.volumes.some(
    (mount) => mount.source === "quotecontrol" && mount.target === "/quote-control",
  ),
  "app must mount the quote socket volume",
);
assert(
  services.app.depends_on?.["quote-worker"]?.condition === "service_healthy",
  "app startup must wait for the real renderer probe",
);
assert(
  quote.tmpfs?.length === 1 && quote.tmpfs[0] === "/tmp:size=128m,mode=1777",
  "quote-worker temporary files must be bounded",
);
assert(
  dokploy.volumes?.quotecontrol?.driver_opts?.o === "size=1048576,uid=0,gid=1000,mode=0770",
  "quote socket volume must be bounded and private to root/worker group",
);
assert(
  JSON.stringify(quote.healthcheck?.test).includes("/health"),
  "quote-worker needs its native renderer health check",
);

const coding = renderConfig(["docker-compose.yml"], "coding");
assert(coding.services["coding-worker"], "coding profile is missing coding-worker");
assert(coding.services["coding-egress-proxy"], "coding profile is missing coding-egress-proxy");

assert(!services["media-worker"], "media-worker must stay behind the media profile");
function validateMedia(config) {
  const worker = config.services["media-worker"];
  assert(worker, "media profile is missing media-worker");
  assert(
    worker.build?.target === "media-worker",
    "media-worker must build its isolated image stage",
  );
  assert(worker.network_mode === "none", "media-worker must have no network");
  assert(
    !Object.keys(worker.networks ?? {}).length,
    "media-worker must not join any Compose network",
  );
  assert(!worker.ports?.length, "media-worker must not publish host ports");
  assert(worker.read_only === true, "media-worker root filesystem must be read-only");
  assert(
    !worker.user || ["node", "1000", "1000:1000"].includes(worker.user),
    "media-worker Compose UID must stay unprivileged UID 1000",
  );
  assert(
    worker.cap_drop?.includes("ALL") && !worker.cap_add?.length,
    "media-worker must drop all capabilities",
  );
  assert(
    worker.security_opt?.includes("no-new-privileges:true"),
    "media-worker must prevent privilege escalation",
  );
  assert(
    !worker.privileged && !worker.devices?.length && worker.pid !== "host" && worker.ipc !== "host",
    "media-worker must not share privileged host resources",
  );
  assert(
    !worker.secrets?.length && !worker.configs?.length,
    "media-worker must not mount application secrets or extra configuration",
  );
  assert(
    worker.pids_limit > 0 && worker.pids_limit <= 32,
    "media-worker must bound subprocesses to 32",
  );
  assert(
    worker.mem_limit > 0 && worker.mem_limit <= 256 * 1024 * 1024,
    "media-worker must bound memory to 256 MiB",
  );
  assert(worker.cpus > 0 && worker.cpus <= 1, "media-worker must bound CPU to one core");
  const expectedMounts = { mediajobs: "/media-jobs", mediacontrol: "/media-control" };
  assert(worker.volumes?.length === 2, "media-worker may mount only its two shared media volumes");
  for (const [source, target] of Object.entries(expectedMounts)) {
    assert(
      worker.volumes.some(
        (mount) =>
          mount.type === "volume" &&
          mount.source === source &&
          mount.target === target &&
          !mount.read_only,
      ),
      `media-worker needs only the ${source} shared volume at ${target}`,
    );
    assert(
      config.services.app.volumes.some(
        (mount) =>
          mount.type === "volume" &&
          mount.source === source &&
          mount.target === target &&
          !mount.read_only,
      ),
      `app must share ${source} with media-worker`,
    );
  }
  assert(
    Object.keys(worker.environment ?? {})
      .sort()
      .join() === "MEDIA_JOB_DIR,MEDIA_WORKER_SECRET,MEDIA_WORKER_SOCKET",
    "media-worker must receive only its transport secret and media paths",
  );
  assert(
    worker.environment.MEDIA_JOB_DIR === "/media-jobs" &&
      worker.environment.MEDIA_WORKER_SOCKET === "/media-control/worker.sock",
    "media-worker must use the shared job directory and Unix socket",
  );
  assert(
    worker.environment.MEDIA_WORKER_SECRET === config.services.app.environment.MEDIA_WORKER_SECRET,
    "app and media-worker must use the same transport secret",
  );
  assert(
    config.services.app.environment.MEDIA_WORKER_GID === "1000",
    "app must grant media file access only to worker GID 1000",
  );
  const tmpfs = worker.tmpfs ?? [];
  assert(
    tmpfs.length === 1 &&
      tmpfs[0].startsWith("/tmp:") &&
      /(?:^|,)size=64m(?:,|$)/.test(tmpfs[0].split(":")[1]),
    "media-worker may use only a bounded 64 MiB /tmp tmpfs",
  );
  for (const [name, gid, mode, size] of [
    ["mediajobs", "0", "0755", "268435456"],
    ["mediacontrol", "1000", "0770", "1048576"],
  ]) {
    const volume = config.volumes?.[name];
    assert(
      volume?.driver === "local" &&
        volume.driver_opts?.type === "tmpfs" &&
        volume.driver_opts?.device === "tmpfs",
      `${name} must be a bounded tmpfs volume`,
    );
    const options = Object.fromEntries(
      volume.driver_opts.o.split(",").map((option) => option.split("=")),
    );
    assert(
      options.uid === "0" && options.gid === gid && options.mode === mode && options.size === size,
      `${name} must preserve the root-owned UID/GID/mode and disk bound`,
    );
  }
  const health = JSON.stringify(worker.healthcheck?.test);
  assert(
    health?.includes("/health") &&
      health.includes("socketPath") &&
      health.includes("MEDIA_WORKER_SECRET"),
    "media-worker health must check the authenticated Unix socket",
  );
}
const dockerfile = readFileSync("Dockerfile", "utf8");
function imageStage(name) {
  const lines = dockerfile.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^FROM .+ AS ${name}$`, "i").test(line));
  assert(start >= 0, `Dockerfile is missing ${name} stage`);
  const end = lines.findIndex((line, index) => index > start && /^FROM /i.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}
const mediaImage = imageStage("media-worker");
const mediaUsers = [...mediaImage.matchAll(/^USER\s+(.+)$/gm)].map((match) => match[1].trim());
assert(
  ["node", "1000", "1000:1000"].includes(mediaUsers.at(-1)),
  "media-worker image must run as the unprivileged Node UID 1000",
);
assert(
  !/^(?:ENTRYPOINT|CMD).*su-exec/m.test(mediaImage),
  "media-worker must not elevate its entrypoint",
);
const appUsers = [...imageStage("runner").matchAll(/^USER\s+(.+)$/gm)].map((match) =>
  match[1].trim(),
);
assert(
  !appUsers.length || ["root", "0", "0:0"].includes(appUsers.at(-1)),
  "app must own the media job parent as UID 0",
);
const finalAppUsers = [...imageStage("app").matchAll(/^USER\s+(.+)$/gm)].map((match) =>
  match[1].trim(),
);
assert(
  !finalAppUsers.length || ["root", "0", "0:0"].includes(finalAppUsers.at(-1)),
  "final app image must preserve UID 0 for media directory ownership",
);
assert(
  !dokploy.services.app.user || ["root", "0", "0:0"].includes(dokploy.services.app.user),
  "app Compose UID must preserve root ownership of media directories",
);
validateMedia(renderConfig(["docker-compose.yml"], "media"));
const combined = renderConfig(["docker-compose.yml"], "coding,harness,media");
validateMedia(combined);
assert(
  combined.services["coding-worker"] &&
    combined.services["coding-egress-proxy"] &&
    combined.services["lody-bridge"],
  "media must compose with coding and harness profiles",
);

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
validateMedia(renderConfig(["docker-compose.yml", "docker-compose.direct.yml"], "media"));

process.stdout.write("Dokploy and legacy Compose contracts are valid.\n");
