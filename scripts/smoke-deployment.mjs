import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hostKeys = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
];

export function smokeHostEnvironment(host) {
  return Object.fromEntries(
    hostKeys.filter((key) => host[key] !== undefined).map((key) => [key, host[key]]),
  );
}

export function assertLocalDockerEndpoint(endpoint) {
  if (!endpoint?.startsWith("unix:///")) {
    throw new Error("Deployment smoke checks require a local Unix-socket Docker daemon.");
  }
}

export function assertSmokeConfig(config, project) {
  const fail = () => {
    throw new Error("Compose configuration is not isolated; no containers were started.");
  };
  if (!/^deployment-smoke-[a-f0-9]{24}$/.test(project) || config.name !== project) fail();
  for (const resources of [config.volumes, config.networks]) {
    if (!resources || !Object.keys(resources).length) fail();
    for (const resource of Object.values(resources)) {
      if (resource.external || !resource.name?.startsWith(`${project}_`)) fail();
      if (resource.driver && !["local", "bridge"].includes(resource.driver)) fail();
      if (
        resource.driver_opts &&
        (resource.driver_opts.type !== "tmpfs" || resource.driver_opts.device !== "tmpfs")
      )
        fail();
    }
  }
  const names = Object.keys(config.services ?? {})
    .sort()
    .join();
  if (names !== "app,db,db-backup,nsfw-api") fail();
  for (const service of Object.values(config.services)) {
    if (
      service.ports?.length ||
      service.container_name ||
      service.privileged ||
      service.network_mode
    )
      fail();
    if (service.env_file?.length || service.external_links?.length || service.volumes_from?.length)
      fail();
    if (service.devices?.length || service.secrets?.length || service.configs?.length) fail();
    if (Object.keys(service.networks ?? {}).some((name) => !config.networks[name])) fail();
    for (const mount of service.volumes ?? []) {
      if (mount.type !== "volume" || !config.volumes[mount.source]) fail();
    }
  }
  const environment = config.services.app.environment ?? {};
  const image = config.services.app.image;
  if (image && !image.startsWith(`${project}-`)) fail();
  if (config.services.app.labels?.["traefik.enable"] !== "false") fail();
  if (
    environment.BOT_TOKEN ||
    environment.HARNESS_CONFIG_PATH ||
    environment.HARNESS_LODY_BRIDGE_URL
  )
    fail();
  if (
    !/^postgresql:\/\/bot:[a-f0-9]{64}@db:5432\/cos_tool_bot$/.test(environment.DATABASE_URL ?? "")
  )
    fail();
}

