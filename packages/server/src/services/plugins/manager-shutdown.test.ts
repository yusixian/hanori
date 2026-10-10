import { createHash } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import type { Database } from "@cos-tool-bot/database";
import {
  parsePluginManifest,
  type PluginDefinition,
  type PluginManifest,
} from "@cos-tool-bot/shared";
import { expect, it, vi } from "vitest";
import { PluginManager } from "./manager.js";
import type { GitPluginArtifacts } from "./git-artifacts.js";

const manifest: PluginManifest = {
  apiVersion: 1,
  id: "fixture.plugin",
  name: "Fixture",
  version: "1.0.0",
  description: "Synthetic fixture",
  author: "Test",
  login: { type: "qr" },
  config: [],
};
const manifestHash = createHash("sha256")
  .update(JSON.stringify(parsePluginManifest(manifest)))
  .digest("hex");
const actor = {
  botId: "00000000-0000-4000-8000-000000000001",
  chatId: 42,
  isAdmin: true,
  isPrivate: true,
  readOnly: false,
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const pending = gate();
  const entered = gate();
  let blockAt = Infinity;
  let count = 0;
  let closed = false;
  const afterClose: string[] = [];
  const row = {
    id: manifest.id,
    source: "builtin",
    revision: 1,
    commit: null,
    isInstalled: true,
    manifest,
  };
  const config = {
    enabled: true,
    needsReview: false,
    revision: 0,
    manifestHash,
    manifestVersion: "1.0.0",
    values: {},
    encryptedSecrets: {},
    updatedAt: new Date(),
  };
  const db = {
    select: () => ({
      from: (table: Record<symbol, string>) => ({
        where: async () => {
          const name = table[Symbol.for("drizzle:Name")]!;
          count++;
          if (closed) afterClose.push(name);
          if (count === blockAt) {
            entered.resolve();
            await pending.promise;
          }
          if (name === "plugin_installations") return [row];
          if (name === "bots") return [{ id: actor.botId }];
          return [config];
        },
      }),
    }),
  } as unknown as Database;
  const execute = vi.fn(async () => ({ success: true }));
  const definition: PluginDefinition = {
    apiVersion: 1,
    createSession: vi.fn<PluginDefinition["createSession"]>(async () => ({
      tools: [
        {
          name: "example",
          description: "Example",
          effect: "read_only",
          access: "all",
          inputSchema: { type: "object" },
          execute,
        },
      ],
    })),
    startLogin: vi.fn(async () => ({
      qrUrl: "https://example.invalid/qr.png",
      poll: async () => ({ status: "waiting" as const }),
    })),
  };
  const manager = new PluginManager(db, "synthetic-key", {} as GitPluginArtifacts, [
    { manifest, definition },
  ]);
  return {
    manager,
    definition,
    execute,
    entered,
    pending,
    afterClose,
    block: (offset: number) => {
      blockAt = count + offset;
    },
    closed: () => {
      closed = true;
    },
  };
}

it.each([
  "create-first-query",
  "create-config-query",
  "check-first-query",
  "login-validation-query",
])("drains host preparation: %s", async (scenario) => {
  const f = fixture();
  f.block(scenario === "create-config-query" || scenario === "login-validation-query" ? 2 : 1);
  const operation = scenario.startsWith("create")
    ? f.manager.createSession(actor)
    : scenario.startsWith("check")
      ? f.manager.checkBot(manifest.id, actor.botId)
      : f.manager.logins.start("owner", manifest.id, actor.botId, {
          expectedRevision: 0,
          manifestHash,
        });
  const result = operation.catch(() => undefined);
  try {
    await f.entered.promise;
    const settled = vi.fn();
    const closing = f.manager.close().then(() => {
      f.closed();
      settled();
    });
    await turn();
    expect(settled).not.toHaveBeenCalled();
    f.pending.resolve();
    await closing;
    await result;
    await turn();
    expect(f.afterClose).toEqual([]);
    expect(f.definition.createSession).not.toHaveBeenCalled();
    expect(f.definition.startLogin).not.toHaveBeenCalled();
  } finally {
    f.pending.resolve();
    await result;
    await f.manager.close();
  }
});

it.each(["before", "after"])(
  "drains an established tool's %s-call authorization",
  async (phase) => {
    const f = fixture();
    const session = await f.manager.createSession(actor);
    expect(session.tools).toHaveLength(1);
    // Each authorization reads installation, bot, configuration.
    f.block(phase === "before" ? 1 : 4);
    const tool = session.tools[0]!;
    const invocation = tool.execute({}, new AbortController().signal).catch(() => undefined);
    try {
      await f.entered.promise;
      const settled = vi.fn();
      const closing = f.manager.close().then(() => {
        f.closed();
        settled();
      });
      await turn();
      expect(settled).not.toHaveBeenCalled();
      f.pending.resolve();
      await closing;
      await invocation;
      expect(f.afterClose).toEqual([]);
      expect(f.execute).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    } finally {
      f.pending.resolve();
      await invocation;
      await session.dispose();
      await f.manager.close();
    }
  },
);

it("does not wait forever for a login provider that ignores cancellation, and disposes its late result", async () => {
  const f = fixture();
  const entered = gate();
  const provider = gate();
  const dispose = vi.fn();
  f.definition.startLogin = async () => {
    entered.resolve();
    await provider.promise;
    return {
      qrUrl: "https://example.invalid/qr.png",
      poll: async () => ({ status: "waiting" as const }),
      dispose,
    };
  };
  const starting = f.manager.logins.start("owner", manifest.id, actor.botId, {
    expectedRevision: 0,
    manifestHash,
  });
  try {
    await entered.promise;
    await f.manager.close();
    f.closed();
    expect(dispose).not.toHaveBeenCalled();
    provider.resolve();
    await starting;
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(f.afterClose).toEqual([]);
  } finally {
    provider.resolve();
    await starting;
    await f.manager.close();
  }
});
