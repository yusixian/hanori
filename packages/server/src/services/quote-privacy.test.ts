import { QuoteService } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import type { UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { UserPrivacyService } from "./user-privacy-service.js";

describe("quote service inside an active AI privacy lock", () => {
  it.each(["success", "cancel", "busy"] as const)(
    "reuses actor locks and avoids waiting on busy authors: %s",
    async (scenario) => {
      const cancel = scenario === "cancel";
      const privacyService = new UserPrivacyService({} as Database);
      const privacy: UserPrivacyCallbacks = {
        getMode: vi.fn(async () => "normal" as const),
        runExclusive: (id, operation) => privacyService.runExclusive("bot", id, operation),
        runExclusiveMany: (ids, operation, options) =>
          privacyService.runLibraryExclusiveMany("bot", ids, operation, options),
        setMode: vi.fn(),
        forget: vi.fn(),
      };
      const signal = new AbortController();
      const api = {
        getChat: vi.fn(async () => ({})),
        sendChatAction: vi.fn(async () => true),
        sendSticker: vi.fn(async () => ({ message_id: 5 })),
      };
      const quote = new QuoteService(
        {
          store: {
            getQuoteSources: vi.fn(async () => []),
            getQuoteColor: vi.fn(),
            setQuoteColor: vi.fn(),
            isQuoteOutput: vi.fn(async () => false),
            markQuoteOutput: vi.fn(),
          },
          renderer: {
            available: vi.fn(async () => true),
            render: vi.fn(async () => {
              if (cancel) signal.abort();
              return { data: new Uint8Array(), format: "webp" as const, width: 1, height: 1 };
            }),
          },
        },
        { api: api as never, deliveryApi: api as never, privacy },
      );
      let releaseAuthor!: () => void;
      let authorReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        authorReady = resolve;
      });
      const owner =
        scenario === "busy"
          ? privacyService.runExclusive("bot", 43, () => {
              authorReady();
              return new Promise<void>((resolve) => {
                releaseAuthor = resolve;
              });
            })
          : undefined;
      if (owner) await ready;
      const operation = privacy.runExclusive(42, () =>
        quote.send({
          chatId: 10,
          threadId: null,
          userId: 42,
          messageIds: [1],
          snapshotOnly: true,
          liveSources: [
            {
              version: 1,
              messageId: 1,
              threadId: null,
              capturedAt: Date.now(),
              text: "Real text",
              entities: [],
              author: { key: "hidden", name: "Alice" },
              privacyUserIds: [43, 42],
            },
          ],
          signal: signal.signal,
        }),
      );
      try {
        if (scenario === "busy") {
          await expect(operation).rejects.toThrow("尚未发送语录");
          expect(quote.deps.renderer.render).not.toHaveBeenCalled();
        } else if (cancel) await expect(operation).rejects.toThrow();
        else await expect(operation).resolves.toMatchObject({ messageId: 5 });
        expect(api.sendSticker).toHaveBeenCalledTimes(scenario === "success" ? 1 : 0);
      } finally {
        releaseAuthor?.();
        await owner;
      }
      await expect(privacyService.runExclusive("bot", 43, async () => "released")).resolves.toBe(
        "released",
      );
    },
    1000,
  );
});
