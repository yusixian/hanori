import { createServer } from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { configureWorkerProxy } from "./network-proxy.js";

describe("coding worker network proxy", () => {
  it("routes Node global fetch through the configured environment proxy", async () => {
    const previous = getGlobalDispatcher();
    let requestTarget: string | undefined;
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      requestTarget = request.url;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied");
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy test server did not bind");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const agent = configureWorkerProxy({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      CODING_REQUIRE_PROXY: "1",
    });
    try {
      const response = await fetch("http://public.example.test/resource?q=1");
      expect(await response.text()).toBe("proxied");
      expect(requestTarget).toBe("public.example.test:80");
    } finally {
      setGlobalDispatcher(previous);
      await agent?.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed when the production proxy is required but incomplete", () => {
    expect(() => configureWorkerProxy({ CODING_REQUIRE_PROXY: "1" })).toThrow("proxy is required");
    expect(() => configureWorkerProxy({ HTTP_PROXY: "http://proxy:3128" })).toThrow(
      "Both HTTP_PROXY and HTTPS_PROXY",
    );
  });
});
