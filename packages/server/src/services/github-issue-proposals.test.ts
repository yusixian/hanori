import type { GitHubIssueProposal, GitHubToolsConfigStored } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import {
  createGitHubIssueProposalAuthorizer,
  GitHubIssueProposalService,
} from "./github-issue-proposals.js";
import type { GitHubIssueProposalStore } from "./github-issue-proposal-store.js";
import type { GitHubAppCredentialService } from "./github-app-credentials.js";

const BOT = "00000000-0000-4000-8000-000000000001";
const OTHER_BOT = "00000000-0000-4000-8000-000000000002";
const actor = { userId: 7, chatId: -100, threadId: 12 };
const input = { ...actor, repository: "owner/repo", title: "fixed title", body: "fixed body" };
const config: GitHubToolsConfigStored = {
  enabled: true,
  publicReadEnabled: true,
  codingAgentEnabled: false,
  authorName: "Bot",
  authorEmail: "bot@example.test",
  repositories: ["owner/repo"],
};

/** Shared backing storage models durability across service instances. */
class MemoryStore implements GitHubIssueProposalStore {
  readonly values = new Map<string, string>();
  async insert(bot: string, id: string, value: string) {
    if (this.values.has(`${bot}:${id}`)) throw new Error("duplicate");
    this.values.set(`${bot}:${id}`, value);
  }
  async get(bot: string, id: string) {
    return this.values.get(`${bot}:${id}`);
  }
  async list(bot: string) {
    return [...this.values].filter(([key]) => key.startsWith(`${bot}:`)).map(([, value]) => value);
  }
  async compareExchange(bot: string, id: string, previous: string, next: string) {
    const key = `${bot}:${id}`;
    if (this.values.get(key) !== previous) return false;
    this.values.set(key, next);
    return true;
  }
}

