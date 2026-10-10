import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("./fatal-errors.ts", import.meta.url).href;
const tsxUrl = import.meta.resolve("tsx");
const pinoUrl = import.meta.resolve("pino");

describe("fatal process errors", () => {
  it.each(["uncaughtException", "unhandledRejection"] as const)(
    "redacts %s diagnostics and exits with status 1",
    (event) => {
      const child = spawnSync(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          tsxUrl,
          "--input-type=module",
          "-e",
          `
          import { registerFatalErrorHandlers } from ${JSON.stringify(moduleUrl)};
          import pino from ${JSON.stringify(pinoUrl)};
          registerFatalErrorHandlers(pino({}, pino.destination({ dest: 1, sync: true })));
          const error = Object.assign(new Error('request token=synthetic-token failed', {
            cause: new Error('Authorization: Bearer nested-secret'),
          }), { apiKey: 'synthetic-key', code: 'ECONNRESET' });
          ${event === "uncaughtException" ? "setImmediate(() => { throw error; });" : "Promise.reject(error);"}
        `,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.signal).toBeNull();
      const log = JSON.parse(child.stdout);
      expect(log.msg).toBe(
        event === "uncaughtException"
          ? "Uncaught exception — exiting"
          : "Unhandled rejection — exiting",
      );
      expect(log.level).toBe(60);
      const error = log[event === "uncaughtException" ? "err" : "reason"];
      expect(error).toMatchObject({
        message:
          event === "uncaughtException"
            ? "request token=[REDACTED] failed: Authorization: [REDACTED]"
            : "request token=[REDACTED] failed",
        stack: expect.stringContaining("request token=[REDACTED] failed"),
        apiKey: "[REDACTED]",
        code: "ECONNRESET",
      });
      if (event === "uncaughtException") {
        expect(error.stack).toContain("Authorization: [REDACTED]");
      } else {
        expect(error.cause).toMatchObject({ message: "Authorization: [REDACTED]" });
      }
      for (const secret of ["synthetic-token", "nested-secret", "synthetic-key"]) {
        expect(child.stdout + child.stderr).not.toContain(secret);
      }
    },
  );

  it.each(["uncaughtException", "unhandledRejection"] as const)(
    "still exits with status 1 when the %s logger throws",
    (event) => {
      const child = spawnSync(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          tsxUrl,
          "--input-type=module",
          "-e",
          `
        import { registerFatalErrorHandlers } from ${JSON.stringify(moduleUrl)};
        registerFatalErrorHandlers({ fatal() { throw new Error('synthetic sink secret'); } });
        ${event === "uncaughtException" ? "setImmediate(() => { throw new Error('failure'); });" : "Promise.reject(new Error('failure'));"}
      `,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.signal).toBeNull();
      expect(child.stdout + child.stderr).not.toContain("synthetic sink secret");
    },
  );
});
