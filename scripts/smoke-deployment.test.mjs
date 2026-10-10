import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deploymentProbe,
  expectedMigrationHashes,
  assertLocalDockerEndpoint,
  assertSmokeConfig,
  smokeHostEnvironment,
} from "./smoke-deployment.mjs";

const project = `deployment-smoke-${"a".repeat(24)}`;
function isolatedConfig() {
  return {
    name: project,
    services: {
      app: {
        labels: { "traefik.enable": "false" },
        environment: {
          DATABASE_URL: `postgresql://bot:${"a".repeat(64)}@db:5432/cos_tool_bot`,
          BOT_TOKEN: "",
        },
        networks: { default: {} },
        volumes: [{ type: "volume", source: "botdata", target: "/app/data" }],
      },
      db: {},
      "db-backup": {},
      "nsfw-api": {},
    },
    volumes: { botdata: { name: `${project}_botdata` } },
    networks: { default: { name: `${project}_default` } },
  };
}

describe("disposable deployment safety", () => {
  it("does not inherit credentials, existing Compose project settings or enabled profiles", () => {
    expect(
      smokeHostEnvironment({
        PATH: "/usr/bin",
        HOME: "/tmp",
        BOT_TOKEN: "private",
        DATABASE_URL: "private",
        COMPOSE_PROFILES: "coding",
        COMPOSE_PROJECT_NAME: "existing",
        DB_PASSWORD: "private",
        APP_VERSION: "private",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/tmp" });
  });

  it.each(["ssh://server", "tcp://127.0.0.1:2375", "https://docker.example.test", "", undefined])(
    "refuses Docker endpoint %s",
    (endpoint) => {
      expect(() => assertLocalDockerEndpoint(endpoint)).toThrow("local Unix-socket");
    },
  );

  it("accepts a local daemon and independently named resources", () => {
    expect(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock")).not.toThrow();
    expect(() => assertSmokeConfig(isolatedConfig(), project)).not.toThrow();
  });

  it.each([
    (config) => {
      config.name = "production";
    },
    (config) => {
      config.volumes.botdata.name = "existing_data";
    },
    (config) => {
      config.volumes.botdata.external = true;
    },
    (config) => {
      config.volumes.botdata.driver_opts = { type: "none", o: "bind", device: "/existing" };
    },
    (config) => {
      config.networks.default.external = true;
    },
    (config) => {
      config.services.app.volumes[0] = { type: "bind", source: "/existing", target: "/app/data" };
    },
    (config) => {
      config.services.app.ports = [{ target: 3000, published: "3000" }];
    },
    (config) => {
      config.services.app.container_name = "existing";
    },
    (config) => {
      config.services.app.network_mode = "host";
    },
    (config) => {
      config.services.app.environment.DATABASE_URL = "postgresql://db.example.test/production";
    },
    (config) => {
      config.services.app.environment.BOT_TOKEN = "private";
    },
    (config) => {
      config.services.app.environment.HARNESS_CONFIG_PATH = "/existing/config";
    },
    (config) => {
      config.services["coding-worker"] = {};
    },
    (config) => {
      config.services.app.env_file = [".env"];
    },
    (config) => {
      config.services.app.secrets = ["existing_secret"];
    },
    (config) => {
      config.services.app.image = "existing-app:latest";
    },
    (config) => {
      config.services.app.labels["traefik.enable"] = "true";
    },
  ])("blocks unsafe configuration before starting resources %#", (change) => {
    const config = isolatedConfig();
    change(config);
    expect(() => assertSmokeConfig(config, project)).toThrow("not isolated");
  });

  it("keeps resolved configuration and credentials out of failure messages", () => {
    const config = isolatedConfig();
    const secret = "private-unpublished-value";
    config.services.app.environment.BOT_TOKEN = secret;
    try {
      assertSmokeConfig(config, project);
    } catch (error) {
      expect(error.message).not.toContain(secret);
      return;
    }
    throw new Error("Unsafe configuration was accepted");
  });
});

describe("deployment smoke failure handling", () => {
  it.each(["offline", "build-failure", "cleanup-failure"])(
    "handles %s without revealing tool diagnostics or touching existing resources",
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "smoke-cli-test-"));
      const logPath = join(directory, "calls.jsonl");
      let generatedDirectory;
      try {
        writeFileSync(
          join(directory, "docker"),
          `#!/usr/bin/env node
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        const project = args[args.indexOf('--project-name') + 1];
        const envPath = args[args.indexOf('--env-file') + 1];
        fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, project, envPath }) + '\\n');
        if (args[0] === 'compose' && args.includes('config')) {
          const password = fs.readFileSync(envPath, 'utf8').match(/^DB_PASSWORD=(.*)$/m)[1];
          console.log(JSON.stringify({
            name: project,
            services: { app: { labels: { 'traefik.enable': 'false' }, environment: { DATABASE_URL: 'postgresql://bot:' + password + '@db:5432/cos_tool_bot' } }, db: {}, 'db-backup': {}, 'nsfw-api': {} },
            volumes: { pgdata: { name: project + '_pgdata' } },
            networks: { default: { name: project + '_default' } }
          }));
        } else if (args[0] === 'context' && args[1] === 'show') console.log('test');
        else if (args[0] === 'context' && args[1] === 'inspect') console.log(JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]));
        else if (args[0] === 'info') {
          if (${JSON.stringify(mode)} !== 'offline') console.log('29.0.0');
        } else if (args.includes('build') || (args.includes('down') && ${JSON.stringify(mode)} === 'cleanup-failure')) {
          console.error('private-unpublished-tool-diagnostic');
          process.exit(1);
        }
      `,
          { mode: 0o700 },
        );
        const result = spawnSync(
          process.execPath,
          [resolve("scripts/smoke-deployment.mjs"), "--sha", "a".repeat(40)],
          {
            encoding: "utf8",
            env: { PATH: `${directory}:${process.env.PATH}`, HOME: process.env.HOME },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain("private-unpublished-tool-diagnostic");
        const calls = readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const config = calls.find((call) => call.args.includes("config"));
        generatedDirectory = resolve(config.envPath, "..");
        const down = calls.filter((call) => call.args.includes("down"));
        if (mode === "offline") {
          expect(result.stderr).toContain("Local Docker daemon is unavailable");
          expect(calls.some((call) => call.args.includes("build"))).toBe(false);
          expect(down).toHaveLength(0);
        } else {
          expect(down).toHaveLength(1);
          expect(down[0].project).toMatch(/^deployment-smoke-[a-f0-9]{24}$/);
          expect(down[0].args).toEqual(expect.arrayContaining(["--volumes", "--rmi", "local"]));
        }
        expect(existsSync(generatedDirectory)).toBe(mode === "cleanup-failure");
        if (mode === "cleanup-failure")
          expect(result.stderr).toContain("Temporary configuration is retained privately");
      } finally {
        rmSync(directory, { recursive: true, force: true });
        if (generatedDirectory) rmSync(generatedDirectory, { recursive: true, force: true });
      }
    },
  );
});

describe("deployment credential probe", () => {
  const sha = "a".repeat(40);
  const password = "synthetic-original-password";
  const expectedToken = "123:abcdefghi";
  async function runProbe({
    tokenMasked = "123:abc***ghi",
    loginOk = true,
    wrongKey = false,
  } = {}) {
    const exit = vi.fn();
    const fetch = vi.fn(async (url, init) => {
      if (url.endsWith("/api/health/ready"))
        return { ok: true, json: async () => ({ status: "ready", version: sha }) };
      if (url.endsWith("/api/auth/sign-in/email")) {
        expect(JSON.parse(init.body).password).toBe(password);
        return {
          ok: loginOk,
          headers: {
            get: () => "session=synthetic",
            getSetCookie: () => ["session=synthetic; HttpOnly"],
          },
        };
      }
      if (url.endsWith("/api/bots") && !init) return { status: 401 };
      if (url.endsWith("/api/bots/bot-id"))
        return {
          ok: true,
          json: async () => ({ ok: true, data: { id: "bot-id", isActive: false, tokenMasked } }),
        };
      return { ok: true, headers: { get: () => "text/html" } };
    });
    await runInNewContext(
      deploymentProbe({ sha, password, expectedToken, botId: "bot-id", wrongKey }),
      {
        fetch,
        console: { error: vi.fn() },
        process: { exit, env: { PANEL_PASSWORD: "" } },
      },
    );
    return exit;
  }
  it("authenticates with the original password while bootstrap is disabled", async () => {
    expect(await runProbe()).not.toHaveBeenCalled();
  });
  it("rejects HTTP 200 with an undecryptable credential", async () => {
    expect(await runProbe({ tokenMasked: "(密钥不匹配)" })).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("checks the negative wrong-key case rather than accepting any HTTP 200", async () => {
    expect(await runProbe({ wrongKey: true, tokenMasked: "(密钥不匹配)" })).not.toHaveBeenCalled();
    expect(await runProbe({ wrongKey: true })).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("fails if the original credential account cannot sign in", async () => {
    expect(await runProbe({ loginOk: false })).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("candidate migration evidence", () => {
  it("compares SQL content hashes in journal order, not just migration count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smoke-migrations-"));
    try {
      const folder = join(directory, "packages/database/drizzle");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(folder, "meta"), { recursive: true });
      writeFileSync(
        join(folder, "meta/_journal.json"),
        JSON.stringify({ entries: [{ tag: "first" }, { tag: "next" }] }),
      );
      writeFileSync(join(folder, "first.sql"), "CREATE TABLE first (id int);");
      writeFileSync(join(folder, "next.sql"), "ALTER TABLE first ADD name text;");
      const hashes = await expectedMigrationHashes(directory);
      expect(hashes).toEqual(
        ["CREATE TABLE first (id int);", "ALTER TABLE first ADD name text;"].map((sql) =>
          createHash("sha256").update(sql).digest("hex"),
        ),
      );
      writeFileSync(join(folder, "next.sql"), "SELECT 1;");
      expect(await expectedMigrationHashes(directory)).not.toEqual(hashes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
