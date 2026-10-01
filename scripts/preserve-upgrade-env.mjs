#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

const help = `Usage: node scripts/preserve-upgrade-env.mjs --legacy-ref <full-commit-sha> --input <env-file> --output <new-env-file> [--restore-image-mcp]

Preserve existing encryption settings before an upgrade. Missing or empty keys are
recovered from the explicitly selected local Git commit. No network or database
access. The input is never overwritten; the new output is private (0600).
Verify the old deployment commit and its effective environment before running.
--restore-image-mcp optionally recovers the old image MCP address from that commit.
`;

function fail() {
  throw new Error(
    "Cannot preserve upgrade environment; verify the commit, input syntax, and new output path locally.",
  );
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function historicalLiteral(commit, path, name) {
  const source = git("show", `${commit}:${path}`);
  const declarations = source.match(new RegExp(`\\bconst\\s+${name}\\b`, "g"));
  const match = source.match(
    new RegExp(
      `(?:^|\\n)[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}\\s*=\\s*("(?:[^"\\\\\\r\\n]|\\\\.)*")[ \\t]*;[ \\t]*(?:\\r?\\n|$)`,
    ),
  );
  if (declarations?.length !== 1 || !match) fail();
  const value = JSON.parse(match[1]);
  if (typeof value !== "string" || !value) fail();
  return value;
}

// Locate whole assignments so multiline values cannot masquerade as duplicate keys.
// Reject syntax that this conservative scanner and Node's parser interpret differently.
function assignments(text) {
  const records = [];
  const parsed = Object.create(null);
  let offset = 0;
  while (offset < text.length) {
    let end = text.indexOf("\n", offset);
    if (end === -1) end = text.length;
    const line = text.slice(offset, end);
    if (/^\s*(?:#.*)?$/.test(line)) {
      offset = Math.min(end + 1, text.length);
      continue;
    }
    const start = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(line);
    if (!start) fail();
    const quoteOffset = offset + start[0].length;
    const quote = text[quoteOffset];
    if (quote === "'" || quote === '"' || quote === "`") {
      const close = text.indexOf(quote, quoteOffset + 1);
      if (close === -1) fail();
      end = text.indexOf("\n", close);
      if (end === -1) end = text.length;
      if (!/^[ \t\r]*(?:#.*)?$/.test(text.slice(close + 1, end))) fail();
    }
    const record = text.slice(offset, end);
    const value = parseEnv(record);
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, start[1])) fail();
    records.push({ name: start[1], start: offset, end, value: value[start[1]] });
    Object.assign(parsed, value);
    offset = Math.min(end + 1, text.length);
  }
  const full = parseEnv(text);
  if (
    Object.keys(full).length !== Object.keys(parsed).length ||
    Object.entries(full).some(([key, value]) => parsed[key] !== value)
  )
    fail();
  for (const key of ["ENCRYPTION_KEY", "PIXAI_MCP_URL"]) {
    if (records.filter((record) => record.name === key).length > 1) fail();
  }
  return records;
}

function quoteValue(name, value) {
  // Single quotes also prevent Compose from expanding $ and interpreting #.
  // Node parseEnv cannot round-trip escaped single quotes; refuse rather than rotate a key.
  if (value.includes("'") || value.includes("\0") || value.includes("\r") || value.endsWith("\\"))
    fail();
  const line = `${name}='${value}'`;
  if (parseEnv(line)[name] !== value) fail();
  return line;
}

function replaceValue(text, name, value) {
  const record = assignments(text).find((record) => record.name === name);
  const line = quoteValue(name, value);
  if (record) {
    const ending = text[record.end - 1] === "\r" ? "\r" : "";
    return text.slice(0, record.start) + line + ending + text.slice(record.end);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text + (text.length && !text.endsWith("\n") ? newline : "") + line + newline;
}

function validateOutputParent(output) {
  for (let path = dirname(output); ; path = dirname(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (dirname(path) === path) break;
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      "legacy-ref": { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      "restore-image-mcp": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const ref = values["legacy-ref"];
  if (!ref || !/^[a-f0-9]{40}$/.test(ref) || !values.input || !values.output) fail();
  const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  if (commit !== ref) fail();
  const input = resolve(values.input);
  const output = resolve(values.output);
  if (input === output || !lstatSync(input).isFile() || lstatSync(input).isSymbolicLink()) fail();
  const inputBytes = readFileSync(input);
  const original = inputBytes.toString("utf8");
  if (original.includes("\0") || !Buffer.from(original).equals(inputBytes)) fail();
  const records = assignments(original);
  const key =
    records.find((record) => record.name === "ENCRYPTION_KEY")?.value ||
    historicalLiteral(commit, "packages/server/src/env.ts", "DEFAULT_ENCRYPTION_KEY");
  let contents = replaceValue(original, "ENCRYPTION_KEY", key);
  if (values["restore-image-mcp"]) {
    const existing = records.find((record) => record.name === "PIXAI_MCP_URL")?.value;
    const endpoint =
      existing ||
      historicalLiteral(
        commit,
        "packages/server/src/services/pixai-mcp-client.ts",
        "PIXAI_MCP_PRODUCTION_ENDPOINT",
      );
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail();
    contents = replaceValue(contents, "PIXAI_MCP_URL", endpoint);
  }
  validateOutputParent(output);
  const descriptor = openSync(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, "utf8");
  } catch {
    unlinkSync(output);
    fail();
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write(
    "Created private upgrade environment. Verify it locally before activating; keep the input and database backup.\n",
  );
}

try {
  main();
} catch {
  process.stderr.write(
    "Cannot preserve upgrade environment; verify the commit, input syntax, and new output path locally. No configuration was activated.\n",
  );
  process.exitCode = 1;
}
