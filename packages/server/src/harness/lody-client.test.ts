import { afterEach, expect, it, vi } from "vitest";
import { harnessFileSchema } from "./config/schema.js";
import { LodyClients, defaultCreateLody } from "./lody-client.js";
import { testConfigRaw } from "./test-fakes.js";

afterEach(() => vi.unstubAllGlobals());

it("rebuilds bridge transport after secret rotation and uses the new authorization header", async () => {
  const config = harnessFileSchema.parse(testConfigRaw()).executors.lody;
  const env: Record<string, string | undefined> = {
    [config.bridge.urlEnv]: "http://bridge.invalid",
    [config.bridge.secretEnv]: "a".repeat(40),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ exitCode: 0, stdout: "{}" }));
  vi.stubGlobal("fetch", fetchImpl);
  const create = vi.fn(defaultCreateLody);
  const clients = new LodyClients(
    create,
    (name) => env[name],
    () => {},
  );
  const first = clients.get(config);
  expect(clients.get(config)).toBe(first);
  const execute = () =>
    create.mock.calls.at(-1)![2]!("lody", ["machine", "list"], { timeout: 1000, maxBuffer: 10000 });
  await execute();
  env[config.bridge.secretEnv] = "b".repeat(40);
  const second = clients.get(config);
  await execute();
  expect(second).not.toBe(first);
  expect(create).toHaveBeenCalledTimes(2);
  expect(
    fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
  ).toEqual([`Bearer ${"a".repeat(40)}`, `Bearer ${"b".repeat(40)}`]);
  config.bridge.secretEnv = "ALTERNATE_BRIDGE_SECRET";
  env.ALTERNATE_BRIDGE_SECRET = "c".repeat(40);
  expect(clients.get(config)).not.toBe(second);
  await execute();
  expect(new Headers(fetchImpl.mock.calls.at(-1)![1]?.headers).get("authorization")).toBe(
    `Bearer ${"c".repeat(40)}`,
  );
});

it("does not keep an old usable credential after the bridge secret becomes invalid", async () => {
  const config = harnessFileSchema.parse(testConfigRaw()).executors.lody;
  const env: Record<string, string | undefined> = {
    [config.bridge.urlEnv]: "http://bridge.invalid",
    [config.bridge.secretEnv]: "a".repeat(40),
  };
  const fetchImpl = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchImpl);
  const create = vi.fn(defaultCreateLody);
  const clients = new LodyClients(
    create,
    (name) => env[name],
    () => {},
  );
  const first = clients.get(config);
  env[config.bridge.secretEnv] = "short";
  expect(clients.get(config)).not.toBe(first);
  await expect(
    create.mock.calls.at(-1)![2]!("lody", ["machine", "list"], { timeout: 1000, maxBuffer: 10000 }),
  ).rejects.toMatchObject({ code: "EBRIDGE_CONFIG" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("keeps the local client when an unused bridge credential changes", () => {
  const config = harnessFileSchema.parse(testConfigRaw()).executors.lody;
  const env: Record<string, string | undefined> = { [config.bridge.secretEnv]: "a".repeat(40) };
  const create = vi.fn(defaultCreateLody);
  const clients = new LodyClients(
    create,
    (name) => env[name],
    () => {},
  );
  const first = clients.get(config);
  env[config.bridge.secretEnv] = "b".repeat(40);
  expect(clients.get(config)).toBe(first);
  expect(create).toHaveBeenCalledOnce();
});
