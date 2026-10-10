import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { fetchRssFeed } from "./rss-feed-fetch.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

it.each(["timeout", "error", "redirect", "success"])(
  "releases native HTTP resources after %s without changing feed results",
  async (route) => {
    const responses: { path: string; closed: boolean }[] = [];
    server = createServer((req, res) => {
      const record = { path: req.url!, closed: false };
      responses.push(record);
      res.on("close", () => {
        record.closed = true;
      });
      if (req.url === "/success") {
        res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
        res.end(
          '<rss version="2.0"><channel><title>测试订阅</title><link>https://example.com</link><description>Fixture</description><item><title>Article</title><guid>1</guid></item></channel></rss>',
        );
        return;
      }
      if (req.url === "/redirect") res.writeHead(302, { Location: "/success" });
      else res.writeHead(req.url === "/error" ? 500 : 200);
      res.flushHeaders();
      res.write("unfinished body");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const fetched = fetchRssFeed(
      `http://127.0.0.1:${address.port}/${route}`,
      route === "timeout" ? 150 : 2000,
    );
    if (route === "timeout") await expect(fetched).rejects.toThrow("Request timed out after 150ms");
    else if (route === "error") await expect(fetched).rejects.toThrow("Status code 500");
    else
      await expect(fetched).resolves.toMatchObject({
        title: "测试订阅",
        items: [{ title: "Article", guid: "1" }],
      });
    await expect.poll(() => responses.every((response) => response.closed)).toBe(true);
    expect(responses.map((response) => response.path)).toEqual(
      route === "redirect" ? ["/redirect", "/success"] : [`/${route}`],
    );
  },
);
