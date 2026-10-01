import { describe, expect, it, vi } from "vitest";
import { formatExecution, withAgent, withModel } from "@/components/harness/execution-draft";
import { buildPolicyPatch, parseSkills, policyDraftFrom } from "@/components/harness/policy-draft";
import {
  createMiniAppHarnessAdminApi,
  createPanelHarnessAdminApi,
  HarnessAdminApiError,
} from "./harness-admin-client";

const POLICY = {
  source: "inferred" as const,
  kind: "web" as const,
  verify: { quick: "pnpm test", full: null, acceptance: null },
  releaseFragment: "optional" as const,
  preferSkills: ["vitest"],
  riskDefault: "T1" as const,
  riskT3: [],
  error: null,
};

function captureFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

async function failure(promise: Promise<unknown>): Promise<HarnessAdminApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HarnessAdminApiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("harness admin client", () => {
  it("sends CSRF-protected maintenance requests from the Mini App", async () => {
    const runtime = {
      version: "0.103.0",
      machineName: "server",
      updating: false,
      canUpdate: true,
      updated: true,
    };
    const execution = {
      effective: { agentConfig: null, model: null, effort: null },
      panel: null,
      agents: [],
    };
    const { calls, fetcher } = captureFetch(() => Response.json({ ok: true, runtime, execution }));
    const api = createMiniAppHarnessAdminApi("bot", "csrf", fetcher);
    await expect(api.updateRuntime()).resolves.toEqual(runtime);
    await expect(api.refreshExecution()).resolves.toEqual(execution);
    expect(calls.map((call) => call.url)).toEqual([
      "/api/mini-app/bot/harness/runtime/update",
      "/api/mini-app/bot/harness/execution/refresh",
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      expect(new Headers(call.init.headers).get("x-mini-app-csrf")).toBe("csrf");
    }
  });
  it("adds the Mini App CSRF header to writes only", async () => {
    const { calls, fetcher } = captureFetch(() =>
      Response.json({ ok: true, project: { key: "koyori" } }),
    );
    const api = createMiniAppHarnessAdminApi("bot/1", "csrf-token", fetcher);

    await api.createProject({ key: "koyori", repo: "example-owner/koyori", machines: ["mbp"] });
    await api.overview().catch(() => undefined);

    const [write, read] = calls;
    expect(write?.url).toBe("/api/mini-app/bot%2F1/harness/projects");
    expect(write?.init.method).toBe("POST");
    expect(write?.init.credentials).toBe("same-origin");
    const writeHeaders = new Headers(write?.init.headers);
    expect(writeHeaders.get("x-mini-app-csrf")).toBe("csrf-token");
    expect(writeHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(write?.init.body))).toEqual({
      key: "koyori",
      repo: "example-owner/koyori",
      machines: ["mbp"],
    });
    expect(read?.url).toBe("/api/mini-app/bot%2F1/harness/overview");
    expect(new Headers(read?.init.headers).has("x-mini-app-csrf")).toBe(false);
  });

  it("uses the panel base path and encodes project keys", async () => {
    const { calls, fetcher } = captureFetch(() => Response.json({ ok: true }));
    const api = createPanelHarnessAdminApi(fetcher);

    await api.deleteProject("a b");

    expect(calls[0]?.url).toBe("/api/harness/admin/projects/a%20b");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("maps contract errors with issues", async () => {
    const { fetcher } = captureFetch(() =>
      Response.json(
        {
          ok: false,
          code: "invalid",
          error: "Invalid project",
          issues: [{ path: "key", message: "taken" }, { path: 3 }],
        },
        { status: 400 },
      ),
    );
    const error = await failure(createPanelHarnessAdminApi(fetcher).preview("a/b"));

    expect(error.code).toBe("invalid");
    expect(error.status).toBe(400);
    expect(error.message).toBe("Invalid project");
    expect(error.issues).toEqual([{ path: "key", message: "taken" }]);
  });

  it("falls back to status-derived codes outside the contract", async () => {
    const notFound = await failure(
      createPanelHarnessAdminApi(
        captureFetch(() => new Response("Not Found", { status: 404 })).fetcher,
      ).overview(),
    );
    const forbidden = await failure(
      createPanelHarnessAdminApi(
        captureFetch(() => Response.json({ ok: false, code: "nope" }, { status: 403 })).fetcher,
      ).overview(),
    );
    const invalid = await failure(
      createPanelHarnessAdminApi(captureFetch(() => Response.json({ ok: true })).fetcher).repos(),
    );
    const offline = await failure(
      createPanelHarnessAdminApi((async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch).overview(),
    );

    expect(notFound.code).toBe("not_found");
    expect(forbidden.code).toBe("forbidden");
    expect(invalid.code).toBe("unavailable");
    expect(offline.code).toBe("unavailable");
    expect(offline.status).toBe(0);
  });

  it("puts execution settings with the CSRF header", async () => {
    const execution = { agentConfig: null, model: null, effort: null };
    const { calls, fetcher } = captureFetch(() =>
      Response.json({ ok: true, execution: { effective: execution, panel: null, agents: null } }),
    );
    await createMiniAppHarnessAdminApi("bot", "csrf", fetcher).updateExecution(execution);

    expect(calls[0]?.url).toBe("/api/mini-app/bot/harness/execution");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(new Headers(calls[0]?.init.headers).get("x-mini-app-csrf")).toBe("csrf");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(execution);
  });

  it("parses the overview envelope", async () => {
    const { fetcher } = captureFetch(() =>
      Response.json({ ok: true, enabled: false, configError: null, projects: [], machines: [] }),
    );
    await expect(createPanelHarnessAdminApi(fetcher).overview()).resolves.toEqual({
      enabled: false,
      configError: null,
      chatId: null,
      projects: [],
      machines: [],
      execution: {
        effective: { agentConfig: null, model: null, effort: null },
        panel: null,
        agents: null,
      },
      warnings: [],
    });
  });
});

describe("policy patch", () => {
  const initial = policyDraftFrom(POLICY);

  it("returns undefined when nothing changed", () => {
    expect(buildPolicyPatch(initial, { ...initial, preferSkills: " vitest , " })).toBeUndefined();
  });

  it("includes only the fields the user changed", () => {
    expect(
      buildPolicyPatch(initial, {
        ...initial,
        kind: "native",
        verifyQuick: "",
        verifyFull: "pnpm build",
      }),
    ).toEqual({
      kind: "native",
      verify: { quick: null, full: "pnpm build" },
    });
  });

  it("layers changes over an existing panel patch without mutating it", () => {
    const existing = {
      verify: { acceptance: "pnpm acceptance" },
      prompts: { preferSkills: ["a"] },
    };
    const patch = buildPolicyPatch(
      initial,
      { ...initial, releaseFragment: "required", preferSkills: "vitest, better-ui" },
      existing,
    );

    expect(patch).toEqual({
      verify: { acceptance: "pnpm acceptance" },
      contract: { releaseFragment: "required" },
      prompts: { preferSkills: ["vitest", "better-ui"] },
    });
    expect(existing.prompts.preferSkills).toEqual(["a"]);
  });

  it("splits skills on commas, Chinese separators, and whitespace", () => {
    expect(parseSkills("vitest，better-ui、 vitest  review")).toEqual([
      "vitest",
      "better-ui",
      "review",
    ]);
  });
});

describe("execution draft", () => {
  const agents = [
    {
      id: "codex-id",
      name: "Codex",
      agentType: "codex",
      models: [
        { id: "sol", name: "gpt-6-sol", efforts: ["low", "high", "xhigh"] },
        { id: "mini", name: "gpt-6-mini", efforts: ["low", "medium"] },
      ],
    },
    { id: "claude-id", name: "Claude", agentType: "claude", models: [] },
  ];
  const effective = { agentConfig: "codex-id", model: "sol", effort: "xhigh" };

  it("resets an effort the new model does not offer, preferring high", () => {
    const agent = agents[0];
    expect(withModel(effective, "mini", agent, effective).effort).toBe("low");
    expect(withModel({ ...effective, effort: "medium" }, "sol", agent, effective).effort).toBe(
      "high",
    );
    expect(withModel(effective, "sol", agent, effective).effort).toBe("xhigh");
    expect(withModel(effective, "custom-id", agent, effective)).toEqual({
      ...effective,
      model: "custom-id",
    });
  });

  it("clears the model when the new agent does not offer it", () => {
    expect(withAgent(effective, "claude-id", agents, effective)).toEqual({
      agentConfig: "claude-id",
      model: null,
      effort: null,
    });
  });

  it("formats a compact label with names when known", () => {
    expect(formatExecution(effective, agents)).toBe("Codex · gpt-6-sol · xhigh");
    expect(formatExecution({ agentConfig: "raw", model: null, effort: "high" }, null)).toBe(
      "raw · high",
    );
    expect(formatExecution({ agentConfig: null, model: null, effort: null }, agents)).toBeNull();
  });
});
