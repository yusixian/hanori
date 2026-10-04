import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createModelFetch } from "./model-fetch.js";

describe("model fetch cancellation", () => {
  it.each(["headers", "body"])(
    "keeps caller cancellation active while waiting for %s",
    async (stage) => {
      const server = createServer((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: waiting\n\n");
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const controller = new AbortController();
      const reason = new DOMException("Configured model deadline exceeded", "TimeoutError");
      try {
        const received = once(server, "request");
        const request = createModelFetch()(`http://127.0.0.1:${address.port}`, {
          signal: controller.signal,
        });
        if (stage === "headers") {
          await received;
          const rejection = expect(request).rejects.toBe(reason);
          controller.abort(reason);
          await rejection;
        } else {
          const response = await request;
          const rejection = expect(response.text()).rejects.toBeInstanceOf(Error);
          controller.abort(reason);
          await rejection;
        }
        expect(controller.signal.reason).toBe(reason);
      } finally {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
