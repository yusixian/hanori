import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it } from "vitest";
import type { ImageGenerationService } from "../services/image-generation-service.js";
import type { ImageMcpConnectionService } from "../services/image-mcp-connection-service.js";
import { governanceRoutes } from "./governance.js";

function validUpdate(overrides: unknown[]) {
  return {
    timezone: "UTC",
    generalRouteMode: "off",
    privateChatUserIds: [],
    routes: [
      {
        purpose: "anime_illustration",
        enabled: true,
        label: "Anime",
        useWhen: "anime request",
        avoidWhen: "photo request",
        examples: [],
        allowedPresetKeys: [],
      },
      {
        purpose: "general_image",
        enabled: false,
        label: "General",
        useWhen: "general request",
        avoidWhen: "anime request",
        examples: [],
        allowedPresetKeys: [],
      },
    ],
    limits: [],
    overrides,
  };
}

describe("governance update validation", () => {
  it("returns an actionable error when a positive user ID is submitted as a chat", async () => {
    const app = governanceRoutes(
      {} as Database,
      {} as ImageGenerationService,
      {} as ImageMcpConnectionService,
    );
    const response = await app.request("/test-bot/governance", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        validUpdate([
          {
            resource: "image",
            scope: "chat",
            subjectKey: "3522396394",
            hourly: 5,
            daily: 10,
          },
        ]),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_override_subject",
    });
  });
});
