import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/docker-publish.yml"));
const source = parse(read("docker-compose.yml"));
const prebuilt = parse(read("docker-compose.prebuilt.yml"));
const targets = Object.entries(source.services)
  .filter(([, service]) => service.build)
  .map(([name, service]) => ({
    name,
    target: service.build.target ?? "app",
    image: name === "app" ? "hanori" : `hanori-${name}`,
  }));

test("prebuilt Compose preserves source service isolation, backup gates and storage", () => {
  const expected = structuredClone(source);
  for (const { name, image } of targets) {
    delete expected.services[name].build;
    expected.services[name].image =
      "${HANORI_IMAGE_REGISTRY:-ghcr.io/yusixian}/" + image + ":${HANORI_IMAGE_TAG:-latest}";
  }
  expected.services.app.ports = ["${PORT:-43100}:3000"];
  expect(prebuilt).toEqual(expected);
});

test.each(["coolify", "1panel"])(
  "%s template keeps the default stack and its boundaries",
  (platform) => {
    const { services, volumes, networks } = parse(
      read(`examples/deploy/${platform}/docker-compose.yml`),
    );
    expect(Object.keys(services).sort()).toEqual(["app", "db", "db-backup", "quote-worker"]);
    expect(services["quote-worker"]).toEqual(prebuilt.services["quote-worker"]);
    for (const [service, variable] of [
      ["db", "POSTGRES_PASSWORD"],
      ["db-backup", "PGPASSWORD"],
    ]) {
      expect(services[service]).toEqual({
        ...prebuilt.services[service],
        environment: prebuilt.services[service].environment.map((entry) =>
          entry.startsWith(variable + "=") ? variable + "=${DB_PASSWORD:?Set DB_PASSWORD}" : entry,
        ),
      });
    }
    const app = services.app;
    expect(app.image).toBe(prebuilt.services.app.image);
    expect(app.depends_on).toEqual(prebuilt.services.app.depends_on);
    expect(app.healthcheck).toEqual(prebuilt.services.app.healthcheck);
    expect(app.volumes).toEqual([
      "backups:/data/backups",
      "botdata:/app/data",
      "quotecontrol:/quote-control",
    ]);
    expect(app.environment).toEqual([
      "DATABASE_URL=postgresql://bot:${DB_PASSWORD:?Set DB_PASSWORD}@db:5432/cos_tool_bot",
      "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET}",
      "BETTER_AUTH_URL=${BETTER_AUTH_URL:?Set BETTER_AUTH_URL}",
      "AUTH_OWNER_EMAIL=${AUTH_OWNER_EMAIL:?Set AUTH_OWNER_EMAIL}",
      "ENCRYPTION_KEY=${ENCRYPTION_KEY:?Set ENCRYPTION_KEY}",
      "PANEL_PASSWORD=${PANEL_PASSWORD:-}",
      "MINI_APP_SESSION_SECRET=${MINI_APP_SESSION_SECRET:-}",
      "BOT_TOKEN=${BOT_TOKEN:-}",
      "ADMIN_CHAT_IDS=${ADMIN_CHAT_IDS:-}",
      "BACKUP_DIR=/data/backups",
      "PLUGIN_DIRECTORY=/app/data/plugins",
      "QUOTE_WORKER_SOCKET=/quote-control/worker.sock",
    ]);
    expect(volumes).toEqual({
      pgdata: null,
      backups: null,
      botdata: null,
      quotecontrol: prebuilt.volumes.quotecontrol,
    });
    if (platform === "coolify") {
      expect(app.ports).toBeUndefined();
      expect(app.networks).toEqual(["default", "coolify-proxy"]);
      expect(networks["coolify-proxy"]).toEqual({
        external: true,
        name: "${COOLIFY_PROXY_NETWORK:-coolify}",
      });
    } else {
      expect(app.ports).toEqual(["127.0.0.1:${PORT:-43100}:3000"]);
      expect(app.networks).toBeUndefined();
      expect(networks).toBeUndefined();
    }
  },
);

test("publication maps every Compose build to a multi-architecture Dockerfile target", () => {
  const job = workflow.jobs.publish;
  const dockerfile = read("Dockerfile");
  for (const { target } of targets) {
    expect(dockerfile).toMatch(new RegExp(`^FROM .+ AS ${target}$`, "m"));
  }
  expect(job.strategy.matrix.include).toHaveLength(targets.length);
  expect(job.strategy.matrix.include).toEqual(
    expect.arrayContaining(targets.map(({ target, image }) => ({ target, image }))),
  );
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(job.permissions).toEqual({ contents: "read", packages: "write" });
  expect(workflow.on).toMatchObject({
    push: { tags: ["v*"] },
    release: { types: ["published"] },
    workflow_dispatch: { inputs: { tag: { required: true }, push_latest: { type: "boolean" } } },
  });
  const step = (action) => job.steps.find(({ uses }) => uses?.startsWith(`docker/${action}@`));
  expect(step("setup-qemu-action")).toBeDefined();
  expect(step("setup-buildx-action")).toBeDefined();
  expect(step("login-action").with.registry).toBe("ghcr.io");
  expect(step("metadata-action").with.images).toBe(
    "ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}",
  );
  expect(step("build-push-action").with).toMatchObject({
    platforms: "linux/amd64,linux/arm64",
    target: "${{ matrix.target }}",
    tags: "${{ steps.meta.outputs.tags }}",
    "build-args": "APP_VERSION=${{ github.sha }}",
    push: true,
  });
});
