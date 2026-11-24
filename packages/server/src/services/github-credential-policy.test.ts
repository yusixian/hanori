import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
  assertGitHubCodingModelSelection,
  assertGitHubCredentialUpdateAllowed,
  GitHubCredentialGenerationGate,
} from "./github-credential-policy.js";

describe("GitHub credential policy", () => {
  it.each(["editor", "viewer"])("rejects a new legacy PAT from %s", (role) => {
    expect(() =>
      assertGitHubCredentialUpdateAllowed(role, { login: "hanori" }, { token: "ghp_secret" }),
    ).toThrow(HTTPException);
    try {
      assertGitHubCredentialUpdateAllowed(role, { login: "hanori" }, { token: "ghp_secret" });
    } catch (error) {
      expect((error as HTTPException).status).toBe(403);
    }
  });

  it("rejects replacing the authenticated login but permits omitted unchanged credentials", () => {
    expect(() =>
      assertGitHubCredentialUpdateAllowed(
        "editor",
        { login: "installed-account" },
        { login: "other-account" },
      ),
    ).toThrow(HTTPException);
    expect(() =>
      assertGitHubCredentialUpdateAllowed("editor", { login: "installed-account" }, {}),
    ).not.toThrow();
    expect(() =>
      assertGitHubCredentialUpdateAllowed(
        "editor",
        { login: "installed-account" },
        { login: "installed-account", token: "" },
      ),
    ).not.toThrow();
  });

  it.each(["owner", "admin"])("allows %s to migrate or replace legacy credentials", (role) => {
    expect(() =>
      assertGitHubCredentialUpdateAllowed(
        role,
        { login: "old-account" },
        { login: "new-account", token: "ghp_new" },
      ),
    ).not.toThrow();
  });
});

describe("GitHub coding model policy", () => {
  const providers = [
    {
      id: "coding-provider",
      encryptedApiKey: "encrypted-key",
      defaultModel: "default-model",
      models: [{ id: "coding-model" }],
    },
  ];

  it("accepts fallback mode and a model belonging to the selected provider", () => {
    expect(() => assertGitHubCodingModelSelection(providers)).not.toThrow();
    expect(() =>
      assertGitHubCodingModelSelection(providers, "coding-provider", "coding-model"),
    ).not.toThrow();
    expect(() => assertGitHubCodingModelSelection(providers, "coding-provider")).not.toThrow();
  });

  it("rejects missing providers and models outside the selected provider", () => {
    for (const selection of [
      [undefined, "coding-model"],
      ["missing-provider", "coding-model"],
      ["coding-provider", "missing-model"],
    ] as const) {
      try {
        assertGitHubCodingModelSelection(providers, selection[0], selection[1]);
        throw new Error("expected selection to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPException);
        expect((error as HTTPException).status).toBe(400);
      }
    }
  });

  it("rejects a dedicated provider without a persisted or same-save API key", () => {
    try {
      assertGitHubCodingModelSelection(
        [{ id: "no-key", encryptedApiKey: null, defaultModel: "coding-model" }],
        "no-key",
      );
      throw new Error("expected selection to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(400);
      expect((error as HTTPException).message).toContain("API Key");
    }
  });
});

describe("GitHubCredentialGenerationGate", () => {
  it("revokes captured PAT and App providers without affecting another bot", async () => {
    const gate = new GitHubCredentialGenerationGate();
    const firstBot = gate.capture("bot-a", async () => "pat-or-installation-token");
    const secondBot = gate.capture("bot-b", async () => "other-token");

    await expect(firstBot()).resolves.toBe("pat-or-installation-token");
    gate.invalidate("bot-a");

    await expect(firstBot()).rejects.toThrow(/credentials changed/);
    await expect(secondBot()).resolves.toBe("other-token");
  });

  it("rejects a credential that resolves after invalidation", async () => {
    const gate = new GitHubCredentialGenerationGate();
    let release!: (token: string) => void;
    const provider = gate.capture(
      "bot-a",
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const pending = provider();

    gate.invalidate("bot-a");
    release("stale-installation-token");

    await expect(pending).rejects.toThrow(/credentials changed/);
  });
});
