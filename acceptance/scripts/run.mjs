// Starts the isolated acceptance environment and runs Playwright against it.
//
//   pnpm acceptance [--skip-build] [playwright args...]
//
// Environment isolation (project-specific part):
//   - dedicated PostgreSQL database `cos_tool_bot_acceptance` in an independent Compose project
//   - server on http://localhost:43110 with throwaway credentials
//   - panel production build served by the server from .acceptance/app/public
//   - no BOT_TOKEN: no Telegram connections are made
//
// Run bookkeeping (evidence-index aggregation, .acceptance/latest, pruning)
// follows the frontend-acceptance skill template.

import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { pruneRuns } from "./clean.mjs";
import { ACCEPTANCE_ENCRYPTION_KEY, createAcceptanceServerEnvironment } from "./environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- CLI args ------------------------------------------------------------------
// pnpm forwards the literal "--" separator; strip it so Playwright flags parse.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const skipBuild = args.includes("--skip-build");
const playwrightArgs = args.filter((a) => a !== "--skip-build");

// --- Constants ------------------------------------------------------------------
const ACCEPTANCE_PORT = 43110;
const BASE_URL = `http://localhost:${ACCEPTANCE_PORT}`;
const DB_NAME = "cos_tool_bot_acceptance";
const DB_PORT = Number(process.env.ACCEPTANCE_DB_PORT || 55434);
const DATABASE_URL = `postgresql://bot:password@localhost:${DB_PORT}/${DB_NAME}`;
const OWNER_EMAIL = "owner@acceptance.test";
const OWNER_PASSWORD = "acceptance-password-123";
const BETTER_AUTH_SECRET = "acceptance-only-secret-not-used-in-production";
const APP_DIR = ".acceptance/app";
const UNIFIED_GENERATION_ID = "5b3d1f77-e6c8-4bd0-b97c-0de9d4a37165";
const COMPOSE_ARGS = ["compose", "-p", "cos-bot-acceptance", "-f", "docker-compose.dev.yml"];

const runsRoot = path.join(root, ".acceptance", "runs");
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const runDir = path.join(runsRoot, runId);

function docker(...cmdArgs) {
  return spawnSync("docker", cmdArgs, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, POSTGRES_DEV_PORT: String(DB_PORT) },
  });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`);
}

function ensurePortFree() {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${ACCEPTANCE_PORT}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  const pids = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pids.length) {
    throw new Error(`Acceptance port ${ACCEPTANCE_PORT} is occupied by PID ${pids.join(", ")}`);
  }
}

function ensureDatabase() {
  const up = docker(...COMPOSE_ARGS, "up", "-d", "db");
  if (up.status !== 0) {
    throw new Error(`Failed to start acceptance database container:\n${up.stderr}`);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const check = docker(
      ...COMPOSE_ARGS,
      "exec",
      "-T",
      "db",
      "pg_isready",
      "-U",
      "bot",
      "-d",
      "postgres",
    );
    if (check.status === 0) break;
    spawnSync("sleep", ["1"]);
    if (attempt === 29) throw new Error("Acceptance database container never became ready");
  }
  const exists = docker(
    ...COMPOSE_ARGS,
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "bot",
    "-d",
    "postgres",
    "-tc",
    `SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`,
  );
  if (!exists.stdout.includes("1")) {
    const create = docker(
      ...COMPOSE_ARGS,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "bot",
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE ${DB_NAME}`,
    );
    if (create.status !== 0) throw new Error(`Failed to create ${DB_NAME}:\n${create.stderr}`);
    console.log(`[acceptance] created database ${DB_NAME}`);
  }
}

