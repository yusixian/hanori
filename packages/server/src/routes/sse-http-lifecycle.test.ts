import type { Database } from "@cos-tool-bot/database";
import { getRequestListener } from "@hono/node-server";
import { createServer, get } from "node:http";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import { expect, it, vi } from "vitest";
import type { BotRunService } from "../services/bot-run-service.js";
import { botRunRoutes } from "./bot-runs.js";
import { logRoutes } from "./logs.js";

it.each([
  { route: "run", stage: "headers" },
  { route: "run", stage: "authentication" },
  { route: "logs", stage: "headers" },
  { route: "logs", stage: "authentication" },
] as const)("native $route disconnect during $stage", async ({ route, stage }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const status = vi.fn(async () => {
    if (stage === "headers") {
      entered();
      await gate;
    }
    return stage === "headers" ? "succeeded" : null;
  });
  const events = vi.fn(async () => []);
  const service = {
    getStatus: status,
    eventsAfter: events,
    get: vi.fn(async () => null),
  } as unknown as BotRunService;
  const app = new Hono();
  app.use("*", (c, next) => {
    void c.req.raw.signal;
    return next();
  });
  if (stage === "authentication")
    app.use("*", async (_c, next) => {
      entered();
      await gate;
      await next();
    });
  const logReads = vi.fn(async () => {
    if (stage === "headers") {
      entered();
      await gate;
    }
    return [{ id: 7 }];
  });
  const logQuery = {
    from: () => logQuery,
    where: () => logQuery,
    orderBy: () => logQuery,
    limit: logReads,
  };
  if (route === "run") app.route("/bots", botRunRoutes(service));
  else app.route("/logs", logRoutes({ select: () => logQuery } as unknown as Database));
  const requestPath = route === "run" ? "/bots/bot-1/runs/run-1/stream" : "/logs/stream";
  const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
  let disconnected!: () => void;
  const disconnectedPromise = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  let handled!: () => void;
  const handling = new Promise<void>((resolve) => {
    handled = resolve;
  });
  const adapterErrors: unknown[] = [];
  const server = createServer((req, res) => {
    res.once("close", disconnected);
    void listener(req, res).then(handled, (error) => {
      adapterErrors.push(error);
      handled();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local port");
  const close = vi.spyOn(SSEStreamingApi.prototype, "close");
  let gotHeaders!: () => void;
  const headers = new Promise<void>((resolve) => {
    gotHeaders = resolve;
  });
  const client = get(`http://127.0.0.1:${address.port}${requestPath}`, { agent: false }, (res) => {
    res.on("error", () => {});
    gotHeaders();
  });
  client.on("error", () => {});
  try {
    await pending;
    if (stage === "headers") await headers;
    client.destroy();
    await disconnectedPromise;
    release();
    await handling;
    expect(close).toHaveBeenCalledTimes(stage === "headers" ? 1 : 0);
    expect(events).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(route === "run" && stage === "headers" ? 1 : 0);
    expect(logReads).toHaveBeenCalledTimes(route === "logs" && stage === "headers" ? 1 : 0);
    expect(adapterErrors).toEqual([]);
  } finally {
    client.destroy();
    release();
    await handling;
    close.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
