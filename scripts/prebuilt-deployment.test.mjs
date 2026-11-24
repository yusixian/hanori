import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/docker-publish.yml"));
const source = parse(read("docker-compose.yml"));
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
  expect(parse(read("docker-compose.prebuilt.yml"))).toEqual(expected);
});

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
