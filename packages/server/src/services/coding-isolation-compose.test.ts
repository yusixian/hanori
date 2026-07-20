import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("coding worker Compose isolation", () => {
  it("mounts only the staging and control volumes on an exclusive network", async () => {
    const compose = await readFile(path.resolve(process.cwd(), "docker-compose.yml"), "utf8");
    const worker = compose.slice(
      compose.indexOf("  coding-worker:"),
      compose.indexOf("  nsfw-api:"),
    );

    expect(worker).not.toContain("codeworkspaces");
    expect(worker).not.toContain("codegit");
    expect(worker).toContain("codingjob:/job");
    expect(worker).toContain("codingcontrol:/coding-control");
    expect(worker).toContain("CODING_WORKER_SOCKET=/coding-control/worker.sock");
    expect(worker).toContain("- coding-egress");
    expect(worker).toContain("restart: always");
    expect(worker).toContain("pids_limit: 128");
  });
});