function preparePanelBuild() {
  if (!skipBuild) {
    console.log("[acceptance] building panel…");
    const build = spawnSync("pnpm", ["--filter", "@cos-tool-bot/panel", "build"], {
      cwd: root,
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("panel build failed");
  }
  const dist = path.join(root, "packages/panel/dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error("packages/panel/dist/index.html missing; run without --skip-build");
  }
  const publicDir = path.join(root, APP_DIR, "public");
  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.cpSync(dist, publicDir, { recursive: true });
}

function encryptToken(plaintext) {
  const key = scryptSync(ACCEPTANCE_ENCRYPTION_KEY, "cos-tool-bot-salt", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function createAcceptancePng(width, height, variant = 0) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.72, ny - 0.32) * 5);
      const offset = row + 1 + x * 4;
      rows[offset] = Math.round(18 + 80 * nx + glow * (variant ? 70 : 150));
      rows[offset + 1] = Math.round(28 + 65 * ny + glow * (variant ? 120 : 95));
      rows[offset + 2] = Math.round(72 + 105 * (1 - nx) + glow * (variant ? 110 : 30));
      rows[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Inserts one inactive demo bot so bot-scoped pages are reachable. Inactive on
// purpose: BotPool must never dial Telegram from the acceptance environment.
function seedBot() {
  const token = encryptToken("123456:acceptance-fake-token");
  const providerApiKey = encryptToken("acceptance-fake-provider-key");
  const aiConfig = JSON.stringify({
    enabled: false,
    encryptedApiKey: providerApiKey,
    baseURL: "https://api.example.test/v1",
    model: "acceptance-model",
    systemPrompt: "You are the acceptance bot.",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    privateChatAccess: "all",
  }).replaceAll("'", "''");
  const sql = `DELETE FROM bots WHERE name = 'Acceptance Bot';
    WITH b AS (
      INSERT INTO bots (name, platform, encrypted_token, is_active, mini_app_enabled, ai_config)
      VALUES ('Acceptance Bot', 'telegram', '${token}', false, true, '${aiConfig}'::jsonb)
      RETURNING id
    )
    INSERT INTO telegram_bot_profiles (bot_id, telegram_user_id, username, display_name)
    SELECT id, 123456789, 'acceptance_bot', 'Acceptance Bot' FROM b
    RETURNING bot_id;`;
  const result = docker(
    ...COMPOSE_ARGS,
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "bot",
    "-d",
    DB_NAME,
    "-At",
    "-c",
    sql,
  );
  if (result.status !== 0) throw new Error(`Failed to seed bot:\n${result.stderr}`);
  const botId = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f-]{36}$/i.test(line));
  if (!botId) throw new Error(`Failed to parse seeded bot id from:\n${result.stdout}`);
  const imageDir = path.join(root, APP_DIR, "data", botId, "generations");
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, "acceptance-current.png"), createAcceptancePng(960, 570));
  fs.writeFileSync(path.join(imageDir, "acceptance-legacy.png"), createAcceptancePng(640, 640, 1));
  const generationSql = `
    INSERT INTO image_generations (
      id, bot_id, chat_id, user_id, provider, purpose, preset_key, idempotency_key,
      provider_operation_id, state, provider_state, prompt, negative_prompt, seed,
      request_snapshot, artifacts, local_files, completed_at, delivered_at
    ) VALUES (
      '${UNIFIED_GENERATION_ID}', '${botId}', -100001, 900001, 'mcp_pixai',
      'anime_illustration', 'wallpaper-night', 'acceptance:${botId}:generation',
      'operation-acceptance', 'succeeded', 'completed',
      'character: sakayori_iroha, character: kaguya_(cho_kaguya-hime!), 2girls, cozy bedroom, late night, composing music, MIDI keyboard, sheet music, warm desk lamp, moonlight, detailed anime illustration',
      'low quality, blurry, malformed hands', 20260902,
      '{"presetKey":"wallpaper-night","modelVersionId":"model-version-acceptance","width":1536,"height":912,"batchSize":1,"samplingSteps":28,"cfgScale":6.5,"sampler":"Euler a","promptHelper":true}'::jsonb,
      '[{"ordinal":0,"mimeType":"image/png","filename":"acceptance-current.png"}]'::jsonb,
      '["acceptance-current.png"]'::jsonb, now() - interval '2 minutes', now() - interval '1 minute'
    );
    INSERT INTO image_generation_events (generation_id, bot_id, kind, state, provider_state, created_at)
    VALUES
      ('${UNIFIED_GENERATION_ID}', '${botId}', 'created', 'preparing', null, now() - interval '5 minutes'),
      ('${UNIFIED_GENERATION_ID}', '${botId}', 'submitted', 'queued', 'queued', now() - interval '4 minutes'),
      ('${UNIFIED_GENERATION_ID}', '${botId}', 'artifacts_saved', 'succeeded', 'completed', now() - interval '2 minutes'),
      ('${UNIFIED_GENERATION_ID}', '${botId}', 'delivered', 'succeeded', 'completed', now() - interval '1 minute');
    INSERT INTO pixai_generations (
      bot_id, chat_id, user_id, task_id, prompt, negative_prompt, model_id, width,
      height, batch_size, status, local_files, sampling_steps, cfg_scale,
      prompt_helper, completed_at
    ) VALUES (
      '${botId}', -100002, 900002, 'legacy-acceptance-task',
      'legacy anime portrait, starlight, intricate costume, cinematic lighting',
      'low quality', 'legacy-model', 1024, 1024, 1, 'completed',
      '["acceptance-legacy.png"]'::jsonb, 24, 7, true, now() - interval '1 day'
    ) RETURNING id;`;
  const generationResult = docker(
    ...COMPOSE_ARGS,
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "bot",
    "-d",
    DB_NAME,
    "-At",
    "-c",
    generationSql,
  );
  if (generationResult.status !== 0) {
    throw new Error(`Failed to seed generations:\n${generationResult.stderr}`);
  }
  const legacyGenerationId = generationResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\d+$/.test(line));
  fs.writeFileSync(
    path.join(runDir, "seed.json"),
    JSON.stringify(
      { botId, unifiedGenerationId: UNIFIED_GENERATION_ID, legacyGenerationId },
      null,
      2,
    ),
  );
  console.log(`[acceptance] seeded bot ${botId}`);
}

