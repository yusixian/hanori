import { describe, expect, it, vi } from "vitest";
import { MemoryHarnessStore } from "./memory-store.js";
import {
  type GitHubWebhookDeps,
  handleGitHubWebhook,
  signGitHubPayload,
  verifyGitHubSignature,
} from "./webhook.js";

const SECRET = "s3cret";

function deps(overrides: { secret?: string; dispatch?: GitHubWebhookDeps["dispatch"] } = {}) {
  return {
    secret: "secret" in overrides ? overrides.secret : SECRET,
    store: new MemoryHarnessStore(),
    projectForRepo: (repo: string) => (repo === "example-owner/sandbox" ? "sandbox" : undefined),
    rememberInstallation: vi.fn(),
    dispatch: vi.fn(overrides.dispatch ?? (async () => {})),
    onDispatchError: vi.fn(),
  };
}

function request(body: string, extra: Record<string, string | undefined> = {}) {
  return {
    event: "pull_request",
    deliveryId: "delivery-1",
    signature: signGitHubPayload(SECRET, body),
    body,
    ...extra,
  };
}

const body = JSON.stringify({
  action: "opened",
  pull_request: { number: 1, head: { sha: "abc" } },
  repository: { full_name: "example-owner/sandbox" },
  installation: { id: 77 },
});

describe("GitHub webhook signature", () => {
  it("accepts only an exact sha256 HMAC", () => {
    expect(verifyGitHubSignature(SECRET, body, signGitHubPayload(SECRET, body))).toBe(true);
    expect(verifyGitHubSignature(SECRET, `${body} `, signGitHubPayload(SECRET, body))).toBe(false);
    expect(verifyGitHubSignature("other", body, signGitHubPayload(SECRET, body))).toBe(false);
    expect(verifyGitHubSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyGitHubSignature(SECRET, body, "sha1=abc")).toBe(false);
  });
});

describe("handleGitHubWebhook", () => {
  it("fails closed without a configured secret", async () => {
    const result = await handleGitHubWebhook(deps({ secret: undefined }), request(body));
    expect(result.status).toBe(503);
  });

  it("rejects a bad signature before parsing", async () => {
    const d = deps();
    const result = await handleGitHubWebhook(d, request(body, { signature: "sha256=00" }));
    expect(result.status).toBe(401);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it("processes a delivery once and acknowledges redeliveries", async () => {
    const d = deps();
    expect((await handleGitHubWebhook(d, request(body))).status).toBe(202);
    const again = await handleGitHubWebhook(d, request(body));
    expect(again).toEqual({ status: 200, body: { ok: true, result: "duplicate" } });
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.rememberInstallation).toHaveBeenCalledWith("example-owner/sandbox", 77);
    expect(d.store.events[0]).toMatchObject({
      type: "github.pull_request",
      deliveryId: "delivery-1",
      payload: { action: "opened", number: 1, sha: "abc" },
    });
  });

  it("ignores repositories that are not configured", async () => {
    const d = deps();
    const other = JSON.stringify({ repository: { full_name: "someone/else" } });
    const result = await handleGitHubWebhook(d, request(other));
    expect(result.body.result).toBe("ignored");
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.store.events).toHaveLength(0);
  });

  it("answers ping and rejects missing headers or invalid JSON", async () => {
    expect((await handleGitHubWebhook(deps(), request(body, { event: "ping" }))).status).toBe(200);
    expect(
      (await handleGitHubWebhook(deps(), request(body, { deliveryId: undefined }))).status,
    ).toBe(400);
    expect((await handleGitHubWebhook(deps(), request("not json"))).status).toBe(400);
  });

  it("releases the delivery id after a failed dispatch so a redelivery is processed", async () => {
    let calls = 0;
    const d = deps({
      dispatch: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
    });
    expect((await handleGitHubWebhook(d, request(body))).status).toBe(202);
    await vi.waitFor(() =>
      expect(d.store.events[0]).toMatchObject({ type: "github.pull_request.failed" }),
    );
    expect(d.store.events[0]!.deliveryId).toBeUndefined();
    expect((await handleGitHubWebhook(d, request(body))).status).toBe(202);
    expect(calls).toBe(2);
    expect((await handleGitHubWebhook(d, request(body))).body.result).toBe("duplicate");
  });

  it("reports dispatch failures without failing the delivery", async () => {
    const error = new Error("boom");
    const d = deps({ dispatch: async () => Promise.reject(error) });
    expect((await handleGitHubWebhook(d, request(body))).status).toBe(202);
    await vi.waitFor(() =>
      expect(d.onDispatchError).toHaveBeenCalledWith(error, "pull_request", "sandbox"),
    );
  });
});
