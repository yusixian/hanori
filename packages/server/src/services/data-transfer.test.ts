import type { Database } from "@cos-tool-bot/database";
import type { ExportPayload } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { DataTransferService } from "./data-transfer.js";

describe("DataTransferService credential sanitization", () => {
  it("strips forged GitHub credentials and installation metadata during import", async () => {
    let insertedBot: Record<string, unknown> | undefined;
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({
          values: (value: Record<string, unknown>) => {
            insertedBot = value;
            return {
              returning: async () => [{ id: "new-bot-id" }],
            };
          },
        }),
      };
      await operation(tx);
    });
    const service = new DataTransferService({ transaction } as unknown as Database, "a".repeat(64));
    const payload = {
      manifest: {
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: "bot",
        botId: "old-bot-id",
        botName: "Imported",
        tables: [],
        counts: {},
      },
      bots: [
        {
          id: "old-bot-id",
          name: "Imported",
          aiConfig: {
            enabled: false,
            githubToolsConfig: {
              enabled: true,
              publicReadEnabled: false,
              codingAgentEnabled: true,
              encryptedToken: "forged-encrypted-pat",
              githubAppInstallation: {
                installationId: 123,
                accountLogin: "forged-owner",
                accountType: "Organization",
                repositorySelection: "all",
                repositories: ["private/secret"],
                permissions: { contents: "write" },
                connectedAt: new Date().toISOString(),
              },
              login: "forged-owner",
              authorName: "Ai-chan",
              authorEmail: "ai@example.com",
              repositories: ["private/secret"],
            },
          },
        },
      ],
    } as unknown as ExportPayload;

    await service.importData(payload);

    const aiConfig = insertedBot?.aiConfig as Record<string, unknown>;
    const github = aiConfig.githubToolsConfig as Record<string, unknown>;
    expect(github.encryptedToken).toBeUndefined();
    expect(github.githubAppInstallation).toBeUndefined();
    expect(github).toMatchObject({
      enabled: true,
      login: "forged-owner",
      repositories: ["private/secret"],
    });
  });
});
