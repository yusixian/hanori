import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Mini App local origin", () => {
  let root;
  let script;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mini-app-origin-"));
    mkdirSync(join(root, "scripts"));
    for (const name of ["basename", "dirname"]) symlinkSync(`/usr/bin/${name}`, join(root, name));
    symlinkSync(process.execPath, join(root, "node"));
    script = join(root, "scripts/dev-mini-app.sh");
    copyFileSync(new URL("./dev-mini-app.sh", import.meta.url), script);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function start(origin) {
    // Limit PATH to Node: a valid origin reaches the Docker check without starting services.
    const env = { PATH: root, HOME: root };
    if (origin !== undefined) env.COS_TOOL_BOT_MINI_APP_ORIGIN = origin;
    return spawnSync("/bin/bash", [script, "start"], { env, encoding: "utf8" });
  }

  it("requires an origin and reports where to save it", () => {
    expect(start().stderr).toContain("请在 .env 中设置");
  });

  it("uses a quoted dotenv value and gives an explicit shell override priority", () => {
    writeFileSync(join(root, ".env"), 'COS_TOOL_BOT_MINI_APP_ORIGIN="https://mini.example.test"\n');
    expect(start().stderr).toContain("没有找到 docker");
    expect(start("https://mini.example.test/path").stderr).toContain("不能包含路径或凭据");
  });
});
