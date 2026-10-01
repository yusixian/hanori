import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../packages/server/src/utils/crypto.js";

const directories = [];
const legacyKey = "synthetic-legacy-key-for-upgrade-tests";
const legacyEndpoint = "https://mcp.example.com/mcp/pixai";
const failure =
  "Cannot preserve upgrade environment; verify the commit, input syntax, and new output path locally. No configuration was activated.\n";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture({
  source = `const DEFAULT_ENCRYPTION_KEY = ${JSON.stringify(legacyKey)};\n`,
  input = "# Keep this comment\nOTHER='value with $ and # preserved'\n",
} = {}) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "preserve-upgrade-env-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "packages/server/src/services"), { recursive: true });
  const script = join(directory, "scripts/preserve-upgrade-env.mjs");
  copyFileSync(resolve("scripts/preserve-upgrade-env.mjs"), script);
  writeFileSync(join(directory, "packages/server/src/env.ts"), source);
  writeFileSync(
    join(directory, "packages/server/src/services/pixai-mcp-client.ts"),
    `const PIXAI_MCP_PRODUCTION_ENDPOINT =\n  ${JSON.stringify(legacyEndpoint)};\n`,
  );
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet");
  git("add", "packages");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "Synthetic old deployment",
  );
  const ref = git("rev-parse", "HEAD").trim();
  // Recovery must use the selected commit, never current source or ambient env.
  writeFileSync(
    join(directory, "packages/server/src/env.ts"),
    'throw new Error("current tree is not a migration source");\n',
  );
  const inputPath = join(directory, "input.env");
  const outputPath = join(directory, "output.env");
  writeFileSync(inputPath, input, { mode: 0o600 });
  const subprocessEnvironment = { ...process.env };
  delete subprocessEnvironment.FORCE_COLOR;
  const run = (extra = [], overrides = {}) =>
    spawnSync(
      process.execPath,
      [
        script,
        "--legacy-ref",
        overrides.ref ?? ref,
        "--input",
        overrides.input ?? inputPath,
        "--output",
        overrides.output ?? outputPath,
        ...extra,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...subprocessEnvironment, ENCRYPTION_KEY: "synthetic-ambient-key-must-not-be-used" },
      },
    );
  return { directory, input, inputPath, outputPath, run, ref, script };
}

function expectFailure(setup, result) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(failure);
  expect(readFileSync(setup.inputPath, "utf8")).toBe(setup.input);
}

