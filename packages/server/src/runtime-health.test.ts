import { describe, expect, it } from "vitest";
import { resolveDeploymentVersion, RuntimeHealth } from "./runtime-health.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("resolveDeploymentVersion", () => {
  it("prefers an explicit deployment version", () => {
    expect(
      resolveDeploymentVersion({
        environmentValue: SHA.toUpperCase(),
        readFile: () => {
          throw new Error("should not read the version file");
        },
      }),
    ).toBe(SHA);
  });

  it("reads an embedded commit and fails closed to unknown", () => {
    expect(resolveDeploymentVersion({ readFile: () => `${SHA}\n` })).toBe(SHA);
    expect(resolveDeploymentVersion({ readFile: () => "main" })).toBe("unknown");
    expect(
      resolveDeploymentVersion({
        readFile: () => {
          throw new Error("missing");
        },
      }),
    ).toBe("unknown");
  });
});

describe("RuntimeHealth", () => {
  it("moves from starting to ready and becomes unready before shutdown", () => {
    const health = new RuntimeHealth(SHA);

    expect(health.snapshot()).toEqual({ status: "starting", version: SHA });
    health.markReady();
    expect(health.snapshot()).toEqual({ status: "ready", version: SHA });
    health.markStopping();
    expect(health.snapshot()).toEqual({ status: "stopping", version: SHA });
    health.markReady();
    expect(health.snapshot()).toEqual({ status: "stopping", version: SHA });
  });
});
