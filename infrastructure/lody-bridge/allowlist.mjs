// Strict argv allowlist for the Lody CLI subcommands the harness uses (lody 0.100.0 `--help`).
// Anything not listed here is rejected: no positional prompts, no `--env`, no `--debug`,
// no `--wait`/`--timeout` (the bridge owns time), no `--flag=value` spellings.

const SESSION_ID = /^[\w-]{1,128}$/;
const SELECTOR = /^[\w .:@/+-]{1,200}$/;
const MODEL = /^[\w.:[\]/+-]{1,120}$/;
const CONFIG_OPTION = /^[\w.-]{1,64}=[^\n\r]{0,200}$/;
const TEXT = /^[^\n\r]{1,200}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w./-]{1,200}$/;

/** @type {Record<string, RegExp>} */
const VALUE_RULES = {
  "--workspace": SELECTOR,
  "--machine": SELECTOR,
  "--agent": SELECTOR,
  "--agent-config": SELECTOR,
  "--local-project": SELECTOR,
  "--title": TEXT,
  "--repo": REPO,
  "--branch": BRANCH,
  "--mode": MODEL,
  "--model": MODEL,
  "--config-option": CONFIG_OPTION,
  "--prompt-file": /^-$/,
  "--turn-id": /^[\w:-]{1,160}$/,
};

const REPEATABLE = new Set(["--config-option"]);

/**
 * @typedef {{ path: string[]; session: boolean; values: string[]; flags: string[] }} CommandSpec
 * @type {CommandSpec[]}
 */
const COMMANDS = [
  { path: ["--version"], session: false, values: [], flags: [] },
  {
    path: ["machine", "list"],
    session: false,
    values: ["--workspace"],
    flags: ["--json", "--online-only"],
  },
  {
    path: ["session", "create"],
    session: false,
    values: [
      "--workspace",
      "--machine",
      "--agent",
      "--agent-config",
      "--title",
      "--repo",
      "--local-project",
      "--branch",
      "--mode",
      "--model",
      "--config-option",
      "--prompt-file",
    ],
    flags: ["--worktree", "--json"],
  },
  {
    path: ["session", "chat"],
    session: true,
    values: ["--workspace", "--mode", "--model", "--config-option", "--prompt-file"],
    flags: ["--json"],
  },
  {
    path: ["session", "show"],
    session: true,
    values: ["--workspace"],
    flags: ["--json", "--offline"],
  },
  {
    path: ["session", "status"],
    session: true,
    values: ["--workspace"],
    flags: ["--json", "--offline"],
  },
  {
    path: ["session", "cancel"],
    session: true,
    values: ["--workspace", "--turn-id"],
    flags: ["--json"],
  },
  { path: ["session", "archive"], session: true, values: ["--workspace"], flags: ["--json"] },
];

/**
 * @param {unknown} args
 * @returns {{ ok: true; command: string; readsStdin: boolean } | { ok: false; error: string }}
 */
export function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 64) {
    return { ok: false, error: "args must be a non-empty array" };
  }
  if (!args.every((arg) => typeof arg === "string" && arg.length <= 500 && !arg.includes("\0"))) {
    return { ok: false, error: "args must be short strings" };
  }
  const spec = COMMANDS.find((candidate) =>
    candidate.path.every((segment, index) => args[index] === segment),
  );
  if (!spec) return { ok: false, error: "command not allowed" };
  const rest = args.slice(spec.path.length);
  let index = 0;
  if (spec.session) {
    if (!SESSION_ID.test(rest[0] ?? "")) return { ok: false, error: "session id required" };
    index = 1;
  }
  const seen = new Set();
  let readsStdin = false;
  for (; index < rest.length; index++) {
    const arg = rest[index];
    if (spec.flags.includes(arg)) {
      if (seen.has(arg)) return { ok: false, error: `duplicate ${arg}` };
      seen.add(arg);
      continue;
    }
    if (!spec.values.includes(arg))
      return { ok: false, error: `option not allowed: ${arg.slice(0, 40)}` };
    if (seen.has(arg) && !REPEATABLE.has(arg)) return { ok: false, error: `duplicate ${arg}` };
    seen.add(arg);
    const value = rest[++index];
    if (value === undefined || !VALUE_RULES[arg].test(value) || value.startsWith("--")) {
      return { ok: false, error: `invalid value for ${arg}` };
    }
    if (arg === "--prompt-file") readsStdin = true;
  }
  return { ok: true, command: spec.path.join(" "), readsStdin };
}