describe("offline upgrade environment preservation", () => {
  it.each(["", "ENCRYPTION_KEY=\n"])(
    "recovers a missing or empty historical key without rotating old ciphertext",
    (keyLine) => {
      const setup = fixture({ input: `OTHER='unchanged'\n${keyLine}` });
      const ciphertext = encrypt("synthetic stored bot token", legacyKey);
      const result = setup.run();
      expect(result.status).toBe(0);
      const output = readFileSync(setup.outputPath, "utf8");
      const key = parseEnv(output).ENCRYPTION_KEY;
      expect(key).toBe(legacyKey);
      expect(decrypt(ciphertext, key)).toBe("synthetic stored bot token");
      expect(output).toContain("OTHER='unchanged'\n");
      expect(readFileSync(setup.inputPath, "utf8")).toBe(setup.input);
      expect(statSync(setup.outputPath).mode & 0o777).toBe(0o600);
      expect(result.stdout + result.stderr).not.toContain(key);
    },
  );

  it.each([
    "synthetic-$cash#hash",
    'synthetic-"double-quote"',
    "synthetic-\\path",
    "  synthetic-spaces  ",
    "synthetic\nmultiline",
  ])("preserves and safely quotes an existing key (%#)", (key) => {
    const before = "# Before\nOTHER='unchanged'\n";
    const after = "# After\nEND=value\n";
    const setup = fixture({ input: `${before}export ENCRYPTION_KEY='${key}'\n${after}` });
    const ciphertext = encrypt("synthetic existing configuration", key);
    expect(setup.run().status).toBe(0);
    const output = readFileSync(setup.outputPath, "utf8");
    expect(output).toBe(`${before}ENCRYPTION_KEY='${key}'\n${after}`);
    expect(decrypt(ciphertext, parseEnv(output).ENCRYPTION_KEY)).toBe(
      "synthetic existing configuration",
    );
    expect(readFileSync(setup.inputPath, "utf8")).toBe(setup.input);
  });

  it("preserves CRLF and ignores assignment-like text inside other multiline values", () => {
    const setup = fixture({
      input:
        "OTHER='line one\r\nENCRYPTION_KEY=inside another value'\r\nENCRYPTION_KEY=synthetic-current\r\nLAST=unchanged\r\n",
    });
    expect(setup.run().status).toBe(0);
    expect(readFileSync(setup.outputPath, "utf8")).toBe(
      setup.input.replace("ENCRYPTION_KEY=synthetic-current", "ENCRYPTION_KEY='synthetic-current'"),
    );
  });

  it("does not restore the optional image service unless explicitly requested", () => {
    const setup = fixture();
    expect(setup.run().status).toBe(0);
    expect(parseEnv(readFileSync(setup.outputPath, "utf8"))).not.toHaveProperty("PIXAI_MCP_URL");
  });

  it.each(["", "PIXAI_MCP_URL=\n", "PIXAI_MCP_URL=https://other.example.com/custom/path\n"])(
    "optionally restores only a missing endpoint (%#)",
    (endpointLine) => {
      const setup = fixture({ input: endpointLine });
      const result = setup.run(["--restore-image-mcp"]);
      expect(result.status).toBe(0);
      const expected = endpointLine.includes("other.example")
        ? "https://other.example.com/custom/path"
        : legacyEndpoint;
      expect(parseEnv(readFileSync(setup.outputPath, "utf8")).PIXAI_MCP_URL).toBe(expected);
      expect(result.stdout + result.stderr).not.toContain(expected);
    },
  );

  it.each([
    "ENCRYPTION_KEY=synthetic-a\nexport ENCRYPTION_KEY=synthetic-b\n",
    "PIXAI_MCP_URL=\nPIXAI_MCP_URL=\n",
    'ENCRYPTION_KEY="synthetic\'quote"\n',
    "ENCRYPTION_KEY='unterminated-synthetic-value\n",
    "ENCRYPTION_KEY='synthetic-value' trailing-text\n",
    "ENCRYPTION_KEY=synthetic\0value\n",
    "ENCRYPTION_KEY=synthetic-trailing-backslash\\\n",
  ])("rejects ambiguous or unsupported input with a fixed safe error (%#)", (input) => {
    const setup = fixture({ input });
    expectFailure(setup, setup.run());
    expect(existsSync(setup.outputPath)).toBe(false);
  });

  it.each([
    "const DEFAULT_ENCRYPTION_KEY = process.env.SECRET;\n",
    'const DEFAULT_ENCRYPTION_KEY = "synthetic" + "computed";\n',
    "const DEFAULT_ENCRYPTION_KEY = `synthetic-template`;\n",
    'const DEFAULT_ENCRYPTION_KEY = "synthetic-one";\nconst DEFAULT_ENCRYPTION_KEY = "synthetic-two";\n',
    'const DEFAULT_ENCRYPTION_KEY = "synthetic\\x21";\n',
  ])("never evaluates unsupported historical source (%#)", (source) => {
    const setup = fixture({ source });
    expectFailure(setup, setup.run());
    expect(existsSync(setup.outputPath)).toBe(false);
  });

  it.each(["0".repeat(40), "HEAD", "--synthetic-secret-value"])(
    "requires an existing full commit ID (%#)",
    (ref) => {
      const setup = fixture();
      expectFailure(setup, setup.run([], { ref }));
      expect(existsSync(setup.outputPath)).toBe(false);
    },
  );

  it("rejects unknown CLI options without echoing their values", () => {
    const setup = fixture();
    expectFailure(setup, setup.run(["--key", "synthetic-secret-option"]));
    expect(existsSync(setup.outputPath)).toBe(false);
  });

  it("never overwrites the input or an existing output", () => {
    const setup = fixture();
    expectFailure(setup, setup.run([], { output: setup.inputPath }));
    writeFileSync(setup.outputPath, "synthetic-existing-output");
    expectFailure(setup, setup.run());
    expect(readFileSync(setup.outputPath, "utf8")).toBe("synthetic-existing-output");
  });

  it("rejects output symlinks and symlink parent directories", () => {
    const setup = fixture();
    symlinkSync(setup.inputPath, setup.outputPath);
    expectFailure(setup, setup.run());
    const linked = join(setup.directory, "linked");
    symlinkSync(setup.directory, linked);
    expectFailure(setup, setup.run([], { output: join(linked, "new.env") }));
    expect(existsSync(join(setup.directory, "new.env"))).toBe(false);
  });
});