async function main() {
  ensurePortFree();
  ensureDatabase();
  preparePanelBuild();

  fs.mkdirSync(path.join(runDir, "cases"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });

  const serverEnv = createAcceptanceServerEnvironment(process.env, {
    NODE_ENV: "development",
    PORT: String(ACCEPTANCE_PORT),
    DATABASE_URL,
    ENCRYPTION_KEY: ACCEPTANCE_ENCRYPTION_KEY,
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    AUTH_OWNER_EMAIL: OWNER_EMAIL,
    PANEL_PASSWORD: OWNER_PASSWORD,
    BOT_TOKEN: "",
    ADMIN_CHAT_IDS: "[]",
    MINI_APP_SESSION_SECRET: "acceptance-only-mini-app-secret-not-used-in-production",
    BACKUP_DIR: "./backups",
    CODING_JOB_DIR: "./data/coding-job",
    CODING_WORKSPACES_DIR: "./data/code-workspaces",
    CODING_GIT_DIR: "./data/code-git",
  });
  const appDir = path.join(root, APP_DIR);
  fs.mkdirSync(appDir, { recursive: true });
  const server = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      "--conditions=development",
      path.join(root, "packages/server/src/index.ts"),
    ],
    // detached: the tsx CLI runs the entry in a child process; a dedicated process
    // group lets us kill the whole tree, not just the wrapper.
    { cwd: appDir, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const logStream = fs.createWriteStream(path.join(runDir, "server.log"));
  server.stdout.pipe(logStream);
  server.stderr.pipe(logStream);

  let exitCode = 1;
  try {
    console.log("[acceptance] waiting for server (migrations run at boot)…");
    await waitFor(`${BASE_URL}/api/health/ready`, 180_000, "acceptance server readiness");
    console.log(`[acceptance] server up at ${BASE_URL}`);
    seedBot();

    // pnpm layout: playwright is a sibling of @playwright/test inside .pnpm.
    const testPkg = createRequire(path.join(root, "noop.js")).resolve(
      "@playwright/test/package.json",
    );
    const playwrightCli = path.join(path.dirname(testPkg), "..", "..", "playwright", "cli.js");

    exitCode = await new Promise((resolveExit) => {
      const pw = spawn(
        process.execPath,
        [
          playwrightCli,
          "test",
          "-c",
          path.join(root, "acceptance/playwright.config.ts"),
          ...playwrightArgs,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ACCEPTANCE_BASE_URL: BASE_URL,
            ACCEPTANCE_RUN_DIR: runDir,
            ACCEPTANCE_OWNER_EMAIL: OWNER_EMAIL,
            ACCEPTANCE_OWNER_PASSWORD: OWNER_PASSWORD,
          },
          stdio: "inherit",
        },
      );
      pw.on("close", resolveExit);
    });
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 5000).unref();
  }

  // --- Aggregate per-case evidence into evidence-index.json ---------------------
  const casesDir = path.join(runDir, "cases");
  const cases = fs
    .readdirSync(casesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf8")));

  // Authoritative statuses from the JSON reporter (testInfo.status is unreliable
  // inside fixture teardown).
  const realStatus = new Map();
  try {
    const results = JSON.parse(
      fs.readFileSync(path.join(runDir, "playwright-results.json"), "utf8"),
    );
    const walk = (suites) => {
      for (const suite of suites ?? []) {
        for (const spec of suite.specs ?? []) {
          for (const t of spec.tests ?? []) {
            const last = t.results?.[t.results.length - 1];
            if (last) realStatus.set(`${t.projectName}::${spec.title}`, last.status);
          }
        }
        walk(suite.suites);
      }
    };
    walk(results.suites);
  } catch {
    // results file missing (e.g. config error) — keep fixture-reported statuses
  }

  const index = {
    runId,
    generatedAt: new Date().toISOString(),
    cases: cases.map((entry) => ({
      id: entry.meta?.id ?? entry.testTitle,
      feature: entry.meta?.feature ?? null,
      severity: entry.meta?.severity ?? null,
      visualRequired: entry.meta?.visualRequired ?? true,
      steps: entry.meta?.steps ?? [],
      expected: entry.meta?.expected ?? [],
      project: entry.project,
      testTitle: entry.testTitle,
      status: realStatus.get(`${entry.project}::${entry.testTitle}`) ?? entry.status,
      durationMs: entry.durationMs,
      checkpoints: entry.checkpoints,
      finalScreenshot: entry.finalScreenshot,
      diagnostics: entry.diagnostics,
    })),
  };
  fs.writeFileSync(path.join(runDir, "evidence-index.json"), JSON.stringify(index, null, 2));

  // Point .acceptance/latest at this run (symlink, with file fallback).
  const latest = path.join(root, ".acceptance", "latest");
  fs.rmSync(latest, { force: true, recursive: true });
  try {
    fs.symlinkSync(path.relative(path.dirname(latest), runDir), latest, "dir");
  } catch {
    fs.writeFileSync(latest, runId);
  }

  console.log(`\n[acceptance] run ${runId}: ${index.cases.length} case results`);
  console.log(`[acceptance] evidence: ${path.relative(root, runDir)}/evidence-index.json`);

  // 自动清理:每次运行后按保留策略修剪旧 run(ACCEPTANCE_KEEP_RUNS,默认 10;0 = 不清理)
  const keepRuns = Number(process.env.ACCEPTANCE_KEEP_RUNS ?? 10);
  if (keepRuns > 0) {
    const { removed } = pruneRuns({ keep: keepRuns });
    if (removed.length) {
      console.log(
        `[acceptance] auto-clean removed ${removed.length} old run(s): ${removed.join(", ")}`,
      );
    }
  }
  process.exit(exitCode ?? 1);
}

main().catch((error) => {
  console.error(`[acceptance] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