function command(file, args, environment, timeout = 120_000, signal) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const output = [];
    let size = 0;
    const collect = (chunk) => {
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) output.push(chunk);
    };
    child.stdout.on("data", collect);
    // Docker errors may contain resolved credentials. Do not forward raw stderr or command arguments.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not execute ${file}.`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 8 * 1024 * 1024)
        reject(new Error(`${file} check failed or timed out; raw output is withheld.`));
      else accept(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid tool response; contents are withheld.");
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { check: { type: "boolean" }, sha: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/smoke-deployment.mjs [--check] [--sha FULL_GIT_SHA]\nDefault: build, initialize, recreate and restore a disposable local Compose project, then remove it. --check only renders and validates isolation. Archives require --sha. No real Bot or provider is used.\n",
    );
    return;
  }
  const environment = smokeHostEnvironment(process.env);
  const sha = values.sha ?? (await command("git", ["rev-parse", "HEAD"], environment));
  if (!/^[a-f0-9]{40}$/i.test(sha))
    throw new Error("Provide --sha with the candidate's full Git SHA.");
  const project = `deployment-smoke-${randomBytes(12).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "deployment-smoke-"));
  const envPath = join(directory, ".env");
  const overridePath = join(directory, "compose.json");
  let resourcesStarted = false;
  let phase = "configuration";
  let failure;
  let cleanupFailed = false;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const composeArgs = [
    "compose",
    "--project-directory",
    root,
    "--project-name",
    project,
    "--env-file",
    envPath,
    "-f",
    join(root, "docker-compose.yml"),
    "-f",
    overridePath,
  ];
  const compose = (...args) =>
    command(
      "docker",
      [...composeArgs, ...args],
      environment,
      args[0] === "build" ? 1_800_000 : 180_000,
      args[0] === "down" ? undefined : controller.signal,
    );
  const app = (code) => compose("exec", "-T", "app", "node", "-e", code);
  const sql = (query, database = "cos_tool_bot") =>
    compose(
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "bot",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      query,
    );
  const stage = (message) => process.stdout.write(`${message}\n`);
  try {
    await command(
      process.execPath,
      [
        join(root, "scripts/init-env.mjs"),
        "--email",
        "smoke@example.test",
        "--url",
        "http://localhost:3000",
        "--output",
        envPath,
      ],
      environment,
    );
    // Explicitly clear optional integrations in case the development template later changes defaults.
    const template = await readFile(envPath, "utf8");
    const cleared = template.replace(
      /^(?:BOT_TOKEN|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GITHUB_APP_[A-Z_]+|PIXAI_MCP_URL|HARNESS_[A-Z_]+|LODY_[A-Z_]+|CODING_WORKER_SECRET)=.*$/gm,
      (line) => `${line.split("=")[0]}=`,
    );
    await writeFile(envPath, `${cleared}\nAPP_VERSION=${sha.toLowerCase()}\nCOMPOSE_PROFILES=\n`, {
      mode: 0o600,
    });
    await writeFile(
      overridePath,
      JSON.stringify({
        services: {
          app: {
            build: { args: { APP_VERSION: sha.toLowerCase() } },
            labels: ["traefik.enable=false"],
          },
        },
      }),
      { mode: 0o600 },
    );
    const config = readJson(await compose("config", "--format", "json"));
    assertSmokeConfig(config, project);
    if (values.check) {
      stage("Isolation configuration passed; no Docker daemon, container or database was used.");
      return;
    }
    let endpoint = environment.DOCKER_HOST;
    phase = "local Docker preflight";
    if (environment.DOCKER_CONTEXT || !endpoint) {
      const context =
        environment.DOCKER_CONTEXT ?? (await command("docker", ["context", "show"], environment));
      endpoint = readJson(await command("docker", ["context", "inspect", context], environment))[0]
        ?.Endpoints?.docker?.Host;
    }
    assertLocalDockerEndpoint(endpoint);
    try {
      const version = await command(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        environment,
      );
      // Some Docker CLI versions return exit 0 with an empty version when the daemon is offline.
      if (!/^\d+\.\d+/.test(version)) throw new Error("Docker daemon is unavailable.");
    } catch {
      throw new Error(
        "Local Docker daemon is unavailable. Start Docker yourself, then rerun deployment:smoke.",
      );
    }
    for (const args of [
      ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
      ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`],
    ]) {
      if (await command("docker", args, environment))
        throw new Error("Disposable project already exists; refusing to reuse it.");
    }
    stage("Building candidate image; this may take several minutes. No existing instance is used.");
    phase = "image build";
    // Set before build so failed builds also clean up this project's image and resources.
    resourcesStarted = true;
    await compose("build", "app");
    phase = "first boot and owner login";
    await compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
    const probe = `
      const assert = (ok) => { if (!ok) throw new Error('Deployment HTTP check failed'); };
      (async () => {
        const ready = await fetch('http://localhost:3000/api/health/ready');
        const health = await ready.json();
        assert(ready.ok && health.status === 'ready' && health.version === ${JSON.stringify(sha.toLowerCase())});
        for (const path of ['/', '/docs/', '/docs/self-hosting/docker']) {
          const response = await fetch('http://localhost:3000' + path);
          assert(response.ok && response.headers.get('content-type')?.includes('text/html'));
        }
        const denied = await fetch('http://localhost:3000/api/bots');
        assert(denied.status === 401 || denied.status === 403);
        const login = await fetch('http://localhost:3000/api/auth/sign-in/email', {
          method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ email: process.env.AUTH_OWNER_EMAIL, password: process.env.PANEL_PASSWORD }),
        });
        assert(login.ok && login.headers.get('set-cookie'));
        const cookies = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
        const bots = await fetch('http://localhost:3000/api/bots', { headers: { cookie: cookies } });
        assert(bots.ok);
      })().catch(() => { console.error('Deployment HTTP check failed'); process.exit(1); });
    `;
    await app(probe);
    const migrations = await sql("SELECT count(*) FROM drizzle.__drizzle_migrations");
    if (!/^\d+$/.test(migrations) || Number(migrations) === 0)
      throw new Error("No database migrations were applied.");
    const marker = randomUUID();
    await sql(
      `CREATE TABLE deployment_smoke (marker text NOT NULL); INSERT INTO deployment_smoke VALUES ('${marker}')`,
    );
    await app(
      `require('node:fs').writeFileSync('/app/data/deployment-smoke.txt', ${JSON.stringify(marker)}, { mode: 0o600 });`,
    );
    stage("First boot, migrations, anonymous docs and owner login passed without a Bot Token.");
    phase = "database and file backup";
    await compose(
      "exec",
      "-T",
      "db",
      "pg_dump",
      "-U",
      "bot",
      "-d",
      "cos_tool_bot",
      "-Fc",
      "-f",
      "/tmp/deployment-smoke.dump",
    );
    await compose("exec", "-T", "db", "pg_restore", "--list", "/tmp/deployment-smoke.dump");
    await compose(
      "exec",
      "-T",
      "app",
      "tar",
      "-cf",
      "/data/backups/deployment-smoke-files.tar",
      "-C",
      "/app/data",
      "deployment-smoke.txt",
    );
    phase = "container recreation and persistence";
    await compose(
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "app",
    );
    await app(probe);
    if ((await sql("SELECT marker FROM deployment_smoke")) !== marker)
      throw new Error("Database data did not survive recreation.");
    if ((await sql("SELECT count(*) FROM drizzle.__drizzle_migrations")) !== migrations)
      throw new Error("Recreation unexpectedly changed migration history.");
    await app(
      `if (require('node:fs').readFileSync('/app/data/deployment-smoke.txt', 'utf8') !== ${JSON.stringify(marker)}) process.exit(1);`,
    );
    stage("Recreation preserved login, database data, migrations and mounted files.");
    phase = "database and file restoration";
    // This is a new database in the disposable PostgreSQL container, never a user's database.
    await sql("CREATE DATABASE deployment_smoke_restore");
    await compose(
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      "bot",
      "-d",
      "deployment_smoke_restore",
      "--exit-on-error",
      "--no-owner",
      "/tmp/deployment-smoke.dump",
    );
    if ((await sql("SELECT marker FROM deployment_smoke", "deployment_smoke_restore")) !== marker)
      throw new Error("Restored database marker is missing.");
    if (
      (await sql(
        "SELECT count(*) FROM drizzle.__drizzle_migrations",
        "deployment_smoke_restore",
      )) !== migrations
    )
      throw new Error("Restored migration history differs.");
    if (
      (await sql(
        `SELECT count(*) FROM "user" WHERE email = 'smoke@example.test'`,
        "deployment_smoke_restore",
      )) !== "1"
    )
      throw new Error("Restored owner is missing.");
    await app("require('node:fs').unlinkSync('/app/data/deployment-smoke.txt');");
    await compose(
      "exec",
      "-T",
      "app",
      "tar",
      "-xf",
      "/data/backups/deployment-smoke-files.tar",
      "-C",
      "/app/data",
      "deployment-smoke.txt",
    );
    await app(
      `if (require('node:fs').readFileSync('/app/data/deployment-smoke.txt', 'utf8') !== ${JSON.stringify(marker)}) process.exit(1);`,
    );
    stage(
      "Database and mounted-file backup restoration passed. Previous-version upgrades and real integrations still require separate checks.",
    );
  } catch (error) {
    failure = new Error(`Deployment smoke failed during ${phase}: ${error.message}`);
  } finally {
    try {
      if (resourcesStarted) {
        await compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
        stage(
          "Removed this disposable project's containers, volumes, networks and application image.",
        );
      }
    } catch {
      // Keep the private temporary configuration for an exact, narrowly scoped manual cleanup.
      cleanupFailed = true;
      const cleanupError = new Error(
        `Cleanup failed for ${project}. Using the same Docker context, rerun: docker compose --project-directory ${shellQuote(root)} --project-name ${project} --env-file ${shellQuote(envPath)} -f ${shellQuote(join(root, "docker-compose.yml"))} -f ${shellQuote(overridePath)} down --volumes --remove-orphans --rmi local. Temporary configuration is retained privately.`,
      );
      failure = new Error(`${failure ? `${failure.message}\n` : ""}${cleanupError.message}`);
    }
    if (!cleanupFailed) await rm(directory, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