function setup(ttl: number | null = null) {
  const store = new MemoryStore();
  const current = {
    admins: [7],
    config: { ...config, createIssueConfirmationTtlMinutes: ttl },
    token: "current-token",
  };
  const authorize = vi.fn(async (bot: string, user: number, repo?: string) => {
    if (
      bot !== BOT ||
      !current.admins.includes(user) ||
      !current.config.enabled ||
      (repo && !current.config.repositories.includes(repo))
    )
      throw new Error("current authorization denied");
    if (!current.token) throw new Error("credential removed");
    return { config: current.config, token: current.token };
  });
  let now = 1_800_000_000_000;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        ...payload,
        number: 42,
        html_url: "https://github.com/owner/repo/issues/42",
      }),
    );
  });
  const createService = () =>
    new GitHubIssueProposalService(store, authorize, fetchMock, () => now);
  const service = createService();
  const port = service.forBot(BOT);
  return {
    store,
    current,
    authorize,
    fetchMock,
    port,
    createService,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function stored(store: MemoryStore, proposal: GitHubIssueProposal) {
  return JSON.parse((await store.get(BOT, proposal.id))!) as GitHubIssueProposal;
}

describe("durable GitHub Issue confirmation", () => {
  it("survives >10 minutes and process restart, uses the current token and preserves fixed content", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    expect(proposal.expiresAt).toBeNull();
    expect(s.fetchMock).not.toHaveBeenCalled();
    s.advance(11 * 60_000);
    s.current.token = "rotated-token";
    const restarted = s.createService().forBot(BOT);
    expect(await restarted.list(actor)).toEqual([proposal]);
    const completed = await restarted.decide(proposal.id, actor, "confirm");
    expect(completed.status).toBe("completed");
    expect(s.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = s.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rotated-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: input.title,
      body: `${input.body}\n\n<!-- cos-tool-bot:github-issue:v1:${proposal.id}:${proposal.hash} -->`,
    });
    expect(await stored(s.store, proposal)).toMatchObject({
      status: "completed",
      result: completed.result,
    });
  });

  it("honors an actual finite expiry, including its exact boundary, across restarts", async () => {
    const s = setup(60);
    const proposal = await s.port.propose(input);
    s.advance(60 * 60_000);
    expect((await s.createService().forBot(BOT).decide(proposal.id, actor, "confirm")).status).toBe(
      "expired",
    );
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("allows long durations and rejects unrepresentable expiry dates before persisting", async () => {
    const s = setup(5_256_001);
    const proposal = await s.port.propose(input);
    expect(proposal.expiresAt).toBe(proposal.createdAt + 5_256_001 * 60_000);
    const invalid = setup(Number.MAX_SAFE_INTEGER);
    await expect(invalid.port.propose(input)).rejects.toThrow("日期范围");
    expect(invalid.store.values.size).toBe(0);
    const invalidDate = setup(144_000_000_000);
    await expect(invalidDate.port.propose(input)).rejects.toThrow("日期范围");
    expect(invalidDate.store.values.size).toBe(0);
  });

  it("does not call GitHub or claim an unknown result when authorization fails after the claim", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    // The first recheck succeeds; the one after the atomic claim fails.
    s.authorize.mockReset();
    s.authorize.mockResolvedValueOnce({ config: s.current.config, token: s.current.token });
    s.authorize.mockRejectedValueOnce(new Error("permissions changed"));
    expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("not_executed");
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect((await stored(s.store, proposal)).status).toBe("not_executed");
    s.authorize.mockResolvedValue({ config: s.current.config, token: s.current.token });
    expect((await s.createService().forBot(BOT).decide(proposal.id, actor, "confirm")).status).toBe(
      "not_executed",
    );
    expect(await s.port.list(actor)).toEqual([]);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks expiry after a delayed claim without sending a creation request", async () => {
    const s = setup(1);
    const proposal = await s.port.propose(input);
    const cas = s.store.compareExchange.bind(s.store);
    vi.spyOn(s.store, "compareExchange").mockImplementation(async (bot, id, previous, next) => {
      const changed = await cas(bot, id, previous, next);
      if (JSON.parse(next).status === "executing") s.advance(60_000);
      return changed;
    });
    expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("expired");
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["admin", "allowlist", "enabled", "credential"])(
    "rejects revoked current %s authorization",
    async (kind) => {
      const s = setup();
      const proposal = await s.port.propose(input);
      if (kind === "admin") s.current.admins = [];
      if (kind === "allowlist") s.current.config.repositories = [];
      if (kind === "enabled") s.current.config.enabled = false;
      if (kind === "credential") s.current.token = "";
      await expect(
        s.createService().forBot(BOT).decide(proposal.id, actor, "confirm"),
      ).rejects.toThrow();
      expect(s.fetchMock).not.toHaveBeenCalled();
      expect((await stored(s.store, proposal)).status).toBe("pending");
    },
  );

  it.each([
    { ...actor, userId: 8 },
    { ...actor, chatId: -101 },
    { ...actor, threadId: 13 },
  ])("binds the initiating administrator and original chat/topic %j", async (wrong) => {
    const s = setup();
    s.current.admins.push(8);
    const proposal = await s.port.propose(input);
    await expect(s.port.decide(proposal.id, wrong, "confirm")).rejects.toThrow("发起");
    await expect(s.port.decide(proposal.id, wrong, "cancel")).rejects.toThrow("发起");
    expect(await s.port.list(wrong)).toEqual([]);
    await expect(
      s.createService().forBot(OTHER_BOT).decide(proposal.id, actor, "confirm"),
    ).rejects.toThrow();
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("revokes an explicit ID; old and repeated cards cannot run, independent identical intents survive", async () => {
    const s = setup();
    const old = await s.port.propose(input);
    const independent = await s.port.propose(input);
    expect((await s.port.decide(old.id, actor, "cancel")).status).toBe("cancelled");
    const restarted = s.createService().forBot(BOT);
    expect((await restarted.decide(old.id, actor, "confirm")).status).toBe("cancelled");
    expect(await restarted.list(actor)).toEqual([independent]);
    expect((await restarted.decide(independent.id, actor, "confirm")).status).toBe("completed");
    expect((await restarted.decide(independent.id, actor, "confirm")).status).toBe("completed");
    expect(s.fetchMock).toHaveBeenCalledOnce();
  });

  it("claims once for concurrent confirmations, including different service instances", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    const other = s.createService().forBot(BOT);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? other : s.port).decide(proposal.id, actor, "confirm"),
      ),
    );
    expect(s.fetchMock).toHaveBeenCalledOnce();
    expect(["completed", "result_unknown"]).toContain((await stored(s.store, proposal)).status);
  });

  it("a cancel/confirm race has only one winning transition", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    await Promise.all([
      s.port.decide(proposal.id, actor, "cancel"),
      s.port.decide(proposal.id, actor, "confirm"),
    ]);
    expect((await stored(s.store, proposal)).status).toBe("cancelled");
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["cancel", "confirm"] as const)(
    "a failed concurrent %s claim cannot retire another confirmation",
    async (decision) => {
      const s = setup();
      const proposal = await s.port.propose(input);
      let claimEntered!: () => void;
      let failClaim!: () => void;
      const claimReady = new Promise<void>((resolve) => {
        claimEntered = resolve;
      });
      const claimFailure = new Promise<void>((resolve) => {
        failClaim = resolve;
      });
      const cas = s.store.compareExchange.bind(s.store);
      vi.spyOn(s.store, "compareExchange")
        .mockImplementationOnce(async () => {
          claimEntered();
          await claimFailure;
          throw new Error("transient database failure");
        })
        .mockImplementation(cas);
      const losing = s.port.decide(proposal.id, actor, decision);
      await claimReady;

      let winnerEntered!: () => void;
      let finishWinner!: () => void;
      const winnerReady = new Promise<void>((resolve) => {
        winnerEntered = resolve;
      });
      const winnerRelease = new Promise<void>((resolve) => {
        finishWinner = resolve;
      });
      if (decision === "cancel") {
        const fetch = s.fetchMock.getMockImplementation()!;
        s.fetchMock.mockImplementation(async (...args) => {
          winnerEntered();
          await winnerRelease;
          return fetch(...args);
        });
      } else {
        s.authorize.mockResolvedValueOnce({ config: s.current.config, token: s.current.token });
        s.authorize.mockImplementationOnce(async () => {
          winnerEntered();
          await winnerRelease;
          return { config: s.current.config, token: s.current.token };
        });
      }
      const winning = s.port.decide(proposal.id, actor, "confirm");
      await winnerReady;
      failClaim();
      expect((await losing).status).toBe("executing");
      expect((await stored(s.store, proposal)).status).toBe("executing");
      finishWinner();
      expect((await winning).status).toBe("completed");
      expect((await stored(s.store, proposal)).status).toBe("completed");
      expect(s.fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["title", "body", "repository", "initiator", "expiresAt"])(
    "refuses a changed immutable %s even with the original ID",
    async (field) => {
      const s = setup();
      const proposal = await s.port.propose(input);
      const changed = {
        ...proposal,
        [field]: field === "initiator" ? 8 : field === "expiresAt" ? 123 : "tampered",
      };
      s.store.values.set(`${BOT}:${proposal.id}`, JSON.stringify(changed));
      await expect(s.port.decide(proposal.id, actor, "confirm")).rejects.toThrow();
      expect(s.fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps an interrupted POST unknown through restart and repeated clicks, without ever resending", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    s.fetchMock.mockRejectedValueOnce(new Error("connection lost after write"));
    expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("result_unknown");
    s.fetchMock.mockImplementation(async () => new Response("[]"));
    const restarted = s.createService().forBot(BOT);
    for (let i = 0; i < 3; i++)
      expect((await restarted.decide(proposal.id, actor, "confirm")).status).toBe("result_unknown");
    expect(s.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await expect(restarted.decide(proposal.id, actor, "cancel")).rejects.toThrow("不能撤回");
  });

  it("recovers an executing record on restart and reconciles via authenticated GET with the exact marker", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    s.store.values.set(
      `${BOT}:${proposal.id}`,
      JSON.stringify({ ...proposal, status: "executing", executionOwner: "dead-process" }),
    );
    const restarted = s.createService().forBot(BOT);
    expect((await restarted.list(actor))[0]?.status).toBe("result_unknown");
    s.fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              number: 42,
              title: proposal.title,
              body: `${proposal.body}\n\n<!-- cos-tool-bot:github-issue:v1:${proposal.id}:${proposal.hash} -->`,
              state: "closed",
              html_url: "https://github.com/owner/repo/issues/42",
            },
          ]),
        ),
    );
    expect((await restarted.decide(proposal.id, actor, "verify")).status).toBe("completed");
    expect(s.fetchMock).toHaveBeenCalledOnce();
    expect(s.fetchMock.mock.calls[0]?.[0]).toContain("state=all");
    expect(s.fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("does not treat a matching title, wrong URL, PR, or failed read as proof of creation", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    s.store.values.set(
      `${BOT}:${proposal.id}`,
      JSON.stringify({ ...proposal, status: "result_unknown" }),
    );
    for (const issue of [
      { title: proposal.title, body: proposal.body },
      {
        title: proposal.title,
        body: `${proposal.body}\n\n<!-- cos-tool-bot:github-issue:v1:${proposal.id}:${proposal.hash} -->`,
        number: 42,
        html_url: "https://github.com/another/repo/issues/42",
      },
    ]) {
      s.fetchMock.mockImplementation(async () => new Response(JSON.stringify([issue])));
      expect((await s.port.decide(proposal.id, actor, "verify")).status).toBe("result_unknown");
    }
    s.fetchMock.mockRejectedValueOnce(new Error("GET failed"));
    expect((await s.port.decide(proposal.id, actor, "verify")).status).toBe("result_unknown");
    expect(s.fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("keeps a successful remote write unknown if its completion receipt cannot be persisted", async () => {
    const s = setup();
    const proposal = await s.port.propose(input);
    const cas = s.store.compareExchange.bind(s.store);
    vi.spyOn(s.store, "compareExchange").mockImplementation(async (bot, id, previous, next) => {
      if (JSON.parse(next).status === "completed") throw new Error("database receipt failed");
      return cas(bot, id, previous, next);
    });
    expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("result_unknown");
    expect(s.fetchMock).toHaveBeenCalledOnce();
  });
});

describe("current tenant authorization from database", () => {
  function database(row: unknown) {
    return {
      select: () => ({ from: () => ({ where: async () => [row] }) }),
    } as unknown as Database;
  }
  it("decrypts the current legacy credential and rechecks current DB permissions each time", async () => {
    const row = {
      active: true,
      admins: [7],
      ai: {
        enabled: true,
        githubToolsConfig: { ...config, encryptedToken: encrypt("new-token", "key") },
      },
    };
    const authorize = createGitHubIssueProposalAuthorizer(database(row), "key", () => undefined);
    expect((await authorize(BOT, 7, "OWNER/REPO")).token).toBe("new-token");
    row.admins = [];
    await expect(authorize(BOT, 7, "owner/repo")).rejects.toThrow("管理员");
    row.admins = [7];
    row.ai.githubToolsConfig.repositories = [];
    await expect(authorize(BOT, 7, "owner/repo")).rejects.toThrow("白名单");
  });
  it("requires enabled tenant/config, App scope and available installation credentials; never falls back", async () => {
    const installation = {
      installationId: 9,
      accountLogin: "app",
      accountType: "Organization",
      repositorySelection: "selected" as const,
      repositories: ["owner/repo"],
      permissions: { issues: "write" },
      connectedAt: "now",
    };
    const row = {
      active: true,
      admins: [7],
      ai: {
        enabled: true,
        githubToolsConfig: {
          ...config,
          repositories: ["owner/repo", "outside/repo"],
          githubAppInstallation: installation,
          encryptedToken: encrypt("legacy", "key"),
        },
      },
    };
    const getInstallationToken = vi.fn().mockResolvedValue("app-current");
    const app = { available: true, getInstallationToken } as unknown as GitHubAppCredentialService;
    const authorize = createGitHubIssueProposalAuthorizer(database(row), "key", () => app);
    expect((await authorize(BOT, 7, "owner/repo")).token).toBe("app-current");
    expect(getInstallationToken).toHaveBeenCalledWith(9);
    await expect(authorize(BOT, 7, "outside/repo")).rejects.toThrow("白名单");
    const unavailable = createGitHubIssueProposalAuthorizer(database(row), "key", () => undefined);
    await expect(unavailable(BOT, 7, "owner/repo")).rejects.toThrow("凭据");
    row.active = false;
    await expect(authorize(BOT, 7, "owner/repo")).rejects.toThrow();
    row.active = true;
    row.ai.enabled = false;
    await expect(authorize(BOT, 7, "owner/repo")).rejects.toThrow();
  });
});

it("rejects authorization changed while an App credential was being resolved", async () => {
  const row = {
    active: true,
    admins: [7],
    ai: {
      enabled: true,
      githubToolsConfig: {
        ...config,
        githubAppInstallation: {
          installationId: 9,
          accountLogin: "app",
          accountType: "Organization",
          repositorySelection: "selected" as const,
          repositories: ["owner/repo"],
          permissions: { issues: "write" },
          connectedAt: "now",
        },
      },
    },
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
  } as unknown as Database;
  const app = {
    available: true,
    getInstallationToken: vi.fn(async () => {
      row.admins = [];
      return "token";
    }),
  } as unknown as GitHubAppCredentialService;
  const authorize = createGitHubIssueProposalAuthorizer(db, "key", () => app);
  await expect(authorize(BOT, 7, "owner/repo")).rejects.toThrow("已变更");
});

it("only applies TTL changes to new proposals and reserves space for the immutable marker", async () => {
  const s = setup();
  const old = await s.port.propose(input);
  s.current.config.createIssueConfirmationTtlMinutes = 10;
  const finite = await s.port.propose(input);
  s.advance(11 * 60_000);
  expect((await s.port.decide(finite.id, actor, "confirm")).status).toBe("expired");
  expect((await s.port.decide(old.id, actor, "confirm")).status).toBe("completed");
  await expect(s.port.propose({ ...input, body: "x".repeat(65_536) })).rejects.toThrow("预留空间");
  expect(s.fetchMock).toHaveBeenCalledOnce();
});

it("recovers an unpersisted final receipt after the database returns without requiring another restart", async () => {
  const s = setup();
  const proposal = await s.port.propose(input);
  const cas = s.store.compareExchange.bind(s.store);
  const unavailable = vi
    .spyOn(s.store, "compareExchange")
    .mockImplementation(async (bot, id, previous, next) => {
      if (["completed", "result_unknown"].includes(JSON.parse(next).status))
        throw new Error("DB temporarily offline");
      return cas(bot, id, previous, next);
    });
  await expect(s.port.decide(proposal.id, actor, "confirm")).rejects.toThrow(
    "DB temporarily offline",
  );
  unavailable.mockRestore();
  expect((await s.port.list(actor))[0]?.status).toBe("result_unknown");
  s.fetchMock.mockImplementation(async () => new Response("[]"));
  expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("result_unknown");
  expect(s.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("refuses terminal superseded buttons without sending another write", async () => {
  const s = setup();
  const proposal = await s.port.propose(input);
  s.store.values.set(
    `${BOT}:${proposal.id}`,
    JSON.stringify({ ...proposal, status: "superseded" }),
  );
  expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("superseded");
  expect(await s.port.list(actor)).toEqual([]);
  expect(s.fetchMock).not.toHaveBeenCalled();
});

it.each(["before-claim", "before-post"])(
  "does not create if finite validity expires during authorization %s",
  async (phase) => {
    const s = setup(1);
    const proposal = await s.port.propose(input);
    const original = s.authorize.getMockImplementation()!;
    s.authorize.mockImplementationOnce(async (...args) => {
      if (phase === "before-claim") s.advance(60_000);
      return original(...args);
    });
    if (phase === "before-post")
      s.authorize.mockImplementationOnce(async (...args) => {
        s.advance(60_000);
        return original(...args);
      });
    expect((await s.port.decide(proposal.id, actor, "confirm")).status).toBe("expired");
    expect(s.fetchMock).not.toHaveBeenCalled();
  },
);

it("does not echo retained body or parser diagnostics from an unreadable proposal record", async () => {
  const s = setup();
  const proposal = await s.port.propose(input);
  s.store.values.set(`${BOT}:${proposal.id}`, '{"body":"private proposal diagnostic');
  const error = await s.port.decide(proposal.id, actor, "confirm").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("校验失败");
  expect(String(error)).not.toMatch(/private proposal diagnostic|SyntaxError/);
  expect(s.fetchMock).not.toHaveBeenCalled();
});
