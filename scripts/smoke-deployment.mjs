import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  if (names !== "app,db,db-backup,nsfw-api,quote-worker") fail();
  for (const [name, service] of Object.entries(config.services)) {
    if (
      service.ports?.length ||
      service.container_name ||
      service.privileged ||
      (service.network_mode && !(name === "quote-worker" && service.network_mode === "none"))
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

export async function expectedMigrationHashes(sourceRoot) {
  const folder = join(sourceRoot, "packages/database/drizzle");
  const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
  return Promise.all(
    journal.entries.map(async ({ tag }) => {
      const sql = await readFile(join(folder, `${tag}.sql`), "utf8");
      return createHash("sha256").update(sql).digest("hex");
    }),
  );
}

export function deploymentProbe({
  sha,
  password,
  botId,
  expectedToken,
  marker,
  create = false,
  wrongKey = false,
  requireQuoteRenderer = true,
}) {
  return `
    const assert = (ok) => { if (!ok) throw new Error('Deployment HTTP check failed'); };
    (async () => {
      const ready = await fetch('http://localhost:3000/api/health/ready');
      const health = await ready.json();
      assert(ready.ok && health.status === 'ready' && health.version === ${JSON.stringify(sha)});
      ${requireQuoteRenderer ? "assert(health.quoteRenderer === true);" : ""}
      for (const path of ['/', '/docs/', '/docs/self-hosting/docker']) {
        const response = await fetch('http://localhost:3000' + path);
        assert(response.ok && response.headers.get('content-type')?.includes('text/html'));
      }
      const denied = await fetch('http://localhost:3000/api/bots');
      assert(denied.status === 401 || denied.status === 403);
      const login = await fetch('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'smoke@example.test', password: ${JSON.stringify(password)} }),
      });
      assert(login.ok && login.headers.get('set-cookie'));
      const cookies = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      const headers = { cookie: cookies, 'content-type': 'application/json', origin: 'http://localhost:3000' };
      const response = await fetch('http://localhost:3000/api/bots' + ${JSON.stringify(create ? "" : "/" + botId)}, {
        headers, ${create ? `method: 'POST', body: JSON.stringify({name: 'Deployment smoke', token: ${JSON.stringify(expectedToken)}, isActive: false}),` : ""}
      });
      const result = await response.json();
      const token = ${JSON.stringify(expectedToken)};
      const [prefix, suffix] = token.split(':');
      const mask = prefix + ':' + suffix.slice(0,3) + '***' + suffix.slice(-3);
      assert(response.ok && result.ok && result.data.isActive === false);
      assert(result.data.tokenMasked === ${wrongKey ? "'(密钥不匹配)'" : "mask"});
      ${create ? 'assert(typeof result.data.id === "string"); console.log(result.data.id);' : `assert(result.data.id === ${JSON.stringify(botId)});`}
      ${marker ? `assert(require('node:fs').readFileSync('/app/data/deployment-smoke.txt', 'utf8') === ${JSON.stringify(marker)});` : ""}
    })().catch(() => { console.error('Deployment HTTP check failed'); process.exit(1); });
  `;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean" },
      sha: { type: "string" },
      "previous-sha": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/smoke-deployment.mjs [--check] [--sha FULL_GIT_SHA] [--previous-sha FULL_GIT_SHA]\nBuild, initialize, verify redeployment and backup failure gating, and independently restore disposable local Compose projects. --previous-sha also tests upgrade from that local Git commit. --check validates isolation only. No real Bot or provider is used.\n",
    );
    return;
  }
  const environment = smokeHostEnvironment(process.env);
  const sha = values.sha ?? (await command("git", ["rev-parse", "HEAD"], environment));
  const previousSha = values["previous-sha"];
  if (!/^[a-f0-9]{40}$/i.test(sha) || (previousSha && !/^[a-f0-9]{40}$/i.test(previousSha)))
    throw new Error("Provide full Git SHAs for the candidate and previous version.");
  if (previousSha && previousSha.toLowerCase() === sha.toLowerCase())
    throw new Error("Upgrade requires two different commits.");
  const directory = await mkdtemp(join(tmpdir(), "deployment-smoke-"));
  const projects = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let phase = "configuration";
  let failure;
  let cleanupFailed = false;
  const stage = (message) => process.stdout.write(`${message}\n`);

  async function createProject(template, restore = false) {
    const project = `deployment-smoke-${randomBytes(12).toString("hex")}`;
    const envPath = join(directory, `${project}.env`);
    const overridePath = join(directory, `${project}.json`);
    const config = {
      project,
      envPath,
      overridePath,
      started: false,
      images: new Set(),
      source: root,
      image: `${project}-candidate`,
      version: sha.toLowerCase(),
      restore,
      template,
    };
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
    config.composeArgs = composeArgs;
    config.compose = (...args) =>
      command(
        "docker",
        [...composeArgs, ...args],
        environment,
        args[0] === "build" ? 1_800_000 : 180_000,
        args[0] === "down" ? undefined : controller.signal,
      );
    config.app = (code) => config.compose("exec", "-T", "app", "node", "-e", code);
    config.sql = (query) =>
      config.compose(
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "bot",
        "-d",
        "cos_tool_bot",
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
        query,
      );
    config.write = async ({ encryptionKey } = {}) => {
      await writeFile(envPath, template, { mode: 0o600 });
      const appEnvironment = {};
      // An incomplete restored account must not be silently repaired by bootstrap.
      if (config.restore) appEnvironment.PANEL_PASSWORD = "";
      if (encryptionKey !== undefined) appEnvironment.ENCRYPTION_KEY = encryptionKey;
      await writeFile(
        overridePath,
        JSON.stringify({
          services: {
            "quote-worker": { image: `${project}-quote-worker`, build: { context: root } },
            app: {
              image: config.image,
              build: { context: config.source, args: { APP_VERSION: config.version } },
              labels: ["traefik.enable=false"],
              environment: appEnvironment,
            },
          },
        }),
        { mode: 0o600 },
      );
      assertSmokeConfig(readJson(await config.compose("config", "--format", "json")), project);
    };
    projects.push(config);
    await config.write();
    return config;
  }

  const boot = (p, recreate = false) =>
    p.compose(
      "up",
      "-d",
      ...(recreate ? ["--no-deps", "--force-recreate"] : []),
      "--wait",
      "--wait-timeout",
      "120",
      "app",
    );
  const inspectService = async (p, service) => {
    const id = await p.compose("ps", "--all", "--quiet", service);
    if (!id || id.includes("\n")) throw new Error(`Expected one ${service} container.`);
    // Select lifecycle fields only: a full inspect contains resolved credentials.
    return readJson(
      await command(
        "docker",
        [
          "inspect",
          "--format",
          '{"id":{{json .Id}},"state":{"StartedAt":{{json .State.StartedAt}},"FinishedAt":{{json .State.FinishedAt}},"Status":{{json .State.Status}},"ExitCode":{{json .State.ExitCode}},"Running":{{json .State.Running}}},"restarts":{{json .RestartCount}}}',
          id,
        ],
        environment,
        30_000,
        controller.signal,
      ),
    );
  };
  const migrationHistory = (p) =>
    p.sql(
      "SELECT coalesce(json_agg(hash ORDER BY id), '[]'::json) FROM drizzle.__drizzle_migrations",
    );
  const backup = async (p) => {
    await p.compose(
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
    await p.compose("cp", "db:/tmp/deployment-smoke.dump", join(directory, "database.dump"));
    await p.compose(
      "exec",
      "-T",
      "app",
      "tar",
      "-cf",
      "/tmp/deployment-smoke-files.tar",
      "-C",
      "/app/data",
      "deployment-smoke.txt",
    );
    await p.compose("cp", "app:/tmp/deployment-smoke-files.tar", join(directory, "files.tar"));
  };

  try {
    const envPath = join(directory, "initial.env");
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
    const initial = await readFile(envPath, "utf8");
    const password = initial.match(/^PANEL_PASSWORD=(.*)$/m)?.[1];
    if (!password) throw new Error("Generated bootstrap password is missing.");
    const template =
      initial.replace(
        /^(?:BOT_TOKEN|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GITHUB_APP_[A-Z_]+|(?:PIXAI|OPENAI_IMAGE|GEMINI_IMAGE)_MCP_URL|HARNESS_[A-Z_]+|LODY_[A-Z_]+|CODING_WORKER_SECRET|MEDIA_WORKER_SECRET)=.*$/gm,
        (line) => `${line.split("=")[0]}=`,
      ) + `\nAPP_VERSION=${sha.toLowerCase()}\nCOMPOSE_PROFILES=\n`;
    const source = await createProject(template);
    const restored = await createProject(template, true);
    if (values.check) {
      stage(
        "Both projects passed isolation configuration; no Docker daemon, container or database was used. Upgrade execution was not tested.",
      );
      return;
    }
    phase = "local Docker preflight";
    let endpoint = environment.DOCKER_HOST;
    if (environment.DOCKER_CONTEXT || !endpoint) {
      const context =
        environment.DOCKER_CONTEXT ?? (await command("docker", ["context", "show"], environment));
      endpoint = readJson(await command("docker", ["context", "inspect", context], environment))[0]
        ?.Endpoints?.docker?.Host;
    }
    assertLocalDockerEndpoint(endpoint);
    const version = await command(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      environment,
    ).catch(() => "");
    if (!/^\d+\.\d+/.test(version))
      throw new Error(
        "Local Docker daemon is unavailable. Start Docker yourself, then rerun deployment:smoke.",
      );
    stage(
      `Docker ${version}; candidate ${sha}; previous ${previousSha ?? "not selected"}. Candidate source is the current directory; uncommitted changes are not a released SHA.`,
    );
    for (const p of projects) {
      for (const args of [
        ["ps", "-aq", "--filter", `label=com.docker.compose.project=${p.project}`],
        ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${p.project}`],
        ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${p.project}`],
      ]) {
        if (await command("docker", args, environment))
          throw new Error("Disposable project already exists; refusing to reuse it.");
      }
    }
    if (previousSha) {
      phase = "previous source archive";
      await command("git", ["cat-file", "-e", `${previousSha}^{commit}`], environment);
      const archive = join(directory, "previous.tar");
      await command(
        "git",
        ["archive", "--format=tar", "--output", archive, previousSha],
        environment,
      );
      source.source = join(directory, "previous");
      await mkdir(source.source, { mode: 0o700 });
      await command("tar", ["-xf", archive, "-C", source.source], environment);
      source.image = `${source.project}-previous`;
      source.version = previousSha.toLowerCase();
      await source.write();
    }
    phase = "image build";
    source.started = true;
    source.images.add(source.image);
    source.images.add(`${source.project}-quote-worker`);
    stage("Building initial image in a disposable project.");
    await source.compose("build", "app", "quote-worker");
    phase = "first boot and owner login";
    await boot(source);
    const expectedToken = `123456789:${randomBytes(24).toString("hex")}`;
    const botId = await source.app(
      deploymentProbe({
        sha: source.version,
        password,
        expectedToken,
        create: true,
        requireQuoteRenderer: !previousSha,
      }),
    );
    if (!/^[a-f0-9-]{36}$/.test(botId)) throw new Error("Synthetic Bot was not created.");
    const marker = randomUUID();
    await source.sql(
      `CREATE TABLE deployment_smoke (marker text NOT NULL); INSERT INTO deployment_smoke VALUES ('${marker}')`,
    );
    await source.app(
      `require('node:fs').writeFileSync('/app/data/deployment-smoke.txt', ${JSON.stringify(marker)}, { mode: 0o600 });`,
    );
    const beforeMigrations = readJson(await migrationHistory(source));
    const ownerQuery = `SELECT u.id || ':' || a.id FROM "user" u JOIN account a ON a.user_id = u.id WHERE u.email = 'smoke@example.test' AND a.provider_id = 'credential'`;
    const ownerIdentity = await source.sql(ownerQuery);
    if (!ownerIdentity) throw new Error("Original credential account is missing.");
    if (!Array.isArray(beforeMigrations) || !beforeMigrations.length)
      throw new Error("No migrations applied.");
    const probe = (wrongKey = false) =>
      deploymentProbe({ sha: sha.toLowerCase(), password, botId, expectedToken, marker, wrongKey });
    stage("Initial boot, owner login, docs and synthetic credential encryption passed.");

    if (previousSha) {
      phase = "pre-upgrade backup";
      await backup(source);
      phase = "candidate upgrade";
      await source.compose("stop", "app");
      source.restore = true;
      source.source = root;
      source.image = `${source.project}-candidate`;
      source.version = sha.toLowerCase();
      source.images.add(source.image);
      await source.write();
      await source.compose("build", "app");
      await boot(source);
      await source.app(probe());
      const after = readJson(await migrationHistory(source));
      if (!beforeMigrations.every((hash, index) => after[index] === hash))
        throw new Error("Upgrade rewrote migration history.");
      stage("Previous-version upgrade preserved account, data, files and encrypted credentials.");
    }
    if ((await source.sql(ownerQuery)) !== ownerIdentity)
      throw new Error("Upgrade replaced the owner account.");
    const expectedMigrations = await expectedMigrationHashes(root);
    if (
      JSON.stringify(readJson(await migrationHistory(source))) !==
      JSON.stringify(expectedMigrations)
    )
      throw new Error("Candidate migrations are incomplete or differ from the source journal.");
    phase = "redeployment without database restart";
    const databaseBefore = await inspectService(source, "db");
    const assertDatabaseUnchanged = async () => {
      const databaseAfter = await inspectService(source, "db");
      if (
        databaseAfter.id !== databaseBefore.id ||
        databaseAfter.state.StartedAt !== databaseBefore.state.StartedAt ||
        databaseAfter.restarts !== databaseBefore.restarts ||
        !databaseAfter.state.Running
      )
        throw new Error("Deployment unexpectedly restarted or replaced the database.");
    };
    const assertBackupReran = async (before) => {
      const after = await inspectService(source, "db-backup");
      if (
        after.state.Status !== "exited" ||
        after.state.ExitCode !== 0 ||
        after.state.StartedAt === before.state.StartedAt
      )
        throw new Error("Deployment did not rerun a successful database backup.");
      return after;
    };
    const firstBackup = await inspectService(source, "db-backup");
    const firstApp = await inspectService(source, "app");
    await source.compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
    const repeatedBackup = await assertBackupReran(firstBackup);
    await assertDatabaseUnchanged();
    const unchangedApp = await inspectService(source, "app");
    if (
      unchangedApp.id !== firstApp.id ||
      unchangedApp.state.StartedAt !== firstApp.state.StartedAt
    )
      throw new Error("Unchanged application unexpectedly restarted.");

    const override = readJson(await readFile(source.overridePath, "utf8"));
    override.services.app.labels.push("deployment.smoke.revision=updated");
    await writeFile(source.overridePath, JSON.stringify(override), { mode: 0o600 });
    await source.compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
    const updatedBackup = await assertBackupReran(repeatedBackup);
    await assertDatabaseUnchanged();
    const updatedApp = await inspectService(source, "app");
    if (
      updatedApp.id === firstApp.id ||
      Date.parse(updatedApp.state.StartedAt) < Date.parse(updatedBackup.state.FinishedAt)
    )
      throw new Error("Updated application did not start after the fresh backup completed.");
    await source.app(probe());
    stage("Repeated deployment reran backups; application update kept the database running.");

    phase = "failed backup blocks application startup";
    const failingOverride = structuredClone(override);
    failingOverride.services.app.labels.push("deployment.smoke.failure=expected");
    // Invalid credentials fail the real pg_dump command in this disposable database.
    failingOverride.services["db-backup"] = {
      environment: { PGPASSWORD: "invalid-smoke-password" },
    };
    await writeFile(source.overridePath, JSON.stringify(failingOverride), { mode: 0o600 });
    let backupBlockedStartup = false;
    try {
      await source.compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
    } catch {
      backupBlockedStartup = true;
    }
    const failedBackup = await inspectService(source, "db-backup");
    const blockedApp = await inspectService(source, "app");
    if (
      !backupBlockedStartup ||
      failedBackup.state.Status !== "exited" ||
      failedBackup.state.ExitCode === 0 ||
      blockedApp.state.Status !== "created"
    )
      throw new Error("Failed backup did not prevent the new application from starting.");
    await assertDatabaseUnchanged();
    await writeFile(source.overridePath, JSON.stringify(override), { mode: 0o600 });
    await source.compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
    await assertBackupReran(failedBackup);
    await assertDatabaseUnchanged();
    await source.app(probe());
    stage("Backup failure blocked application startup; correcting it restored readiness.");
    phase = "container recreation and persistence";
    const migrations = await migrationHistory(source);
    await boot(source, true);
    await source.app(probe());
    if ((await migrationHistory(source)) !== migrations)
      throw new Error("Recreation changed migration history.");
    if ((await source.sql("SELECT marker FROM deployment_smoke")) !== marker)
      throw new Error("Database marker is missing.");
    phase = "candidate backup";
    await backup(source);
    // Stop the source to ensure restore validation cannot accidentally hit the original app.
    await source.compose("stop", "app");
    phase = "independent restore";
    restored.started = true;
    restored.images.add(restored.image);
    restored.images.add(`${restored.project}-quote-worker`);
    await command("docker", ["tag", source.image, restored.image], environment);
    await command(
      "docker",
      ["tag", `${source.project}-quote-worker`, `${restored.project}-quote-worker`],
      environment,
    );
    phase = "restore database boot";
    await restored.compose("up", "-d", "--wait", "--wait-timeout", "120", "db");
    phase = "restore database transfer";
    await restored.compose("cp", join(directory, "database.dump"), "db:/tmp/deployment-smoke.dump");
    phase = "restore database contents";
    await restored.compose(
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      "bot",
      "-d",
      "cos_tool_bot",
      "--exit-on-error",
      "--no-owner",
      "/tmp/deployment-smoke.dump",
    );
    // A one-shot container uses only the new project's volume and never starts the application.
    phase = "restore file volume initialization";
    await restored.compose(
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "sh",
      "app",
      "-c",
      "mkdir -p /app/data",
    );
    phase = "restore stopped application creation";
    await restored.compose("create", "app");
    // docker cp into a stopped container's volume avoids sharing either source volume.
    const localFile = join(directory, "deployment-smoke.txt");
    phase = "restore file extraction";
    await command(
      "tar",
      ["-xf", join(directory, "files.tar"), "-C", directory, "deployment-smoke.txt"],
      environment,
    );
    await restored.compose("cp", localFile, "app:/app/data/deployment-smoke.txt");
    phase = "restored application boot";
    await boot(restored);
    phase = "restored application verification";
    await restored.app(probe());
    if ((await restored.sql(ownerQuery)) !== ownerIdentity)
      throw new Error("Restoration replaced the owner account.");
    if ((await migrationHistory(restored)) !== migrations)
      throw new Error("Restored migration history differs.");
    if ((await restored.sql("SELECT marker FROM deployment_smoke")) !== marker)
      throw new Error("Restored marker is missing.");
    stage(
      "Independent app/database/volumes restored: login, exact credential mask, migrations and files passed.",
    );

    phase = "wrong-key recovery check";
    await restored.write({ encryptionKey: randomBytes(32).toString("hex") });
    await boot(restored, true);
    await restored.app(probe(true));
    phase = "missing-key check";
    await restored.write({ encryptionKey: "" });
    await restored.compose(
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "node",
      "app",
      "-e",
      `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('node', ['packages/server/dist/index.js'], { encoding: 'utf8', timeout: 15000 });
      if (result.error || result.status === 0 || !result.stderr.includes('ENCRYPTION_KEY')) process.exit(1);
    `,
    );
    phase = "restore original key";
    await restored.write();
    await boot(restored, true);
    await restored.app(probe());
    stage(
      "Wrong key was detected through the application; missing key failed startup; original key restored successfully.",
    );
    stage(
      previousSha
        ? "Upgrade and independent restore checks passed; real integrations were not exercised."
        : "Fresh install and independent restore passed; previous-version upgrade was NOT tested (use --previous-sha).",
    );
  } catch (error) {
    failure = new Error(`Deployment smoke failed during ${phase}: ${error.message}`);
  } finally {
    for (const p of projects.toReversed()) {
      if (!p.started) continue;
      let projectCleanupFailed = false;
      try {
        await p.compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
      } catch {
        projectCleanupFailed = true;
      }
      for (const image of p.images) {
        try {
          if (await command("docker", ["image", "ls", "--quiet", image], environment))
            await command("docker", ["image", "rm", image], environment);
        } catch {
          projectCleanupFailed = true;
        }
      }
      if (projectCleanupFailed) {
        cleanupFailed = true;
        const cleanup = `docker ${p.composeArgs.map(shellQuote).join(" ")} down --volumes --remove-orphans --rmi local`;
        failure = new Error(
          `${failure ? failure.message + "\n" : ""}Cleanup failed for ${p.project}. Using the same Docker context, rerun: ${cleanup}. Then remove only these image tags: ${[...p.images].join(", ")}. Temporary configuration is retained privately.`,
        );
      } else stage(`Removed disposable project ${p.project}.`);
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
